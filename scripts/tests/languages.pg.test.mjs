// Language profile races on a real Postgres (scripts/db/accounts.ts). A
// learner has at most one live profile per target language, a rule with no
// unique index behind it: the learner's row lock (lockLearner) serialises
// the check and the write. PGlite runs one transaction at a time and can't
// show a race, so these run only when LINGO_TEST_PG_URL names a Postgres to
// connect to; skipped otherwise. Like packs.pg.test.mjs, each test makes a
// throwaway database on that server, migrates it, races there, and drops it.
//
//   - Naming a blank profile (PATCH) against adding that language (POST):
//     exactly one wins, the other is LanguageTakenError.
//   - Naming two blank profiles the same language at once: the same.
//   - Either against an archive of another of the learner's languages: no
//     deadlock (the one lock order: learner, then profiles).
//   - A session switch to a language (from the same learner or another)
//     against an archive of that language: no deadlock, and the session
//     never ends on an archived profile (learner, profiles, then sessions).
//   - A session switching away from a language while another tab archives
//     that language: the archive (holding every live profile) waits on the
//     session row the switch holds, and the old switch then waited on a
//     profile: the deadlock. Now no deadlock, and the session ends live.
//
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/languages.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import {
  LanguageTakenError, archiveLanguageProfile, createLanguageProfile, createLearner, createSession, createUser, setSessionLearner, updateLanguageProfile,
} from "../db/accounts.ts";
import { ADULT } from "./http-session.mjs";
import { createDatabase, dropDatabase, scratchName } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const ROUNDS = 20;

/** A migrated throwaway database on the URL's server with one user and one
 *  learner (Spanish), for `fn`; dropped after. The pool has room for every
 *  racer to hold its own connection. */
async function withLearner(fn) {
  const name = scratchName("lang");
  const target = new URL(await createDatabase(url, name));
  const pool = new pg.Pool({ connectionString: target.toString(), max: 8 });
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    const db = drizzle(pool, { schema });
    const user = await createUser(db, { username: "racer", passwordHash: "x" });
    const learner = await createLearner(db, user.id, ADULT);
    await fn(pool, db, { userId: user.id, learnerId: learner.id });
  } finally {
    await pool.end();
    // After every pool and client on it has ended (pg-scratch.mjs).
    await dropDatabase(url, name);
  }
}

/** The settled results: how many fulfilled, and every rejection a
 *  LanguageTakenError (anything else fails the test). */
function outcome(results) {
  for (const r of results) if (r.status === "rejected" && !(r.reason instanceof LanguageTakenError)) throw r.reason;
  return { won: results.filter((r) => r.status === "fulfilled").length, taken: results.filter((r) => r.status === "rejected").length };
}

const liveIn = async (pool, learnerId, language) =>
  (await pool.query("select id from language_profiles where learner_id = $1 and archived_at is null and lower(trim(target_language)) = lower($2)", [learnerId, language])).rows;

test("naming a blank profile and adding that language at once, repeated: exactly one wins", { skip }, async () => {
  await withLearner(async (pool, db, { learnerId }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const language = `Lang${round}`;
      const blank = await createLanguageProfile(db, learnerId, {});
      const results = await Promise.allSettled([
        updateLanguageProfile(db, learnerId, blank.id, { targetLanguage: language }),
        createLanguageProfile(db, learnerId, { targetLanguage: language.toLowerCase(), level: "A1" }),
      ]);
      assert.deepEqual(outcome(results), { won: 1, taken: 1 }, `round ${round}`);
      assert.equal((await liveIn(pool, learnerId, language)).length, 1, `round ${round}: one live ${language}`);
    }
  });
});

test("naming two blank profiles the same language at once, repeated: exactly one wins", { skip }, async () => {
  await withLearner(async (pool, db, { learnerId }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const language = `Lang${round}`;
      const a = await createLanguageProfile(db, learnerId, {});
      const b = await createLanguageProfile(db, learnerId, {});
      const results = await Promise.allSettled([
        updateLanguageProfile(db, learnerId, a.id, { targetLanguage: language }),
        updateLanguageProfile(db, learnerId, b.id, { targetLanguage: ` ${language.toUpperCase()} ` }),
      ]);
      assert.deepEqual(outcome(results), { won: 1, taken: 1 }, `round ${round}`);
      assert.equal((await liveIn(pool, learnerId, language)).length, 1, `round ${round}: one live ${language}`);
    }
  });
});

test("namings, adds and archives of one learner at once: no deadlock, still one per language", { skip }, async () => {
  await withLearner(async (pool, db, { userId, learnerId }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const language = `Lang${round}`;
      const doomed = await createLanguageProfile(db, learnerId, { targetLanguage: `Doomed${round}` });
      const a = await createLanguageProfile(db, learnerId, {});
      const b = await createLanguageProfile(db, learnerId, {});
      // A deadlock would reject one of these with SQLSTATE 40P01, which
      // outcome() rethrows.
      const results = await Promise.allSettled([
        updateLanguageProfile(db, learnerId, a.id, { targetLanguage: language }),
        archiveLanguageProfile(db, userId, learnerId, doomed.id),
        updateLanguageProfile(db, learnerId, b.id, { targetLanguage: language }),
        createLanguageProfile(db, learnerId, { targetLanguage: language }),
      ]);
      const { won, taken } = outcome(results);
      assert.equal(won, 2, `round ${round}: the archive and one of the three`);
      assert.equal(taken, 2, `round ${round}`);
      assert.equal((await liveIn(pool, learnerId, language)).length, 1, `round ${round}: one live ${language}`);
    }
  });
});

test("a session switch to a language and an archive of it at once, repeated: no deadlock, never left on an archived profile", { skip }, async () => {
  await withLearner(async (pool, db, { userId, learnerId }) => {
    // A second learner, so half the rounds switch learner as well as language.
    const other = await createLearner(db, userId, { ...ADULT, name: "Ash" });
    const sessionId = crypto.randomBytes(16).toString("hex");
    await createSession(db, userId, sessionId, new Date(Date.now() + 3_600_000));
    const home = (await pool.query("select id from language_profiles where learner_id = $1", [learnerId])).rows[0].id;
    let refusedOnce = false;
    for (let round = 0; round < 60; round++) {
      // Start on the learner's first language, or on the other learner.
      const fromOther = round % 2 === 1;
      const start = fromOther ? await setSessionLearner(db, userId, sessionId, other.id) : await setSessionLearner(db, userId, sessionId, learnerId, home);
      assert.ok(!start || !("refused" in start), `round ${round}: the start switch`);
      const target = await createLanguageProfile(db, learnerId, { targetLanguage: `Lang${round}`, level: "A1" });
      // Archive first on odd rounds, switch first on even ones; the pool
      // gives each its own connection, so they overlap either way.
      const ops = [
        () => setSessionLearner(db, userId, sessionId, learnerId, target.id),
        () => archiveLanguageProfile(db, userId, learnerId, target.id),
      ];
      if (round % 4 >= 2) ops.reverse();
      const results = await Promise.allSettled(ops.map((op) => op()));
      for (const r of results) if (r.status === "rejected") throw r.reason; // 40P01 is a deadlock
      const switched = results.find((r) => r.value && ("learner" in r.value || "refused" in r.value))?.value;
      if (switched && "refused" in switched) {
        assert.equal(switched.refused, "language", `round ${round}`);
        refusedOnce = true;
      }
      const archived = results.find((r) => r.value && ("profile" in r.value))?.value;
      assert.ok(archived, `round ${round}: the archive happened`);
      const { rows } = await pool.query(
        `select s.learner_id, s.language_profile_id, lp.archived_at, lp.learner_id as lp_learner
           from auth_sessions s left join language_profiles lp on lp.id = s.language_profile_id where s.id = $1`,
        [sessionId],
      );
      assert.ok(rows[0].language_profile_id, `round ${round}: the session has a language`);
      assert.equal(rows[0].archived_at, null, `round ${round}: the session is on a live profile`);
      assert.equal(rows[0].lp_learner, rows[0].learner_id, `round ${round}: of its own learner`);
    }
    // Not required for correctness, but shows the race was really run both ways.
    if (!refusedOnce) console.log("note: no round had the archive win before the switch");
  });
});

test("a session switching away from a language while it is archived, repeated: no deadlock, the session ends on a live profile", { skip }, async () => {
  await withLearner(async (pool, db, { userId, learnerId }) => {
    const sessionId = crypto.randomBytes(16).toString("hex");
    await createSession(db, userId, sessionId, new Date(Date.now() + 3_600_000));
    for (let round = 0; round < 60; round++) {
      const leaving = await createLanguageProfile(db, learnerId, { targetLanguage: `From${round}`, level: "A1" });
      const going = await createLanguageProfile(db, learnerId, { targetLanguage: `To${round}`, level: "A1" });
      await setSessionLearner(db, userId, sessionId, learnerId, leaving.id);
      const ops = [
        () => setSessionLearner(db, userId, sessionId, learnerId, going.id),
        () => archiveLanguageProfile(db, userId, learnerId, leaving.id),
      ];
      if (round % 2) ops.reverse();
      const results = await Promise.allSettled(ops.map((op) => op()));
      for (const r of results) if (r.status === "rejected") throw r.reason; // 40P01 is a deadlock
      const { rows } = await pool.query(
        "select s.language_profile_id, lp.archived_at from auth_sessions s join language_profiles lp on lp.id = s.language_profile_id where s.id = $1",
        [sessionId],
      );
      assert.equal(rows[0].archived_at, null, `round ${round}: the session is on a live profile`);
      // Whichever ran first, the switch was to a live language and wins.
      assert.equal(rows[0].language_profile_id, going.id, `round ${round}: on the language it switched to`);
      await archiveLanguageProfile(db, userId, learnerId, going.id); // keep the learner's list short
    }
  });
});
