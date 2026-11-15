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
import { lockTurnWrite, recordGlosses, unrecordGlosses } from "../db/phrases.ts";
import { sql } from "drizzle-orm";
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

/** Wait (bounded) until some other connection of this database is waiting
 *  on a lock: the interleaving a test holds is then in place. */
async function blocked(pool, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [{ n }] = (await pool.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const sorted = (items) => items.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));

test("a turn write that drops a reply and captures the next, beside a recap keeping the same words: no deadlock, both land", { skip }, async (t) => {
  // The interleaving that closed the cycle, held on purpose each round: the
  // turn has undone the dropped reply (its phrases locked) and not yet
  // captured; the recap then takes its phrases in norm order. With the
  // turn's two passes one after the other, the recap held the new word and
  // waited on an undone one while the turn's capture waited on the new
  // word: a deadlock, the turn the victim, its capture lost. In one pass
  // (lockTurnWrite) the turn holds the new word already and the recap waits.
  await withProfile(t, async (pool, db, profile) => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.map((x) => String(x?.cause?.code ?? x)).join(" "));
    try {
      for (let round = 0; round < 5; round++) {
        const W = Array.from({ length: 6 }, (_, i) => `palabra ${String.fromCharCode(97 + i)} ${round}`);
        const nueva = `nueva ${round}`;
        const B = await conversation(pool, profile, { open: true });
        const next = crypto.randomUUID();
        await pool.query(`insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, lines) values ($1, $2, $3, $4, 2, 'master', '[]')`, [
          next, B.id, profile.learnerId, profile.id,
        ]);
        await db.transaction((tx) => recordGlosses(tx, profile, { lang: "es-MX", conversationId: B.id, turnId: B.turnId, items: sorted(W.slice(0, 4).map((w) => item(w, `m ${w}`))) }));
        const C = await conversation(pool, profile);
        const { claim } = await claimExtraction(db, profile, C.id, { from: ["none"], live: [] });
        const kept = [nueva, ...W.slice(2)];
        let recap;
        // saveTurn's bank steps, in its order (web/server/conversations.ts).
        const turn = db.transaction(async (tx) => {
          // The turn checks for a deadlock first, so it is the victim, as in
          // the capture loss seen in the wild (a recap victim is retried
          // whole, silently, and would hide the cycle). Superuser setting:
          // the scratch server's owner runs these tests.
          await tx.execute(sql`set local deadlock_timeout = '50ms'`);
          await tx.execute(sql`select 1 from conversations where id = ${B.id} for update`);
          const items = sorted([nueva, W[4]].map((w) => item(w, `m ${w}`)));
          await lockTurnWrite(tx, profile, { turnIds: [B.turnId], lang: "es-MX", items });
          await unrecordGlosses(tx, profile, { turnIds: [B.turnId] });
          recap = applyExtraction(db, profile, {
            conversationId: C.id,
            claim,
            value: { summary: "", keep: kept.map((w) => ({ text: w, meaning: `m ${w}`, example: "", why: "" })), events: kept.map((w) => ({ phrase: w, kind: "produced" })), corrections: [] },
            dropped: 0,
            bankLocale: "es-MX",
            turns: [],
          });
          assert.ok(await blocked(pool), `round ${round}: the recap waits on the turn`);
          return recordGlosses(tx, profile, { lang: "es-MX", conversationId: B.id, turnId: next, items });
        });
        const [captured, stored] = await Promise.all([turn, turn.then(() => recap)]);
        assert.equal(captured, 2, `round ${round}: the turn's capture landed`);
        assert.ok(stored, `round ${round}: the recap was written`);
        const [{ n }] = (await pool.query("select count(*)::int as n from phrase_sightings s join phrases p on p.id = s.phrase_id where p.norm = $1", [normKey(nueva)])).rows;
        assert.equal(n, 2, `round ${round}: the new word seen by the turn and the recap`);
      }
      assert.deepEqual(errors.filter((e) => e.includes("40P01")), [], "no deadlock, even a retried one");
    } finally {
      console.error = orig;
    }
  });
});

test("a recap re-run while a phrase its last run sighted is renamed: that phrase is still locked, restored and recounted", { skip }, async (t) => {
  // previousRun reads the last run's phrases (with their norms) before the
  // lock pass; a rename committed in between used to make a lock by norm
  // find nothing, so the sighting went and the count stayed. Held each
  // round: the rename's transaction has the row when the re-run reaches it.
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < 5; round++) {
      const w = `la palabra ${round}`;
      const A = await conversation(pool, profile);
      const value = { summary: "", keep: [{ text: w, meaning: "m", example: "", why: "" }], events: [{ phrase: w, kind: "produced" }], corrections: [] };
      let { claim } = await claimExtraction(db, profile, A.id, { from: ["none"], live: [] });
      await applyExtraction(db, profile, { conversationId: A.id, claim, value, dropped: 0, bankLocale: "es-MX", turns: [] });
      const [{ id }] = (await pool.query("select id from phrases where norm = $1 and language_profile_id = $2", [normKey(w), profile.id])).rows;
      await pool.query("update phrases set starred = true where id = $1", [id]);
      ({ claim } = await claimExtraction(db, profile, A.id, { from: ["done"], live: [] }));
      const renamer = await pool.connect();
      try {
        await renamer.query("begin");
        await renamer.query("select 1 from phrases where id = $1 for update", [id]);
        const rerun = applyExtraction(db, profile, { conversationId: A.id, claim, value: { ...value, keep: [], events: [] }, dropped: 0, bankLocale: "es-MX", turns: [] });
        assert.ok(await blocked(pool), `round ${round}: the re-run waits on the rename`);
        await renamer.query("update phrases set text = $2, norm = $3, edited_at = now() where id = $1", [id, `${w} bis`, normKey(`${w} bis`)]);
        await renamer.query("commit");
        assert.ok(await rerun, `round ${round}: written`);
      } finally {
        renamer.release();
      }
      const [row] = (await pool.query(
        `select p.seen_count, (select count(*)::int from phrase_sightings s where s.phrase_id = p.id) as sightings, p.last_practiced_at,
                (select count(*)::int from reviews r join cards c on c.id = r.card_id where c.phrase_id = p.id) as reviews,
                (select coalesce(sum(reps), 0)::int from cards c where c.phrase_id = p.id) as reps
           from phrases p where p.id = $1`,
        [id],
      )).rows;
      assert.deepEqual(row, { seen_count: 0, sightings: 0, last_practiced_at: null, reviews: 0, reps: 0 }, `round ${round}: the renamed phrase undone and recounted`);
    }
  });
});
