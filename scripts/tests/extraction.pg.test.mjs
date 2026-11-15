// Post-session extraction races on a real Postgres (scripts/db/extraction.ts):
// many claims of one ended conversation's recap at once (two tabs' End, End
// racing the idle end, a Retry), and a recap's write beside gloss captures
// of the same phrases in other conversations of the language. One claim
// wins, every write lands (no deadlock left unretried, no lost capture),
// and the bank ends up with one row per phrase and one session review per
// card. PGlite runs one transaction at a time, so these run only when
// LINGO_TEST_PG_URL names a Postgres; skipped otherwise. A throwaway
// database per test (pg-scratch.mjs), dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/extraction.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createLearner, createUser } from "../db/accounts.ts";
import { applyExtraction, claimExtraction } from "../db/extraction.ts";
import { recordGlosses } from "../db/phrases.ts";
import { normKey } from "../match.mjs";
import { ADULT } from "./http-session.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const ROUNDS = 15;

async function withProfile(t, fn) {
  const scratch = await scratchDatabase(url, "extract");
  const pool = new pg.Pool({ connectionString: scratch.url, max: 10 });
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

/** A conversation of the profile with one master and one learner turn;
 *  ended unless `open`. Returns its id and the master turn's. */
async function conversation(pool, profile, { open = false } = {}) {
  const id = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await pool.query(
    `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language, target_variant, ended_at)
     values ($1, $2, $3, '{}', 'Race', 'adult', 'Spanish', 'Mexican Spanish', ${open ? "null" : "now()"})`,
    [id, profile.learnerId, profile.id],
  );
  await pool.query(
    `insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, lines) values ($1, $2, $3, $4, 0, 'master', $5)`,
    [turnId, id, profile.learnerId, profile.id, JSON.stringify([{ speaker: "character", gender: null, text: "¿A cómo el kilo de mango?", segments: [] }])],
  );
  await pool.query(`insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, 1, 'learner', 'A veinte.')`, [
    id, profile.learnerId, profile.id,
  ]);
  return { id, turnId };
}

const item = (text, meaning) => ({ text, norm: normKey(text), meaning, meaningNorm: normKey(meaning), example: null });

test("many claims of one ended conversation's recap at once: exactly one wins, every round", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const c = await conversation(pool, profile);
      // One server: every claim's token is live while it is being made
      // (web/server/extraction.ts adds it first), so no claimer takes the
      // winner's row for an orphan. Half are End's claim (from 'none'),
      // half a Retry's. The losers' UPDATEs wait on the winner's row lock
      // and then find it no longer matches.
      const tokens = Array.from({ length: 8 }, () => crypto.randomUUID());
      const got = await Promise.all(tokens.map((claim, i) => claimExtraction(db, profile, c.id, { from: i % 2 ? ["none"] : ["none", "failed", "done"], live: tokens, claim })));
      assert.equal(got.filter(Boolean).length, 1, `round ${round}`);
      const [row] = (await pool.query("select extraction_status, extraction_claim from conversations where id = $1", [c.id])).rows;
      assert.deepEqual(row, { extraction_status: "running", extraction_claim: got.find(Boolean).claim });
    }
  });
});

test("a recap's write beside gloss captures of the same phrases in other conversations: all land, one row per phrase, one session review per card", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const words = [`mango ${round}`, `kilo ${round}`, `vuelta ${round}`];
        const c = await conversation(pool, profile);
        const { claim } = await claimExtraction(db, profile, c.id, { from: ["none"], live: [] });
        const value = {
          summary: "ok",
          keep: words.map((w) => ({ text: w, meaning: `m ${w}`, example: "", why: "" })),
          events: words.map((w, i) => ({ phrase: w, kind: i % 2 ? "understood" : "produced" })),
          corrections: [],
        };
        const captures = [words, [...words].reverse()].map(async (ws) => {
          const other = await conversation(pool, profile, { open: true });
          return db.transaction((tx) => recordGlosses(tx, profile, { lang: "es-MX", conversationId: other.id, turnId: other.turnId, items: ws.map((w) => item(w, `m ${w}`)).sort((a, b) => (a.norm < b.norm ? -1 : 1)) }));
        });
        const [recap, ...seen] = await Promise.all([
          applyExtraction(db, profile, { conversationId: c.id, claim, value, dropped: 0, bankLocale: "es-MX", turns: [] }),
          ...captures,
        ]);
        assert.ok(recap, `round ${round}: the recap was written`);
        assert.deepEqual(seen, [3, 3], `round ${round}: both captures landed`);
        const rows = (await pool.query("select norm, seen_count from phrases where norm = any($1) order by norm", [words])).rows;
        assert.deepEqual(rows.map((r) => [r.norm, r.seen_count]), [...words].sort().map((w) => [w, 3]), `round ${round}: one row each, seen by both captures and the recap`);
        const [{ n }] = (await pool.query("select count(*)::int as n from reviews where conversation_id = $1 and mode = 'session'", [c.id])).rows;
        assert.equal(n, 3);
      }
      assert.deepEqual(errors, []);
    } finally {
      console.error = orig;
    }
  });
});
