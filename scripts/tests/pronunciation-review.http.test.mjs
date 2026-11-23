// Pronunciation stage 3 end to end (ld-ne0.4; docs/VOICE.md §Tones after
// the session, docs/DATA.md §Pronunciation in sessions): the checks stage 2
// keeps with each scored Go-tab turn, read back as a session's Tones
// section (with the scene's last attempt compared) and as the per-tone
// trend, only to their own learner and language; and Practice speak-it,
// whose tone check now runs before the answer, held for that submit: right
// words with a syllable flagged at the live bar become a miss, which a
// replay repeats and "I said it right" (an override) restores. Kids see
// and store nothing. Speech-to-text is stubbed in fetch, the scorer is
// the local one (no Azure keys: no paid call of any kind), `claude` is a
// stand-in on PATH. The real plugin on an in-process PGlite; the speech is
// generated (scripts/pronunciation-synth.mjs). Every name is made up.
//   node --test scripts/tests/pronunciation-review.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "../pronunciation.mjs";
import { speak } from "../pronunciation-synth.mjs";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-tone-review-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_CLIPS_DIR;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

/* Speech-to-text, stubbed: it "hears" `heard`. Any other host is refused. */
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

/* A stand-in `claude` first on PATH: one line for every turn, and nothing
 * usable for a recap (a recap that fails is no matter here: the Tones
 * section never waits for it). */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-tone-review-claude-"));
fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "result", result: "NARRATOR-F: <t>好。</t>" }));\n`, { mode: 0o755 });
const savedPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${savedPath}`;

const { apiPlugins } = await import("../../web/server/api.ts");
const { clearLive } = await import("../../web/server/livePronunciation.ts");
const { clearPracticeTones } = await import("../../web/server/toneReview.ts");
const { checksOf } = await import("../db/pronunciation.ts");

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = savedPath;
  fs.rmSync(bin, { recursive: true, force: true });
  await close();
  await testDb.close();
});
beforeEach(() => {
  clearLive();
  clearPracticeTones();
  heard = "妈";
});

const MANDARIN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };
const KID_MANDARIN = { ...KID, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };

let n = 0;
async function someone(learners = [MANDARIN]) {
  const name = `tones${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}
const profileOf = (who) => ({ id: who.languageId, learnerId: who.learnerId });

/** A generated voice saying `shapes` (tones), 300 ms of quiet around it. */
function clip(shapes) {
  const { samples } = speak(shapes, { gaps: [300, ...shapes.slice(1).map(() => 80), 300] });
  return new Uint8Array(encodeWav(samples, 16_000));
}
/** 妈 (mā, the first tone) said falling: a clear miss. And said right. */
const MISSED = clip([4]);
const RIGHT = clip([1]);

const ADULT_PACK = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };
const KIDS_PACK = { title: "", created: "", scenario: "farm", quick_scenario: "", units: ["intro-game", "story-quest", "game-echo"], overrides: {}, notes: "" };

async function start(who, mode = "adult") {
  const r = await who.call("POST", "/api/conversations", { mode, pack: mode === "kids" ? KIDS_PACK : ADULT_PACK, title: "Tones" });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation.id;
}
/** One Go-tab turn: the recording transcribed (scoring starts), then the
 *  turn that takes the score. */
async function say(who, id, wav, { mode = "adult" } = {}) {
  const t = await who.call("POST", `/api/voice/transcribe?locales=zh-CN,en-US&conversation=${id}`, wav, { "Content-Type": "audio/wav" });
  assert.equal(t.status, 200, t.text);
  const r = await who.call("POST", "/api/voice/turn", { mode, pack: mode === "kids" ? KIDS_PACK : ADULT_PACK, history: [], message: heard, elapsedMs: 0, conversationId: id, conversationStart: 0 });
  assert.equal(r.status, 200, r.text);
  return r.body;
}
const tonesOf = (who, id) => who.call("GET", `/api/pronunciation/sessions/${id}`);

test("a session's Tones: counts by tone, the flagged syllable with its line and clip, from the stored checks only", async () => {
  const lin = await someone();
  const id = await start(lin);
  await say(lin, id, MISSED);
  await say(lin, id, RIGHT);
  await say(lin, id, RIGHT);
  const r = await tonesOf(lin, id);
  assert.equal(r.status, 200, r.text);
  const t = r.body.tones;
  assert.deepEqual([t.turns, t.checked, t.ok, t.off, t.unsure], [3, 3, 2, 1, 0]);
  assert.deepEqual(t.judged, { ok: 2, checked: 3 });
  assert.deepEqual(t.byTone, [{ tone: 1, checked: 3, ok: 2, off: 1, unsure: 0 }]);
  const [check] = await checksOf(testDb.db, profileOf(lin), id);
  assert.equal(t.flagged.length, 1);
  const f = t.flagged[0];
  assert.deepEqual([f.checkId, f.line, f.place, f.char, f.expectedTone, f.heardTone], [check.id, "妈", 1, "妈", 1, 4]);
  assert.ok(Number.isFinite(f.startMs) && f.endMs > f.startMs, JSON.stringify(f));
  assert.equal(t.vsLast, null, "no earlier attempt");
  // Its clip plays for this learner (the stage 2 route).
  assert.equal((await lin.call("GET", `/api/pronunciation/clips/${f.checkId}`)).status, 200);
  // The recap's own reply is unchanged: no tones in it.
  const recap = await lin.call("GET", `/api/conversations/${id}/recap`);
  assert.equal(recap.status, 200);
  assert.equal("tones" in recap.body.recap, false);
});

test("a revisit compares with the last attempt; a session with no checks has no section", async () => {
  const lin = await someone();
  const was = await start(lin);
  for (const w of [MISSED, MISSED, RIGHT]) {
    // Three turns, two of them flagged (each turn on its own: the live bar
    // looks at one turn at a time).
    await say(lin, was, w);
  }
  const now = await start(lin);
  for (const w of [RIGHT, RIGHT, RIGHT, MISSED]) await say(lin, now, w);
  // Revisit's link (set when a scene is played again; here by hand).
  await q("update conversations set previous_conversation_id = $1 where id = $2", [was, now]);
  const t = (await tonesOf(lin, now)).body.tones;
  assert.ok(t.vsLast, JSON.stringify(t));
  assert.equal(t.vsLast.from, was);
  assert.deepEqual(t.vsLast.overall, { now: { ok: 3, checked: 4 }, was: { ok: 1, checked: 3 }, move: "up" });
  assert.deepEqual(t.vsLast.tones, [{ tone: 1, now: { ok: 3, checked: 4 }, was: { ok: 1, checked: 3 }, move: "up" }]);
  assert.deepEqual(t.vsLast.flagged, { now: 1, was: 2 });
  // The earlier session gone: the link nulls, the comparison goes.
  assert.equal((await lin.call("DELETE", `/api/conversations/${was}`)).status, 200);
  assert.equal((await tonesOf(lin, now)).body.tones.vsLast, null);
  // A session whose turns weren't scored (the dial off): nothing at all.
  const off = await start(lin);
  const tr = await lin.call("POST", `/api/voice/transcribe?locales=zh-CN,en-US&conversation=${off}&coaching=off`, MISSED, { "Content-Type": "audio/wav" });
  assert.equal(tr.status, 200);
  await lin.call("POST", "/api/voice/turn", { mode: "adult", pack: ADULT_PACK, history: [], message: "妈", elapsedMs: 0, conversationId: off, conversationStart: 0, coaching: "off" });
  assert.deepEqual((await tonesOf(lin, off)).body, { tones: null });
});

test("another learner's or another language's session, checks and clips are unreachable; the trend is each language's own", async () => {
  const lin = await someone();
  const id = await start(lin);
  await say(lin, id, MISSED);
  const [check] = await checksOf(testDb.db, profileOf(lin), id);
  const stranger = await someone();
  for (const url of [`/api/pronunciation/sessions/${id}`, `/api/pronunciation/clips/${check.id}`]) {
    assert.equal((await stranger.call("GET", url)).status, 404, url);
    assert.equal((await client(base).call("GET", url)).status, 401, url);
  }
  assert.deepEqual((await stranger.call("GET", "/api/pronunciation/trend")).body.points, []);
  for (const bad of ["nope", "1%20or%201%3D1"]) assert.equal((await lin.call("GET", `/api/pronunciation/sessions/${bad}`)).status, 404);
  assert.equal((await lin.call("POST", `/api/pronunciation/sessions/${id}`)).status, 405);
  // The same learner in another language: none of it.
  const mandarinId = lin.languageId;
  await lin.addLanguage({ target_language: "Spanish", target_variant: "Mexican Spanish", level: "A2" });
  assert.notEqual(lin.languageId, mandarinId);
  assert.equal((await tonesOf(lin, id)).status, 404);
  assert.equal((await lin.call("GET", `/api/pronunciation/clips/${check.id}`)).status, 404);
  assert.deepEqual((await lin.call("GET", "/api/pronunciation/trend")).body.points, []);
  // Back to Mandarin: its own again.
  await lin.pickLanguage(mandarinId);
  assert.equal((await tonesOf(lin, id)).status, 200);
});

test("the trend: share right per tone per day in the learner's days, a point only from enough syllables", async () => {
  const lin = await someone();
  const id = await start(lin);
  for (let i = 0; i < 12; i++) await say(lin, id, i < 3 ? MISSED : RIGHT);
  // Spread them: the first six two days back, the rest today.
  const rows = await q("select id from pronunciation_checks where conversation_id = $1 order by created_at", [id]);
  for (const r of rows.slice(0, 6)) await q("update pronunciation_checks set created_at = now() - interval '2 days' where id = $1", [r.id]);
  const r = await lin.call("GET", "/api/pronunciation/trend?days=30&tz=0");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.days, 30);
  assert.equal(r.body.minSyllables, 10);
  assert.match(r.body.from, /^\d{4}-\d\d-\d\d$/);
  assert.equal(r.body.points.length, 2);
  const [older, today] = r.body.points;
  const t1 = (p) => p.tones.find((t) => t.tone === 1);
  // Six syllables a day: counted, not drawn (under the minimum).
  assert.deepEqual([t1(older).ok, t1(older).n, t1(older).share], [3, 6, null]);
  assert.deepEqual([t1(today).ok, t1(today).n, t1(today).share], [6, 6, null]);
  // All on one day: twelve, drawn.
  await q("update pronunciation_checks set created_at = now() where conversation_id = $1", [id]);
  const one = (await lin.call("GET", "/api/pronunciation/trend")).body.points;
  assert.equal(one.length, 1);
  assert.deepEqual([t1(one[0]).ok, t1(one[0]).n, t1(one[0]).share], [9, 12, 0.75]);
  assert.equal(one[0].all.share, 0.75);
  // A window that doesn't reach them.
  await q("update pronunciation_checks set created_at = now() - interval '40 days' where conversation_id = $1", [id]);
  assert.deepEqual((await lin.call("GET", "/api/pronunciation/trend?days=30")).body.points, []);
  assert.equal((await lin.call("GET", "/api/pronunciation/trend?days=90")).body.points.length, 1);
  // A nonsense window is the default.
  assert.equal((await lin.call("GET", "/api/pronunciation/trend?days=99999")).body.days, 30);
});

test("kids: nothing stored, nothing shown", async () => {
  const mei = await someone([KID_MANDARIN]);
  const id = await start(mei, "kids");
  await say(mei, id, MISSED, { mode: "kids" });
  assert.deepEqual(await checksOf(testDb.db, profileOf(mei), id), []);
  assert.deepEqual((await tonesOf(mei, id)).body, { tones: null });
  assert.deepEqual((await mei.call("GET", "/api/pronunciation/trend")).body.points, []);
  // Practice's hold isn't a child's.
  const s = await mei.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("妈")}&phrase=${crypto.randomUUID()}&submit=${crypto.randomUUID()}`, MISSED, { "Content-Type": "audio/wav" });
  assert.equal(s.status, 400);
});

/* ---------------------------------- Practice ---------------------------------- */

async function speakItem(who, text = "妈", meaning = "mum") {
  const p = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
  assert.equal(p.status, 201, p.text);
  const items = (await who.call("GET", "/api/practice/queue?mode=speak&length=5&tz=0")).body.items;
  const item = items.find((i) => i.phraseId === p.body.phrase.id);
  assert.ok(item, JSON.stringify(items));
  return item;
}
const score = (who, item, submitId, wav, extra = "") =>
  who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(item.text)}&phrase=${item.phraseId}&submit=${submitId}${extra}`, wav, { "Content-Type": "audio/wav" });
const answer = (who, item, submitId, body) =>
  who.call("POST", "/api/practice/answer", { phraseId: item.phraseId, skill: item.skill, drill: item.drill, version: item.version, revision: item.revision, submitId, tz: 0, answer: "妈", ...body });

test("speak-it: right words with a flagged tone are a miss with the reason; a replay says the same; I said it right restores the grade", async () => {
  const lin = await someone();
  const item = await speakItem(lin);
  const submitId = crypto.randomUUID();
  const s = await score(lin, item, submitId, MISSED);
  assert.equal(s.status, 200, s.text);
  assert.equal(s.body.held, true);
  assert.deepEqual(s.body.syllables.map((x) => [x.verdict, x.heardTone]), [["off", 4]]);
  const r = await answer(lin, item, submitId, { tones: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.review.verdict, r.body.review.rating], ["wrong", 1]);
  assert.deepEqual(r.body.toneMiss, { rating: 3, verdict: "exact", syllables: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }] });
  assert.equal(r.body.card.lapses + r.body.card.reps >= 1, true);
  // A resend (the reply lost): the same review, the same reason, nothing new.
  const again = await answer(lin, item, submitId, { tones: true });
  assert.deepEqual([again.status, again.body.replayed, again.body.review.id, again.body.toneMiss], [200, true, r.body.review.id, r.body.toneMiss]);
  const [{ count }] = await q("select count(*)::int as count from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1", [item.phraseId]);
  assert.equal(count, 1);
  // I said it right: the grade the words had.
  const o = await lin.call("POST", `/api/practice/reviews/${r.body.review.id}/override`, { rating: r.body.toneMiss.rating, tz: 0 });
  assert.equal(o.status, 200, o.text);
  assert.deepEqual([o.body.review.rating, o.body.review.verdict], [3, "self"]);
  assert.deepEqual(o.body.toneMiss, r.body.toneMiss, "the reason stays with the review");
  const [card] = await q("select reps, lapses, state from cards where phrase_id = $1 and skill = 'produce'", [item.phraseId]);
  assert.equal(card.lapses, 0, "restored from the state before the answer: no lapse");
});

test("speak-it: said right, no hold, a hold for another submit or phrase, or a wrong answer: graded as before", async () => {
  const lin = await someone();
  // Said right: held, nothing flagged.
  const a = await speakItem(lin, "妈", "mum");
  const sa = crypto.randomUUID();
  assert.equal((await score(lin, a, sa, RIGHT)).body.held, true);
  const ra = await answer(lin, a, sa, { tones: true });
  assert.deepEqual([ra.body.review.verdict, ra.body.review.rating, ra.body.toneMiss], ["exact", 3, null]);
  // Missed, but the answer doesn't say tones: unchanged.
  const b = await speakItem(lin, "妈妈", "mother");
  const sb = crypto.randomUUID();
  await score(lin, b, sb, clip([1, 4]));
  const rb = await answer(lin, b, sb, { answer: "妈妈" });
  assert.deepEqual([rb.body.review.verdict, rb.body.toneMiss], ["exact", null]);
  // A hold for another submit: unchanged.
  const c = await speakItem(lin, "马", "horse");
  await score(lin, c, crypto.randomUUID(), clip([1]));
  const rc = await answer(lin, c, crypto.randomUUID(), { answer: "马", tones: true });
  assert.deepEqual([rc.body.review.verdict, rc.body.toneMiss], ["exact", null]);
  // Other words (the grader's stand-in answers nothing usable: wrong):
  // a wrong answer is never about its tones.
  const e = await speakItem(lin, "八", "eight");
  const se = crypto.randomUUID();
  assert.equal((await score(lin, e, se, MISSED)).body.held, true);
  const re = await answer(lin, e, se, { answer: "你好", tones: true });
  assert.deepEqual([re.body.review.verdict, re.body.review.rating, re.body.toneMiss], ["wrong", 1, null]);
  // tones only with speak-it, a boolean; phrase and submit together.
  const d = await speakItem(lin, "吗", "question particle");
  assert.equal((await answer(lin, { ...d, drill: "flashcard" }, crypto.randomUUID(), { tones: true })).status, 400);
  assert.equal((await answer(lin, d, crypto.randomUUID(), { tones: "yes" })).status, 400);
  assert.equal((await lin.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("吗")}&phrase=${d.phraseId}`, RIGHT, { "Content-Type": "audio/wav" })).status, 400);
  assert.equal((await score(lin, { ...d, text: "吗" }, crypto.randomUUID(), RIGHT, "&readings=all")).status, 400);
});
