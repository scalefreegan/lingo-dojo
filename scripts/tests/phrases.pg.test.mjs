// Phrase bank races on a real Postgres (scripts/db/phrases.ts): two
// conversations of one language capturing the same words at once, an add
// of them meanwhile, and captures whose words and meanings cross. Each must
// land (no lost capture, no 409 from the add, no deadlock) and leave one
// phrase per words with the pending scene phrase absorbed. PGlite runs one
// transaction at a time and can't show a race, so these run only when
// LINGO_TEST_PG_URL names a Postgres; skipped otherwise. A throwaway database
// per test (pg-scratch.mjs), dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/phrases.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createLearner, createUser } from "../db/accounts.ts";
import { addPhrase, addScenarioPhrases, recordGlosses } from "../db/phrases.ts";
import { normKey } from "../match.mjs";
import { ADULT } from "./http-session.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const ROUNDS = 20;

/** A migrated throwaway database with one learner's Spanish profile, a pool
 *  with a connection for every racer, and `fn` run on them. */
async function withProfile(t, fn) {
  const scratch = await scratchDatabase(url, "phrases");
  const pool = new pg.Pool({ connectionString: scratch.url, max: 8 });
  // The pool closed before the database goes: a drop WITH (FORCE) would
  // terminate its idle connections under it.
  t.after(async () => {
    await pool.end();
    await scratch.drop();
  });
  await applyMigrations(scratch.query);
  const db = drizzle(pool, { schema });
  const user = await createUser(db, { username: "racer", passwordHash: "x" });
  const learner = await createLearner(db, user.id, ADULT);
  const [{ id }] = (await pool.query("select id from language_profiles where learner_id = $1", [learner.id])).rows;
  await fn(pool, db, { id, learnerId: learner.id });
}

const item = (text, meaning) => ({ text, norm: normKey(text), meaning, meaningNorm: normKey(meaning), example: null });

/** A turn's capture on its own transaction, as saveTurn runs it, for a
 *  reply stored in a conversation of its own (the sightings name both);
 *  null when it was lost. */
async function capture(db, profile, items) {
  const conversationId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await db.$client.query(
    `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language) values ($1, $2, $3, '{}', 'Race', 'adult', 'Spanish')`,
    [conversationId, profile.learnerId, profile.id],
  );
  await db.$client.query(
    `insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, $4, 0, 'master', '')`,
    [turnId, conversationId, profile.learnerId, profile.id],
  );
  return db.transaction((tx) => recordGlosses(tx, profile, { lang: "es-MX", conversationId, turnId, items }));
}

test("three captures and an add of the same words, with a pending scene phrase for their meaning, at once: all land, one phrase", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const words = `mercado ${round}`;
        const meaning = `market ${round}`;
        await addScenarioPhrases(db, profile, { lang: "es-MX", complete: [], pending: [{ meaning, meaningNorm: normKey(meaning) }] });
        await pool.query("update phrases set starred = true where meaning_norm = $1", [normKey(meaning)]);
        // The third capture glosses the words with another meaning: it
        // inserts them while the others give the pending row its words.
        const [a, b, c, added] = await Promise.all([
          capture(db, profile, [item(words, meaning)]),
          capture(db, profile, [item(words, meaning)]),
          capture(db, profile, [item(words, `other ${round}`)]),
          addPhrase(db, profile, "es-MX", { text: words, meaning, starred: false }),
        ]);
        assert.deepEqual([a, b, c], [1, 1, 1], `round ${round}: no capture lost`);
        assert.equal(added.phrase.text, words);
        const rows = (await pool.query("select text, seen_count, starred from phrases where norm = $1 or meaning_norm = $2", [normKey(words), normKey(meaning)])).rows;
        assert.deepEqual(rows, [{ text: words, seen_count: 3, starred: true }], `round ${round}: one phrase, seen three times, the pending one's star carried`);
      }
    } finally {
      console.error = orig;
    }
    assert.deepEqual(errors, []);
  });
});

test("captures whose words and pending meanings cross, at once: no deadlock, nothing lost", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const m1 = `one ${round}`;
      const m2 = `two ${round}`;
      await addScenarioPhrases(db, profile, {
        lang: "es-MX",
        complete: [],
        pending: [m1, m2].map((m) => ({ meaning: m, meaningNorm: normKey(m) })),
      });
      // Words in norm order, meanings crossed: a takes x (m2) then y (m1),
      // b takes w (m1) then z (m2).
      const [a, b] = await Promise.all([
        capture(db, profile, [item(`x${round}`, m2), item(`y${round}`, m1)]),
        capture(db, profile, [item(`w${round}`, m1), item(`z${round}`, m2)]),
      ]);
      assert.deepEqual([a, b], [2, 2], `round ${round}`);
      const pending = (await pool.query("select count(*)::int as n from phrases where text is null and meaning_norm in ($1, $2)", [normKey(m1), normKey(m2)])).rows[0].n;
      assert.equal(pending, 0, `round ${round}: both pending phrases absorbed`);
      const complete = (await pool.query("select count(*)::int as n from phrases where norm = any($1)", [[`w${round}`, `x${round}`, `y${round}`, `z${round}`]])).rows[0].n;
      assert.equal(complete, 4);
    }
  });
});
