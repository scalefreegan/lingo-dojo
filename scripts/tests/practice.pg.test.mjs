// Practice races on a real Postgres (scripts/db/practice.ts): one answer
// submitted on several connections at once must write one review and move
// the card once (the rest are answered with that review); an answer racing
// a gloss capture that makes the same card, an override racing the next
// answer, and an edit of the phrase must neither deadlock nor lose a write.
// PGlite runs one transaction at a time and can't show a race, so these run
// only when LINGO_TEST_PG_URL names a Postgres; skipped otherwise. A
// throwaway database per test (pg-scratch.mjs), dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/practice.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createLearner, createUser } from "../db/accounts.ts";
import { addPhrase, recordGlosses, updatePhrase } from "../db/phrases.ts";
import { PracticeError, overrideReview, recordAnswer } from "../db/practice.ts";
import { normKey } from "../match.mjs";
import { phraseRevision } from "../practice.mjs";
import { ADULT } from "./http-session.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const ROUNDS = 20;
const RACERS = 6;

/** A migrated throwaway database with one learner's Spanish profile, and a
 *  pool with a connection for every racer. */
async function withProfile(t, fn) {
  const scratch = await scratchDatabase(url, "practice");
  const pool = new pg.Pool({ connectionString: scratch.url, max: RACERS + 2 });
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

const good = { verdict: "exact", rating: 3, note: null };
const write = (phrase, skill, version, extra = {}) => ({
  phraseId: phrase.id, skill, version, revision: phraseRevision(phrase), submitId: crypto.randomUUID(), outcome: good, answer: phrase.meaning,
  durationMs: null, utcOffsetMinutes: 0, keepAlternate: false, targetLocale: "es-MX", now: new Date(), ...extra,
});
const settle = (ps) => Promise.allSettled(ps);

test("one answer (one submit id) sent on six connections at once: one review, the card moved once, the rest answered with it", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const { phrase } = await addPhrase(db, profile, "es-MX", { text: `palabra ${round}`, meaning: `word ${round}` });
      // Every racer graded at the same version (a card not made yet, then
      // its second review), as a double click or a retried fetch would.
      for (const version of ["0:", null]) {
        const v = version ?? (await pool.query("select reps, last_review from cards where phrase_id = $1 and skill = 'produce'", [phrase.id])).rows.map((c) => `${c.reps}:${c.last_review.toISOString()}`)[0];
        const submitId = crypto.randomUUID();
        const out = await settle(Array.from({ length: RACERS }, () => recordAnswer(db, profile, write(phrase, "produce", v, { now: new Date(), submitId }))));
        const failed = out.filter((o) => o.status === "rejected");
        assert.deepEqual(failed.map((f) => String(f.reason)), [], `round ${round}`);
        const replies = out.map((o) => o.value);
        assert.equal(new Set(replies.map((r) => r.review.id)).size, 1, "every racer got the one review");
        assert.equal(replies.filter((r) => !r.replayed).length, 1, "one wrote it");
      }
      const [{ n, reps }] = (await pool.query("select count(r.*)::int as n, max(c.reps) as reps from cards c join reviews r on r.card_id = c.id where c.phrase_id = $1 and c.skill = 'produce'", [phrase.id])).rows;
      assert.deepEqual([n, reps], [2, 2]);
    }
  });
});

test("six different answers to one card at once: one written, five refused (409), none replayed as another's", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const { phrase } = await addPhrase(db, profile, "es-MX", { text: `palabra ${round}`, meaning: `word ${round}` });
      const out = await settle(Array.from({ length: RACERS }, (_, i) => recordAnswer(db, profile, write(phrase, "recognize", "0:", { answer: `answer ${i}` }))));
      const ok = out.filter((o) => o.status === "fulfilled");
      assert.equal(ok.length, 1, `round ${round}: ${out.map((o) => o.status + " " + (o.reason ?? "")).join("; ")}`);
      assert.equal(ok[0].value.replayed, false);
      for (const o of out.filter((x) => x.status === "rejected")) {
        assert.ok(o.reason instanceof PracticeError && o.reason.code === "ECONFLICT", String(o.reason));
      }
      const [{ n }] = (await pool.query("select count(r.*)::int as n from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1", [phrase.id])).rows;
      assert.equal(n, 1);
    }
  });
});

test("an answer making a card while a gloss capture makes the same one, and an edit of the phrase meanwhile: no deadlock, no lost write", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const text = `mercado ${round}`;
      const { phrase } = await addPhrase(db, profile, "es-MX", { text, meaning: `market ${round}` });
      const conversationId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      await pool.query(`insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language) values ($1, $2, $3, '{}', 'Race', 'adult', 'Spanish')`, [conversationId, profile.learnerId, profile.id]);
      await pool.query(`insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, $4, 0, 'master', '')`, [turnId, conversationId, profile.learnerId, profile.id]);
      const item = { text, norm: normKey(text), meaning: `market ${round}`, meaningNorm: normKey(`market ${round}`), example: null };
      const [ans, cap, edit] = await settle([
        recordAnswer(db, profile, write(phrase, "recognize", "0:")),
        db.transaction((tx) => recordGlosses(tx, profile, { lang: "es-MX", conversationId, turnId, items: [item] })),
        updatePhrase(db, profile, phrase.id, { note: `edited ${round}` }),
      ]);
      assert.equal(ans.status, "fulfilled", String(ans.reason));
      assert.equal(cap.status, "fulfilled", String(cap.reason));
      assert.equal(cap.value, 1, "the capture landed");
      assert.equal(edit.status, "fulfilled", String(edit.reason));
      const cards = (await pool.query("select skill, reps from cards where phrase_id = $1", [phrase.id])).rows;
      assert.deepEqual(cards, [{ skill: "recognize", reps: 1 }], "one card, reviewed once");
      const [p] = (await pool.query("select note, seen_count, last_practiced_at from phrases where id = $1", [phrase.id])).rows;
      assert.deepEqual([p.note, p.seen_count, !!p.last_practiced_at], [`edited ${round}`, 1, true]);
    }
  });
});

test("an override racing the card's next answer: one wins, the other is refused or applies after; the card is never left between", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const { phrase } = await addPhrase(db, profile, "es-MX", { text: `kilo ${round}`, meaning: `kilo ${round}` });
      const first = await recordAnswer(db, profile, write(phrase, "recognize", "0:"));
      const [ov, next] = await settle([
        overrideReview(db, profile, first.review.id, { rating: 1, utcOffsetMinutes: 0, targetLocale: "es-MX" }),
        recordAnswer(db, profile, write(phrase, "recognize", first.card.version, { now: new Date(Date.now() + 1000) })),
      ]);
      // The next answer's version survives an override (same reps and last
      // review), so it always lands; the override lands only if it went first.
      assert.equal(next.status, "fulfilled", String(next.reason));
      if (ov.status === "rejected") {
        assert.ok(ov.reason instanceof PracticeError && ov.reason.code === "ECONFLICT", String(ov.reason));
      }
      const rows = (await pool.query("select r.rating, r.verdict from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1 order by r.id", [phrase.id])).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].verdict, ov.status === "fulfilled" ? "self" : "exact");
      const [card] = (await pool.query("select reps from cards where phrase_id = $1", [phrase.id])).rows;
      assert.equal(card.reps, 2);
    }
  });
});
