// A session's tone flags reach the bank (ld-ne0.18; docs/VOICE.md §Tones
// after the session): at the recap, a bank phrase the learner said with a
// syllable flagged at the live bar gets one failing review of its speak
// card, under the same narrow rule as Practice; never a second review
// beside the model's own event, replaced by a re-run, and taken back by "I
// said it right" without leaving a lapse. The turns are really scored (the
// local scorer: no Azure keys, no paid call), speech-to-text is stubbed in
// fetch and `claude` is the stand-in. In-process PGlite; names made up.
//   node --test scripts/tests/tone-recap.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromRow, review } from "../fsrs.mjs";
import { encodeWav } from "../pronunciation.mjs";
import { speak } from "../pronunciation-synth.mjs";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-tone-recap-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_CLIPS_DIR;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY", "LINGO_IMAGE_PROVIDER"]) delete process.env[k];

let heard = "妈";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.elevenlabs.io" && url.pathname === "/v1/speech-to-text") {
    return new Response(JSON.stringify({ text: heard }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`unexpected fetch to ${url.hostname}`);
};

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { clearLive } = await import("../../web/server/livePronunciation.ts");
const fake = fakeClaude();
const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settleExtractions();
  globalThis.fetch = realFetch;
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  clearLive();
  heard = "妈";
  fake.answer("NARRATOR-F: <t>好。</t>");
  recapSays();
});

const recapSays = (events = [], keep = []) => fake.recap(JSON.stringify({ summary: "A short one.", keep, events, corrections: [] }));
const MANDARIN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };
const TAIWAN = { ...ADULT, name: "Wei", targetLanguage: "Mandarin Chinese", targetVariant: "Taiwanese Mandarin" };
const KID_MANDARIN = { ...KID, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };

let n = 0;
async function someone(learner = MANDARIN) {
  const name = `recap${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return c;
}
function clip(shapes) {
  const { samples } = speak(shapes, { gaps: [300, ...shapes.slice(1).map(() => 80), 300] });
  return new Uint8Array(encodeWav(samples, 16_000));
}
/** 妈 (mā, the first tone) said falling: a clear miss. And said right. */
const MISSED = clip([4]);
const RIGHT = clip([1]);

const packFor = (mode) => ({ title: "", created: "", scenario: mode === "kids" ? "farm" : "market", quick_scenario: "", units: mode === "kids" ? ["intro-game", "story-quest", "game-echo"] : [], overrides: {}, notes: "" });
/** A session of these turns (each `[text heard, recording]`), ended, its recap made. */
async function session(who, turns, { mode = "adult", locales = "zh-CN,en-US" } = {}) {
  const r = await who.call("POST", "/api/conversations", { mode, pack: packFor(mode), title: "Tones" });
  assert.equal(r.status, 201, r.text);
  const id = r.body.conversation.id;
  for (const [text, wav] of turns) {
    heard = text;
    const t = await who.call("POST", `/api/voice/transcribe?locales=${locales}&conversation=${id}`, wav, { "Content-Type": "audio/wav" });
    assert.equal(t.status, 200, t.text);
    const v = await who.call("POST", "/api/voice/turn", { mode, pack: packFor(mode), history: [], message: text, elapsedMs: 0, conversationId: id, conversationStart: 0 });
    assert.equal(v.status, 200, v.text);
  }
  assert.equal((await who.call("POST", `/api/conversations/${id}/end`)).status, 200);
  await settleExtractions();
  const recap = (await who.call("GET", `/api/conversations/${id}/recap`)).body.recap;
  assert.equal(recap.status, "done", recap.error);
  return { id, recap };
}
async function phrase(who, text = "妈", meaning = "mum") {
  const p = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
  assert.equal(p.status, 201, p.text);
  return p.body.phrase.id;
}
const reviewsOf = (phraseId) =>
  q("select r.id, r.rating, r.mode, r.answer, r.card_before, r.conversation_id, r.reviewed_at, k.skill from reviews r join cards k on k.id = r.card_id where k.phrase_id = $1 order by r.id", [phraseId]);
const cardOf = async (phraseId) => (await q("select * from cards where phrase_id = $1 and skill = 'produce'", [phraseId]))[0];
/** Flags were stored: a test of "no review" started from a real flag. */
const flagsIn = async (id) => (await q("select coalesce(sum(flagged), 0)::int as n from pronunciation_checks where conversation_id = $1", [id]))[0].n;
const retry = async (who, id) => {
  assert.equal((await who.call("POST", `/api/conversations/${id}/recap`)).status, 202);
  await settleExtractions();
  return (await who.call("GET", `/api/conversations/${id}/recap`)).body.recap;
};
const right = (who, id, phraseId) => who.call("POST", `/api/conversations/${id}/recap-tones`, { phraseId });
/** The speak card in the review state, last reviewed 12 days ago. */
async function mature(phraseId, who) {
  await q("insert into cards (learner_id, language_profile_id, phrase_id, skill) values ($1, $2, $3, 'produce') on conflict do nothing", [who.learnerId, who.languageId, phraseId]);
  const last = new Date(Date.now() - 12 * 86_400_000).toISOString();
  await q(
    "update cards set state = 2, reps = 4, lapses = 0, stability = 12, stability_fast = null, difficulty = 5, scheduled_days = 12, learning_steps = 0, last_review = $2, due = $2::timestamptz + interval '12 days' where phrase_id = $1 and skill = 'produce'",
    [phraseId, last],
  );
  return cardOf(phraseId);
}

test("a flagged phrase the model didn't name: one failing review of its speak card, said in the recap, idempotent", async () => {
  const lin = await someone();
  const p = await phrase(lin);
  const { id, recap } = await session(lin, [["妈", MISSED]]);
  const [r, ...more] = await reviewsOf(p);
  assert.deepEqual([r?.rating, r?.mode, r?.skill, r?.answer, r?.conversation_id, more.length], [1, "session", "produce", "妈", id, 0]);
  assert.deepEqual(recap.toneMisses, [{ phraseId: p, phrase: "妈", line: "妈", syllables: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }], dismissed: false }]);
  assert.deepEqual(recap.events, [], "not one of the model's events (a revisit never carries it)");
  const card = await cardOf(p);
  const again = await retry(lin, id);
  assert.deepEqual(again.toneMisses, recap.toneMisses);
  assert.deepEqual((await reviewsOf(p)).map((x) => x.rating), [1]);
  assert.deepEqual(fromRow(await cardOf(p)), fromRow(card));
});

test("the model's event for the same phrase: one review, a miss; 'I said it right' puts back what the event gave, and a re-run keeps it", async () => {
  const lin = await someone();
  const p = await phrase(lin);
  const was = await mature(p, lin);
  recapSays([{ phrase: "妈", kind: "produced", said: "妈" }]);
  const { id, recap } = await session(lin, [["妈", MISSED]]);
  assert.equal(recap.events[0].reviewed, true);
  let rows = await reviewsOf(p);
  assert.deepEqual(rows.map((r) => r.rating), [1], "one review, the miss");
  assert.equal((await cardOf(p)).lapses, 1);
  const stranger = await someone();
  assert.equal((await right(stranger, id, p)).status, 404, "another learner's");
  assert.equal((await right(lin, id, crypto.randomUUID())).status, 404);
  assert.equal((await right(lin, id, "nope")).status, 400);
  const done = await right(lin, id, p);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.recap.toneMisses[0].dismissed, true);
  rows = await reviewsOf(p);
  assert.deepEqual(rows.map((r) => r.rating), [3]);
  const at = new Date(rows[0].reviewed_at);
  const expected = review(fromRow(was), 3, at, { utcOffsetMinutes: -at.getTimezoneOffset() }).card;
  assert.deepEqual(fromRow(await cardOf(p)), expected, "as if the words alone had been graded: no lapse");
  assert.equal((await right(lin, id, p)).status, 200, "twice is once");
  const again = await retry(lin, id);
  assert.equal(again.toneMisses[0].dismissed, true);
  assert.deepEqual((await reviewsOf(p)).map((r) => r.rating), [3]);
  // The model fails it itself next time (the dismissal says nothing about
  // that), then not: the dismissal still holds.
  recapSays([{ phrase: "妈", kind: "corrected" }]);
  assert.deepEqual((await retry(lin, id)).toneMisses, []);
  assert.deepEqual((await reviewsOf(p)).map((r) => r.rating), [1]);
  recapSays();
  assert.equal((await retry(lin, id)).toneMisses[0].dismissed, true);
  assert.deepEqual(await reviewsOf(p), []);
});

test("'I said it right' with no event: the review goes, and the card is as it was", async () => {
  const lin = await someone();
  const p = await phrase(lin);
  const was = await mature(p, lin);
  const { id } = await session(lin, [["妈", MISSED]]);
  assert.equal((await reviewsOf(p)).length, 1);
  assert.equal((await right(lin, id, p)).status, 200);
  assert.deepEqual(await reviewsOf(p), []);
  assert.deepEqual(fromRow(await cardOf(p)), fromRow(was));
  // A card the miss itself made goes too.
  const wen = await someone();
  const p3 = await phrase(wen);
  const s3 = await session(wen, [["妈", MISSED]]);
  assert.equal((await right(wen, s3.id, p3)).status, 200);
  assert.equal(await cardOf(p3), undefined);
});

test("practised since the session: the miss can't be taken back, and a re-run leaves that card alone", async () => {
  const lin = await someone();
  const p = await phrase(lin);
  const { id } = await session(lin, [["妈", MISSED]]);
  const card = await cardOf(p);
  await q("insert into reviews (learner_id, language_profile_id, card_id, mode, rating, verdict, reviewed_at, card_before) values ($1, $2, $3, 'speak', 3, 'exact', now(), '{}')", [lin.learnerId, lin.languageId, card.id]);
  const r = await right(lin, id, p);
  assert.equal(r.status, 409, r.text);
  assert.match(r.body.error, /practised since/);
  await retry(lin, id);
  assert.deepEqual((await reviewsOf(p)).map((x) => x.rating), [1, 3]);
});

test("no miss: fixed later in the session, already failed by the model, suspended, not in the bank, or the rule says no", async () => {
  const lin = await someone();
  const p = await phrase(lin);
  const fixed = await session(lin, [["妈", MISSED], ["妈", RIGHT]]);
  assert.equal(await flagsIn(fixed.id), 1);
  assert.deepEqual([await reviewsOf(p), fixed.recap.toneMisses], [[], []]);

  recapSays([{ phrase: "妈", kind: "corrected" }]);
  const failed = await session(lin, [["妈", MISSED]]);
  assert.equal(await flagsIn(failed.id), 1);
  assert.deepEqual((await reviewsOf(p)).map((r) => [r.rating, r.answer]), [[1, null]], "the model's own, once");
  assert.deepEqual(failed.recap.toneMisses, []);
  assert.equal((await right(lin, failed.id, p)).status, 404);

  recapSays();
  const gone = await someone();
  const none = await session(gone, [["妈", MISSED]]);
  assert.equal(await flagsIn(none.id), 1);
  assert.deepEqual(none.recap.toneMisses, []);
  const sp = await phrase(gone);
  assert.equal((await gone.call("PATCH", `/api/phrases/${sp}`, { suspended: true })).status, 200);
  assert.deepEqual((await retry(gone, none.id)).toneMisses, []);
  assert.deepEqual(await reviewsOf(sp), []);

  // Taiwan: only a settled reading fails, as in Practice.
  const wei = await someone(TAIWAN);
  const tp = await phrase(wei, "妈", "mum");
  const tw = await session(wei, [["妈", MISSED]], { locales: "zh-TW,en-US" });
  assert.equal(await flagsIn(tw.id), 1);
  assert.deepEqual([await reviewsOf(tp), tw.recap.toneMisses], [[], []]);
});

test("a phrase this recap keeps may be failed; kids: nothing stored, nothing shown, no route", async () => {
  const lin = await someone();
  recapSays([], [{ text: "妈", meaning: "mum", example: "", why: "" }]);
  const { recap } = await session(lin, [["妈", MISSED]]);
  assert.equal(recap.toneMisses.length, 1);
  assert.equal(recap.toneMisses[0].phraseId, recap.kept[0].phraseId);

  recapSays();
  const mei = await someone(KID_MANDARIN);
  const p = await phrase(mei);
  const kid = await session(mei, [["妈", MISSED]], { mode: "kids" });
  assert.deepEqual(kid.recap.toneMisses, []);
  assert.deepEqual(await reviewsOf(p), []);
  assert.equal((await right(mei, kid.id, p)).status, 404);
});

test("a sentence this recap keeps never takes the miss from a phrase already in the bank, on the first run or a re-run", async () => {
  const { applyExtraction, claimExtraction } = await import("../db/extraction.ts");
  const lin = await someone();
  const p = await phrase(lin, "妈妈");
  const { id } = await session(lin, [["妈", RIGHT]]);
  const profile = { id: lin.languageId, learnerId: lin.learnerId };
  const toneLines = [{ line: "妈妈很忙。", flags: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }], ok: [3, 4] }];
  for (const run of [1, 2]) {
    const { claim } = await claimExtraction(testDb.db, profile, id, { from: ["done"], live: [] });
    const value = { summary: "", keep: [{ text: "妈妈很忙", meaning: "mum is busy", example: "", why: "" }], events: [], corrections: [] };
    const recap = await applyExtraction(testDb.db, profile, { conversationId: id, claim, value, dropped: 0, bankLocale: "zh-CN", turns: [], toneLines });
    assert.deepEqual(recap.tones.map((t) => [t.phrase, t.phraseId, t.reviewed]), [["妈妈", p, true]], `run ${run}`);
    assert.ok(recap.keep[0].phraseId, "the sentence is in the bank now");
  }
});
