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
 * section never waits for it). While `accepting` (a file beside it) it is
 * a grader that accepts the answer, for a synonym. */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-tone-review-claude-"));
const acceptFlag = path.join(bin, "accepting");
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const result = fs.existsSync(${JSON.stringify(acceptFlag)}) ? JSON.stringify({ accepted: true, rating_hint: "good", note: "Same meaning." }) : "NARRATOR-F: <t>好。</t>";
process.stdout.write(JSON.stringify({ type: "result", result }));
`,
  { mode: 0o755 },
);
/** Run `fn` with the stand-in grader accepting. */
async function accepting(fn) {
  fs.writeFileSync(acceptFlag, "");
  try {
    return await fn();
  } finally {
    fs.rmSync(acceptFlag, { force: true });
  }
}
const savedPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${savedPath}`;

const { apiPlugins } = await import("../../web/server/api.ts");
const { clearLive } = await import("../../web/server/livePronunciation.ts");
const { PRACTICE_HOLD, clearPracticeTones, peekPracticeTones } = await import("../../web/server/toneReview.ts");
const { checksOf } = await import("../db/pronunciation.ts");
const { saveRecapReading } = await import("../db/readings.ts");
const { rereadPhrases } = await import("../../web/server/readings.ts");

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
  // A rate: 1 of 4 now against 2 of 3, fewer flagged (the counts alone
  // would say so for a shorter session too).
  assert.deepEqual(t.vsLast.flagged, { now: { off: 1, checked: 4 }, was: { off: 2, checked: 3 }, move: "up" });
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
// Every negative case below starts from a score whose flags are held
// (asserted first), so a guard that is removed shows as a miss recorded.

const heldFlags = (who) => peekPracticeTones(who.learnerId, who.languageId);
async function speakItem(who, text = "妈", meaning = "mum") {
  const p = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
  assert.equal(p.status, 201, p.text);
  return itemOf(who, p.body.phrase.id);
}
async function itemOf(who, phraseId) {
  const items = (await who.call("GET", "/api/practice/queue?mode=speak&length=20&tz=0")).body.items;
  const item = items.find((i) => i.phraseId === phraseId);
  assert.ok(item, JSON.stringify(items));
  return item;
}
const score = (who, item, submitId, wav, { text = item.text, phrase = item.phraseId, extra = "" } = {}) =>
  who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}&phrase=${phrase}&submit=${submitId}${extra}`, wav, { "Content-Type": "audio/wav" });
const answer = (who, item, submitId, body) =>
  who.call("POST", "/api/practice/answer", { phraseId: item.phraseId, skill: item.skill, drill: item.drill, version: item.version, revision: item.revision, submitId, tz: 0, answer: item.text, ...body });
/** Score `wav` for `item` under `submitId` and check a flag is held. */
async function heldMiss(who, item, submitId, wav = MISSED, opts) {
  const s = await score(who, item, submitId, wav, opts);
  assert.equal(s.status, 200, s.text);
  assert.equal(s.body.held, true);
  assert.ok(heldFlags(who)?.length > 0, `a flag is held: ${JSON.stringify(heldFlags(who))}`);
  return s.body;
}
/** A card's FSRS state, its due as an interval after its last review (two
 *  answers a moment apart then compare). */
async function cardOf(phraseId) {
  const [c] = await q("select state, reps, lapses, stability, stability_fast, difficulty, scheduled_days, learning_steps, due, last_review from cards where phrase_id = $1 and skill = 'produce'", [phraseId]);
  const { due, last_review: last, ...rest } = c;
  return { ...rest, interval: new Date(due).getTime() - new Date(last).getTime() };
}
/** The card put in the review state, last reviewed at `last`. */
async function reviewState(phraseId, last) {
  await q(
    "update cards set state = 2, reps = 4, lapses = 0, stability = 12, stability_fast = null, difficulty = 5, scheduled_days = 12, learning_steps = 0, last_review = $2, due = $2::timestamptz + interval '12 days' where phrase_id = $1 and skill = 'produce'",
    [phraseId, last],
  );
}

/**
 * A tone miss recorded, replayed, then I said it right, against a control
 * learner who said it right with no tone check: after the override the two
 * cards are the same card. `review`: both cards start in the review state.
 */
async function missThenRestore({ review }) {
  const lin = await someone();
  const ctl = await someone();
  let item = await speakItem(lin);
  let control = await speakItem(ctl);
  if (review) {
    // A first answer makes each card; then both are put in one review state.
    for (const [who, it] of [[lin, item], [ctl, control]]) assert.equal((await answer(who, it, crypto.randomUUID(), {})).status, 200);
    const last = new Date(Date.now() - 12 * 86_400_000).toISOString();
    await reviewState(item.phraseId, last);
    await reviewState(control.phraseId, last);
    item = await itemOf(lin, item.phraseId);
    control = await itemOf(ctl, control.phraseId);
  }
  const submitId = crypto.randomUUID();
  const s = await heldMiss(lin, item, submitId);
  assert.deepEqual(s.syllables.map((x) => [x.verdict, x.heardTone]), [["off", 4]]);
  const r = await answer(lin, item, submitId, { tones: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.review.verdict, r.body.review.rating], ["wrong", 1]);
  assert.deepEqual(r.body.toneMiss, { rating: 3, verdict: "exact", syllables: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }] });
  // A resend (the reply lost): the same review and reason, nothing new.
  const reviews = async () => (await q("select count(*)::int as count from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1", [item.phraseId]))[0].count;
  const had = await reviews();
  const again = await answer(lin, item, submitId, { tones: true });
  assert.deepEqual([again.status, again.body.replayed, again.body.review.id, again.body.toneMiss], [200, true, r.body.review.id, r.body.toneMiss]);
  assert.equal(await reviews(), had);
  // The control: the same words said right, no tone check.
  const c = await answer(ctl, control, crypto.randomUUID(), {});
  assert.deepEqual([c.body.review.verdict, c.body.review.rating], ["exact", 3]);
  const good = await cardOf(control.phraseId);
  assert.notDeepEqual(await cardOf(item.phraseId), good, "the miss left the card elsewhere");
  // I said it right: the grade the words had.
  const o = await lin.call("POST", `/api/practice/reviews/${r.body.review.id}/override`, { rating: r.body.toneMiss.rating, tz: 0 });
  assert.equal(o.status, 200, o.text);
  assert.deepEqual([o.body.review.rating, o.body.review.verdict], [3, "self"]);
  assert.deepEqual(o.body.toneMiss, r.body.toneMiss, "the reason stays with the review");
  assert.deepEqual(await cardOf(item.phraseId), good, "the card is the control's");
}

test("speak-it: right words with a flagged tone are a miss; a replay says the same; I said it right restores a new card", async () => {
  await missThenRestore({ review: false });
});

test("speak-it: the same for a card in the review state", async () => {
  await missThenRestore({ review: true });
});

/** A fresh learner with 妈, a flag held, then the answer. */
async function negative({ answerBody = {}, scoreOpts, heldSubmit, before } = {}) {
  const lin = await someone();
  const item = await speakItem(lin);
  const submitId = crypto.randomUUID();
  await heldMiss(lin, item, heldSubmit ?? submitId, MISSED, scoreOpts);
  before?.();
  const r = await answer(lin, item, submitId, answerBody);
  assert.equal(r.status, 200, r.text);
  return r.body;
}
const unchanged = (b) => assert.deepEqual([b.review.verdict, b.review.rating, b.toneMiss], ["exact", 3, null]);

test("speak-it: a held flag fails nothing without tones, for another submit, another phrase, other characters, or once expired", async () => {
  unchanged(await negative({ answerBody: {} }));
  unchanged(await negative({ answerBody: { tones: true }, heldSubmit: crypto.randomUUID() }));
  // Held for another phrase id, with the same characters: only the id differs.
  unchanged(await negative({ answerBody: { tones: true }, scoreOpts: { phrase: crypto.randomUUID() } }));
  // Held for this phrase's id but other characters (他 tā said falling flags too).
  unchanged(await negative({ answerBody: { tones: true }, scoreOpts: { text: "他" } }));
  const saved = PRACTICE_HOLD.ms;
  try {
    unchanged(await negative({ answerBody: { tones: true }, before: () => (PRACTICE_HOLD.ms = -1) }));
  } finally {
    PRACTICE_HOLD.ms = saved;
  }
});

test("speak-it: an alternate graded exact or a synonym the grader accepted is other words: no tone miss", async () => {
  const lin = await someone();
  const p = await speakItem(lin);
  await q("update phrases set alternates = $2 where id = $1", [p.phraseId, JSON.stringify(["妈妈"])]);
  const item = await itemOf(lin, p.phraseId);
  const s1 = crypto.randomUUID();
  await heldMiss(lin, item, s1);
  const alt = await answer(lin, item, s1, { answer: "妈妈", tones: true });
  assert.deepEqual([alt.body.review.verdict, alt.body.review.rating, alt.body.toneMiss], ["exact", 3, null]);
  // A synonym the grader accepts (妈咪 for 妈), another learner's card.
  const mei = await someone();
  const other = await speakItem(mei);
  const s2 = crypto.randomUUID();
  await heldMiss(mei, other, s2);
  const syn = await accepting(() => answer(mei, other, s2, { answer: "妈咪", tones: true }));
  assert.deepEqual([syn.body.review.verdict, syn.body.review.rating, syn.body.toneMiss], ["accepted", 3, null]);
  // Words the grader refuses: wrong, never about tones.
  const third = await speakItem(lin, "他", "he");
  const s3 = crypto.randomUUID();
  await heldMiss(lin, third, s3);
  const wrong = await answer(lin, third, s3, { answer: "你好", tones: true });
  assert.deepEqual([wrong.body.review.verdict, wrong.body.review.rating, wrong.body.toneMiss], ["wrong", 1, null]);
});

const heardOf = (body) => body.syllables.map((x) => [x.pinyin, x.verdict, x.verdict === "off" ? x.heardTone : null]);
/** Score `wav` for `item` (its own `reading`, as Practice sends it, or
 *  `reading`), check what the engine heard and that one flag is held as
 *  made (the settling happens at answer time), then answer with tones. */
async function heardThenAnswer(who, item, wav, heard, { reading = item.reading } = {}) {
  const submitId = crypto.randomUUID();
  const s = await score(who, item, submitId, wav, { extra: reading ? `&reading=${encodeURIComponent(reading)}` : "" });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(heardOf(s.body), heard, "what the engine heard");
  assert.equal(heldFlags(who)?.length, 1, "one flag held");
  return (await answer(who, item, submitId, { tones: true })).body;
}
/** 空调 said kòng tiáo: the reader reads kōng, the engine hears the fourth tone (kòng's). */
const KONG4 = [["kōng", "off", 4], ["tiáo", "ok", null]];
const airCon = (who) => speakItem(who, "空调", "air conditioner");
const missedOn = (b, chars) => assert.deepEqual([b.review.rating, b.toneMiss?.syllables.map((x) => x.char)], [1, chars]);

test("speak-it: a heard tone another reading of the character has fails nothing unless the reading is settled", async () => {
  const lin = await someone();
  // 空 alone is read kōng; said kòng, a right reading for "free time".
  unchanged(await heardThenAnswer(lin, await speakItem(lin, "空", "free time"), clip([4]), [["kōng", "off", 4]]));
  // 中 alone is read zhōng; said zhòng ("to hit the mark").
  unchanged(await heardThenAnswer(lin, await speakItem(lin, "中", "to hit the mark"), clip([4]), [["zhōng", "off", 4]]));
  unchanged(await heardThenAnswer(lin, await airCon(lin), clip([4, 2]), KONG4));
});

test("speak-it: only the learner's own choice by hand or the shared list settles a reading, read at answer time", async () => {
  // The learner's own choice by hand.
  const lin = await someone();
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kōng tiáo', 'confirmed', 'user')", [lin.learnerId, lin.languageId]);
  missedOn(await heardThenAnswer(lin, await airCon(lin), clip([4, 2]), KONG4), ["空"]);
  // Made between the score and the answer: it counts (read at answer time).
  const ann = await someone();
  const it = await airCon(ann);
  const sub = crypto.randomUUID();
  await score(ann, it, sub, clip([4, 2]));
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kōng tiáo', 'confirmed', 'user')", [ann.learnerId, ann.languageId]);
  missedOn((await answer(ann, it, sub, { tones: true })).body, ["空"]);
  // A recap's guess settles nothing.
  const mei = await someone();
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kōng tiáo', 'confirmed', 'recap')", [mei.learnerId, mei.languageId]);
  unchanged(await heardThenAnswer(mei, await airCon(mei), clip([4, 2]), KONG4));
  // A choice reading it otherwise (kòng) settles nothing for a score of kōng.
  const kai = await someone();
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kòng tiáo', 'corrected', 'user')", [kai.learnerId, kai.languageId]);
  unchanged(await heardThenAnswer(kai, await airCon(kai), clip([4, 2]), KONG4));
  // The shared list's active entry, for everyone.
  await q("insert into shared_readings (key, word, reading, scope, status, source) values ('空调', '空调', 'kōng tiáo', 'all', 'active', 'admin')");
  try {
    const sam = await someone();
    missedOn(await heardThenAnswer(sam, await airCon(sam), clip([4, 2]), KONG4), ["空"]);
  } finally {
    await q("delete from shared_readings where key = '空调'");
  }
});

/** 教室 said jiào shì (a classroom: right, and the reader's reading)
 *  where the score was made against a reading of jiāo. */
const JIAO = [["jiāo", "off", 4], ["shì", "ok", null]];
const classroom = (who) => speakItem(who, "教室", "classroom");

test("speak-it: a reading the page sends, a recap's guess or a GLOSS hint in phrases.reading can't make a miss", async () => {
  // The page's `reading`, for a phrase with none stored: either way round.
  const lin = await someone();
  unchanged(await heardThenAnswer(lin, await airCon(lin), clip([4, 2]), KONG4, { reading: "kōng tiáo" }));
  const ann = await someone();
  unchanged(await heardThenAnswer(ann, await classroom(ann), clip([4, 4]), JIAO, { reading: "jiāo shì" }));
  // A recap's suggestion (unconfirmed) written into phrases.reading by the
  // real path, reaching the queue item Practice scores with.
  const mei = await someone();
  const p = await classroom(mei);
  assert.equal(await saveRecapReading(testDb.db, profileOf(mei), { key: "教室", word: "教室", reading: "jiāo shì", kind: "suggested" }), true);
  assert.equal(await rereadPhrases(profileOf(mei), "zh-CN", "教室"), 1);
  const item = await itemOf(mei, p.phraseId);
  assert.equal(item.reading, "jiāo shì");
  unchanged(await heardThenAnswer(mei, item, clip([4, 4]), JIAO));
  // A GLOSS hint: recordGlosses writes the dojo master's reading to the
  // same column.
  const kai = await someone();
  const g = await classroom(kai);
  await q("update phrases set reading = 'jiāo shì' where id = $1", [g.phraseId]);
  const gi = await itemOf(kai, g.phraseId);
  assert.equal(gi.reading, "jiāo shì");
  unchanged(await heardThenAnswer(kai, gi, clip([4, 4]), JIAO));
});

test("speak-it: a stale queued reading after the learner corrected the word mid-session makes no miss", async () => {
  const lin = await someone();
  const p = await classroom(lin);
  await saveRecapReading(testDb.db, profileOf(lin), { key: "教室", word: "教室", reading: "jiāo shì", kind: "suggested" });
  await rereadPhrases(profileOf(lin), "zh-CN", "教室");
  // The session's queue is loaded with the recap's reading...
  const item = await itemOf(lin, p.phraseId);
  assert.equal(item.reading, "jiāo shì");
  // ...then the learner corrects the word on the character card.
  const fix = await lin.call("POST", "/api/readings", { word: "教室", reading: "jiào shì", kind: "corrected" });
  assert.equal(fix.status, 200, fix.text);
  // The queued item, said as corrected: no miss.
  unchanged(await heardThenAnswer(lin, item, clip([4, 4]), JIAO));
});

test("speak-it: only a leading character with one reading tone can fail: 东西, 医生, 出来, 听听, 尝尝, 只买, 他只买 make no miss (本事: the live bar never flagged its 事 on the synth; the pure test covers it)", async () => {
  const lin = await someone();
  // [text, meaning, shapes]: each said so the engine flags a syllable the
  // rule leaves alone (a later one, or 只 heard as a tone none of its readings has).
  const cases = [
    ["东西", "thing", [1, 4]], ["医生", "doctor", [1, 4]], ["出来", "to come out", [1, 4]],
    ["听听", "to have a listen", [1, 4]], ["尝尝", "to have a taste", [2, 4]],
    ["只买", "only buy", [4, 3]], ["他只买", "he only buys", [1, 4, 3]],
  ];
  for (const [text, meaning, shapes] of cases) {
    const item = await speakItem(lin, text, meaning);
    const submitId = crypto.randomUUID();
    const s = await score(lin, item, submitId, clip(shapes));
    assert.equal(s.status, 200, s.text);
    assert.ok(heldFlags(lin)?.length > 0, `${text}: the engine flagged something: ${JSON.stringify(heardOf(s.body))}`);
    unchanged((await answer(lin, item, submitId, { tones: true })).body);
  }
});

test("speak-it: the learner's own choice outranks the shared list for the same word, both ways", async () => {
  // Own kòng, shared kōng: the score's kōng isn't settled (own wins), so 空
  // said kòng is no miss.
  await q("insert into shared_readings (key, word, reading, scope, status, source) values ('空调', '空调', 'kōng tiáo', 'all', 'active', 'admin')");
  try {
    const lin = await someone();
    await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kòng tiáo', 'corrected', 'user')", [lin.learnerId, lin.languageId]);
    unchanged(await heardThenAnswer(lin, await airCon(lin), clip([4, 2]), KONG4));
  } finally {
    await q("delete from shared_readings where key = '空调'");
  }
  // Own kōng, shared kòng: own settles kōng, so 空 heard falling is a miss.
  await q("insert into shared_readings (key, word, reading, scope, status, source) values ('空调', '空调', 'kòng tiáo', 'all', 'active', 'admin')");
  try {
    const ann = await someone();
    await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '空调', '空调', 'kōng tiáo', 'confirmed', 'user')", [ann.learnerId, ann.languageId]);
    missedOn(await heardThenAnswer(ann, await airCon(ann), clip([4, 2]), KONG4), ["空"]);
  } finally {
    await q("delete from shared_readings where key = '空调'");
  }
});

test("speak-it: in a zh-TW language only the learner's settled reading can make a miss", async () => {
  const TW = { ...MANDARIN, name: "Lan", targetVariant: "Taiwan Mandarin" };
  const lan = await someone([TW]);
  // 他們 with 他 said falling: a clear miss in zh-CN, none here unsettled.
  const item = await speakItem(lan, "他們", "they");
  const s1 = crypto.randomUUID();
  const sc = await score(lan, item, s1, clip([4, 1]));
  assert.equal(sc.status, 200, sc.text);
  assert.equal(sc.body.locale, "zh-TW");
  assert.ok(heldFlags(lan)?.some((f) => f.place === 1), `a flag on 他: ${JSON.stringify(heardOf(sc.body))}`);
  unchanged((await answer(lan, item, s1, { tones: true })).body);
  // Settled by hand (another learner): the miss stands.
  const kim = await someone([{ ...TW, name: "Kim" }]);
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, '他们', '他們', 'tā men', 'confirmed', 'user')", [kim.learnerId, kim.languageId]);
  const it2 = await speakItem(kim, "他們", "they");
  const s2 = crypto.randomUUID();
  await score(kim, it2, s2, clip([4, 1]));
  missedOn((await answer(kim, it2, s2, { tones: true })).body, ["他"]);
});

test("speak-it: in zh-TW a shared entry settles only when it is a Taiwan one", async () => {
  const TW = { ...MANDARIN, name: "Lan", targetVariant: "Taiwan Mandarin" };
  const said = async (who) => {
    const it = await speakItem(who, "他們", "they");
    const sid = crypto.randomUUID();
    await score(who, it, sid, clip([4, 1]));
    assert.ok(heldFlags(who)?.some((f) => f.place === 1), "a flag on 他");
    return (await answer(who, it, sid, { tones: true })).body;
  };
  // An "all" entry (written from a zh-CN profile, say): no miss in zh-TW.
  await q("insert into shared_readings (key, word, reading, scope, status, source) values ('他们', '他們', 'tā men', 'all', 'active', 'admin')");
  try {
    unchanged(await said(await someone([{ ...TW, name: "Ada" }])));
  } finally {
    await q("delete from shared_readings where key = '他们'");
  }
  // A "tw" entry settles.
  await q("insert into shared_readings (key, word, reading, scope, status, source) values ('他们', '他們', 'tā men', 'tw', 'active', 'admin')");
  try {
    missedOn(await said(await someone([{ ...TW, name: "Bea" }])), ["他"]);
  } finally {
    await q("delete from shared_readings where key = '他们'");
  }
});

test("speak-it: tones and the hold's parameters are checked", async () => {
  const lin = await someone();
  const d = await speakItem(lin, "吗", "question particle");
  assert.equal((await answer(lin, { ...d, drill: "flashcard" }, crypto.randomUUID(), { tones: true })).status, 400);
  assert.equal((await answer(lin, d, crypto.randomUUID(), { tones: "yes" })).status, 400);
  assert.equal((await lin.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("吗")}&phrase=${d.phraseId}`, RIGHT, { "Content-Type": "audio/wav" })).status, 400);
  assert.equal((await score(lin, d, crypto.randomUUID(), RIGHT, { extra: "&readings=all" })).status, 400);
});
