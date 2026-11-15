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
  LanguageTakenError, archiveLanguageProfile, createLanguageProfile, createLearner, createUser, updateLanguageProfile,
} from "../db/accounts.ts";
import { ADULT } from "./http-session.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const ROUNDS = 20;

/** A migrated throwaway database on the URL's server with one user and one
 *  learner (Spanish), for `fn`; dropped after. The pool has room for every
 *  racer to hold its own connection. */
async function withLearner(fn) {
  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 8 });
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    const db = drizzle(pool, { schema });
    const user = await createUser(db, { username: "racer", passwordHash: "x" });
    const learner = await createLearner(db, user.id, ADULT);
    await fn(pool, db, { userId: user.id, learnerId: learner.id });
  } finally {
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
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
