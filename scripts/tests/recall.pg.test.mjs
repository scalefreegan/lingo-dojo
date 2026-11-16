// Recall's reads on a real Postgres (web/server/recall.ts reads the bank with
// scripts/db/phrases.ts recallBank, then ranks in memory: scripts/
// recall.mjs). Two things PGlite can't show: the read takes no row lock, so
// a turn never waits behind a capture, a recap or a practice answer holding
// the bank's rows (and never makes them wait); and it is fast enough to run
// on every turn at a realistic bank size. Runs only when LINGO_TEST_PG_URL
// names a Postgres; skipped otherwise. A throwaway database (pg-scratch.mjs),
// dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/recall.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createLearner, createUser } from "../db/accounts.ts";
import { recallBank, recallDetails, recallPhrases } from "../db/phrases.ts";
import { retrievalBlock, retrieve, reviewFromIds, selectReview } from "../recall.mjs";
import { ADULT } from "./http-session.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const BANK = 600;

/** A migrated throwaway database with one learner's bank of `size` phrases,
 *  half of them with a reviewed produce card (some due), and lapses on a few. */
async function withBank(t, fn, size = BANK) {
  const scratch = await scratchDatabase(url, "recall");
  const pool = new pg.Pool({ connectionString: scratch.url, max: 4 });
  t.after(async () => {
    await pool.end();
    await scratch.drop();
  });
  await applyMigrations(scratch.query);
  const db = drizzle(pool, { schema });
  const user = await createUser(db, { username: "reader", passwordHash: "x" });
  const learner = await createLearner(db, user.id, ADULT);
  const [{ id }] = (await pool.query("select id from language_profiles where learner_id = $1", [learner.id])).rows;
  const profile = { id, learnerId: learner.id };
  await pool.query(
    `insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source, first_seen_at, last_seen_at, seen_count)
     select $1, $2, 'es-MX', 'frase número ' || i, 'frase numero ' || i, 'phrase number ' || i, 'gloss', now() - interval '30 days', now() - make_interval(days => i % 20), 1
     from generate_series(1, ${size}) i`,
    [learner.id, id],
  );
  await pool.query(
    `insert into cards (phrase_id, learner_id, language_profile_id, skill, due, stability, difficulty, scheduled_days, reps, state, last_review)
     select p.id, p.learner_id, p.language_profile_id, 'produce', now() + make_interval(days => (row_number() over (order by p.id))::int % 15 - 7), 3, 5, 3, 2, 2, now() - interval '5 days'
     from phrases p where p.language_profile_id = $1 and (substring(p.text from '\\d+$'))::int % 2 = 0`,
    [id],
  );
  await pool.query(
    `insert into reviews (card_id, learner_id, language_profile_id, mode, rating, verdict, card_before, reviewed_at)
     select c.id, c.learner_id, c.language_profile_id, 'flashcard', 1, 'wrong', '{"state": 2}'::jsonb, now() - interval '1 day'
     from cards c where c.language_profile_id = $1 limit 40`,
    [id],
  );
  await fn(pool, db, profile);
}

const SCENE = { id: "s", title: "Market", summary: "", tags: [], beats: [], phrases: [], vocab: [] };

/** One turn's recall work, as web/server/recall.ts turnRecall does it. With
 *  the session's stored review (`reviewIds`, chosen once when the
 *  conversation began): the bank's words read (no cards), the retrieval
 *  ranked, then the metrics of the review and the hits only. Without: the
 *  whole bank with its metrics, and the review chosen (a conversation's
 *  creation, the Go tab's preview). The reads and the ranking (synchronous,
 *  on the server's one thread) are timed apart. */
async function turnRecall(db, profile, message, reviewIds = null) {
  const now = new Date();
  const t0 = performance.now();
  if (!reviewIds) {
    const bank = await recallBank(db, profile);
    const review = selectReview(bank, { now, scenario: SCENE });
    const block = retrievalBlock(retrieve(bank, { message, lastLine: "Aquí tiene." }), now);
    return { bank, review, block };
  }
  const words = await recallPhrases(db, profile);
  const t1 = performance.now();
  const hits = retrieve(words, { message, lastLine: "Aquí tiene." });
  const t2 = performance.now();
  const details = new Map((await recallDetails(db, profile, [...reviewIds, ...hits.map((p) => p.id)])).map((p) => [p.id, p]));
  const t3 = performance.now();
  const review = reviewFromIds([...details.values()], reviewIds);
  const block = retrievalBlock(hits.map((p) => details.get(p.id)), now);
  return { bank: words, review, block, readMs: t1 - t0 + (t3 - t2), rankMs: t2 - t1 + (performance.now() - t3) };
}

test("the recall read takes no row lock: it runs while a writer holds every phrase and card of the bank, and the writer never waits on it", { skip }, async (t) => {
  await withBank(t, async (pool, db, profile) => {
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      // What a capture, a recap's write or a practice answer holds: the
      // phrase rows, then the cards (the bank's lock order).
      await writer.query("select id from phrases where language_profile_id = $1 order by norm for update", [profile.id]);
      await writer.query("select id from cards where language_profile_id = $1 for update", [profile.id]);
      await writer.query("update phrases set seen_count = seen_count + 1 where language_profile_id = $1", [profile.id]);
      // A lock wait would hang here; the timeout turns it into a failure.
      const reader = drizzle(pool, { schema });
      const started = Date.now();
      const got = await Promise.race([
        turnRecall(reader, profile, "frase número 12, por favor"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("the recall read waited on the writer's locks")), 5000)),
      ]);
      assert.ok(Date.now() - started < 5000);
      assert.equal(got.bank.length, BANK);
      assert.equal(got.review.length, 10);
      assert.match(got.block, /- frase número 12 — phrase number 12/);
      // A later turn's reads (the words, then the review's and hits' details).
      const later = await Promise.race([
        turnRecall(reader, profile, "frase número 14, por favor", got.review.map((p) => p.id)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("a later turn's read waited on the writer's locks")), 5000)),
      ]);
      assert.equal(later.review.length, 10);
      assert.match(later.block, /- frase número 14 — phrase number 14/);
      // And no lock of the reader's is held: the writer's own update of a
      // card goes through at once.
      await writer.query("set local lock_timeout = '1s'");
      await writer.query("update cards set reps = reps where language_profile_id = $1", [profile.id]);
      await writer.query("commit");
    } finally {
      writer.release();
    }
    const [{ n }] = (await pool.query("select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where c.relname in ('phrases', 'cards') and l.mode in ('RowShareLock', 'RowExclusiveLock')")).rows;
    assert.equal(n, 0, "nothing left holding the bank");
  });
});

const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];

for (const size of [600, 3000, 6000]) {
  test(`a turn's recall on a ${size}-phrase bank: the time it adds`, { skip }, async (t) => {
    await withBank(
      t,
      async (_pool, db, profile) => {
        // The session's review, chosen once (as a conversation's creation does).
        const ids = selectReview(await recallBank(db, profile), { now: new Date(), scenario: SCENE }).map((p) => p.id);
        const total = [];
        const read = [];
        const rank = [];
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now();
          const got = await turnRecall(db, profile, `quiero la frase número ${i}`, ids);
          total.push(performance.now() - t0);
          read.push(got.readMs);
          rank.push(got.rankMs);
          assert.equal(got.review.length, 10);
        }
        t.diagnostic(
          `recall per turn, ${size} phrases: median ${pct(total, 0.5).toFixed(1)} ms, p95 ${pct(total, 0.95).toFixed(1)} ms ` +
            `(read median ${pct(read, 0.5).toFixed(1)} ms; ranking median ${pct(rank, 0.5).toFixed(1)} ms, p95 ${pct(rank, 0.95).toFixed(1)} ms)`,
        );
        // Choosing a review: once per session, and each Go tab preview.
        const choose = [];
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          await turnRecall(db, profile, "hola");
          choose.push(performance.now() - t0);
        }
        t.diagnostic(`choosing a review (session start, preview), ${size} phrases: median ${pct(choose, 0.5).toFixed(1)} ms`);
        // A tool-less model turn takes seconds (docs/VOICE.md: about 4 s);
        // this must stay a rounding error next to it.
        assert.ok(pct(total, 0.5) < 250, `median ${pct(total, 0.5).toFixed(1)} ms`);
      },
      size,
    );
  });
}
