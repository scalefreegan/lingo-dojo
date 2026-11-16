// The listening and speak-it drills end to end over HTTP
// (web/server/practice.ts): the phrase audio route and its disk cache, a
// listening card's choices and typed answers, a speak-it recording's
// transcription (no expected answer sent to the recogniser) and answer,
// the stale-answer protocol for both, per-mode stats, and who may see
// what. The real plugin on an in-process PGlite, a stand-in `claude` first
// on PATH, and ElevenLabs stubbed in fetch: nothing here reaches a
// provider. The cache lives in a temp dir (LINGO_DATA_DIR), never data/.
// Every name here is made up.
//   node --test scripts/tests/practice-drills.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const audioDir = path.join(dataDir, "audio");

/* ElevenLabs, stubbed: speech is "MP3:<voice>:<text>"; a transcription
 * answers `stt.reply` (or fails with `stt.status`) and keeps the form. */
const synths = [];
const stt = { reply: "", status: 200, forms: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  const voice = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (url.pathname.startsWith("/v1/text-to-speech/")) {
    const { text, model_id } = JSON.parse(init.body);
    synths.push({ voice, text, model_id });
    return new Response(`MP3:${voice}:${text}`, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.pathname === "/v1/speech-to-text") {
    const form = init.body;
    stt.forms.push({ keyterms: form.getAll("keyterms"), language: form.get("language_code"), model: form.get("model_id") });
    if (stt.status !== 200) return new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), { status: stt.status });
    return new Response(JSON.stringify({ text: stt.reply }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};

const { apiPlugins } = await import("../../web/server/api.ts");

const fake = fakeClaude();
const ACCEPT = JSON.stringify({ accepted: true, rating_hint: "good", note: "Another natural way to say it." });
const REJECT = JSON.stringify({ accepted: false, rating_hint: "hard", note: "That means something else." });

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  fake.restore();
  globalThis.fetch = realFetch;
  await close();
  await testDb.close();
});
beforeEach(() => {
  fake.answer(ACCEPT);
  stt.reply = "";
  stt.status = 200;
});

let n = 0;
/** A fresh account with these learners, logged in, the first picked, its
 *  voices set up: ElevenLabs both ways, a Mexican Spanish narrator. */
async function someone(learners = [ADULT], { voices = true } = {}) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  if (voices) {
    const r = await c.call("PUT", "/api/voice/settings", { tts: "elevenlabs", stt: "elevenlabs", voices: { elevenlabs: { "es-MX": { "narrator:female": `voice-${name}` } } } });
    assert.equal(r.status, 200, r.text);
  }
  return c;
}

/** Phrases added by hand, each with a meaning. */
async function add(who, pairs) {
  const out = {};
  for (const [text, meaning] of pairs) {
    const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
    assert.equal(r.status, 201, r.text);
    out[text] = r.body.phrase;
  }
  return out;
}

const PAIRS = [["la vuelta", "the change"], ["¿Cuánto cuesta?", "How much is it?"], ["el kilo", "a kilo"], ["adiós", "goodbye"], ["la cuenta", "the bill"]];
const TZ = -420;
const queue = (who, qs) => who.call("GET", `/api/practice/queue?tz=${TZ}${qs}`);
const answer = (who, item, body, submitId = crypto.randomUUID()) =>
  who.call("POST", "/api/practice/answer", { phraseId: item.phraseId, skill: item.skill, drill: item.drill, version: item.version, revision: item.revision, submitId, tz: TZ, ...body });
const reviewsOf = (phraseId) => q("select r.*, c.skill from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1 order by r.id", [phraseId]);
const transcribe = (who, bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3])) => who.call("POST", "/api/practice/transcribe", bytes, { "Content-Type": "audio/wav" });

test("a listening queue: the listen card, no words or meaning on the wire, four meanings from the same bank", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS);
  const r = await queue(sam, "&mode=listening&length=5");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.items.length, 5);
  const meanings = PAIRS.map(([, m]) => m);
  for (const item of r.body.items) {
    assert.deepEqual([item.skill, item.drill, item.text, item.meaning], ["listen", "listening", "", ""]);
    assert.equal(item.choices.length, 4);
    assert.ok(item.choices.every((c) => meanings.includes(c)));
    const own = Object.values(p).find((x) => x.id === item.phraseId);
    assert.ok(item.choices.includes(own.meaning));
    assert.ok(!r.text.includes(own.text), "the words never travel before the answer");
  }
  // A bank too small for distractors: typed (choices null).
  const solo = await someone();
  await add(solo, PAIRS.slice(0, 2));
  const [only] = (await queue(solo, "&mode=listening")).body.items;
  assert.equal(only.choices, null);
});

test("phrase audio: the user's voice for the language, synthesized once, then served from the cache on disk", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS.slice(0, 1));
  const id = p["la vuelta"].id;
  const before = synths.length;
  const first = await sam.call("GET", `/api/practice/audio/${id}`);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers.get("content-type"), "audio/mpeg");
  assert.equal(first.headers.get("x-audio-cache"), "miss");
  assert.match(first.headers.get("cache-control"), /no-store/);
  assert.equal(first.text, `MP3:voice-user${n}:la vuelta`);
  assert.equal(synths.length, before + 1);
  const files = fs.readdirSync(audioDir).filter((f) => f.endsWith(".mp3"));
  assert.ok(files.length >= 1 && files.every((f) => /^[0-9a-f]{64}\.mp3$/.test(f)), "named by the key, in the temp data dir");
  const again = await sam.call("GET", `/api/practice/audio/${id}`);
  assert.deepEqual([again.status, again.headers.get("x-audio-cache"), again.text], [200, "hit", first.text]);
  assert.equal(synths.length, before + 1, "no second synthesis");
  // Another voice is another file (and another synthesis).
  await sam.call("PUT", "/api/voice/settings", { voices: { elevenlabs: { "es-MX": { "narrator:female": "other-voice" } } } });
  const other = await sam.call("GET", `/api/practice/audio/${id}`);
  assert.deepEqual([other.headers.get("x-audio-cache"), other.text], ["miss", "MP3:other-voice:la vuelta"]);
  // Editing the words is new audio, never the old.
  await sam.call("PATCH", `/api/phrases/${id}`, { text: "la vuelta, por favor" });
  const edited = await sam.call("GET", `/api/practice/audio/${id}`);
  assert.deepEqual([edited.headers.get("x-audio-cache"), edited.text], ["miss", "MP3:other-voice:la vuelta, por favor"]);
});

test("phrase audio is only for this language's own phrases: another account's id, a bad id, no voice set", async () => {
  const sam = await someone();
  const robin = await someone();
  const p = await add(sam, PAIRS.slice(0, 1));
  const id = p["la vuelta"].id;
  assert.equal((await sam.call("GET", `/api/practice/audio/${id}`)).status, 200);
  // Robin can't hear (or probe the cache for) Sam's phrase.
  const theirs = await robin.call("GET", `/api/practice/audio/${id}`);
  assert.equal(theirs.status, 404);
  assert.doesNotMatch(theirs.text, /vuelta/);
  for (const bad of ["../../etc/passwd", "x", "0".repeat(64), `${id}.mp3`]) {
    assert.equal((await robin.call("GET", `/api/practice/audio/${encodeURIComponent(bad)}`)).status, 404, bad);
  }
  assert.equal((await sam.call("POST", `/api/practice/audio/${id}`)).status, 405);
  // Another of Sam's languages doesn't own it either.
  await sam.addLanguage({ target_language: "French", target_variant: "", level: "A1" });
  assert.equal((await sam.call("GET", `/api/practice/audio/${id}`)).status, 404);
  // No voice picked for the language: a 400 that says where.
  const fresh = await someone([ADULT], { voices: false });
  await fresh.call("PUT", "/api/voice/settings", { tts: "elevenlabs" });
  const f = await add(fresh, PAIRS.slice(0, 1));
  const none = await fresh.call("GET", `/api/practice/audio/${f["la vuelta"].id}`);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /voice settings/);
});

test("a listening choice: right is Good and wrong is Again at once (no model check), recorded on the listen card as mode listening, words in the reply", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS);
  const items = (await queue(sam, "&mode=listening&length=5")).body.items;
  const [a, b] = items;
  const meaningOf = (item) => Object.values(p).find((x) => x.id === item.phraseId).meaning;
  const runs = fake.runs();
  const right = await answer(sam, a, { choice: meaningOf(a), durationMs: 2000 });
  assert.equal(right.status, 200, right.text);
  assert.deepEqual([right.body.review.verdict, right.body.review.rating, right.body.review.answer], ["exact", 3, meaningOf(a)]);
  const own = Object.values(p).find((x) => x.id === a.phraseId);
  assert.deepEqual(right.body.expected, { text: own.text, meaning: own.meaning });
  const wrongChoice = b.choices.find((c) => c !== meaningOf(b));
  const wrong = await answer(sam, b, { choice: wrongChoice });
  assert.deepEqual([wrong.body.review.verdict, wrong.body.review.rating], ["wrong", 1]);
  assert.equal(fake.runs(), runs, "no grader for a choice");
  const [row] = await reviewsOf(a.phraseId);
  assert.deepEqual([row.mode, row.skill, row.verdict, row.answer, row.duration_ms], ["listening", "listen", "exact", meaningOf(a), 2000]);
  // Today's progress counts them; the listen cards are no longer new.
  const s = (await sam.call("GET", `/api/practice?tz=${TZ}&mode=listening`)).body.stats;
  assert.deepEqual([s.done.new, s.new], [2, 3]);
});

test("a listening answer's stale protocol: a resend replays, another submit at that version is a 409, an edit since is a 409, an override regrades", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS);
  const [item, other] = (await queue(sam, "&mode=listening&length=5")).body.items;
  const submitId = crypto.randomUUID();
  const meaning = Object.values(p).find((x) => x.id === item.phraseId).meaning;
  const first = await answer(sam, item, { choice: meaning }, submitId);
  const again = await answer(sam, item, { choice: meaning }, submitId);
  assert.deepEqual([again.status, again.body.replayed, again.body.review.id], [200, true, first.body.review.id]);
  const tabTwo = await answer(sam, item, { choice: meaning });
  assert.equal(tabTwo.status, 409);
  assert.equal((await reviewsOf(item.phraseId)).length, 1);
  // Override: Again, then the card is restored and reviewed as that.
  const o = await sam.call("POST", `/api/practice/reviews/${first.body.review.id}/override`, { rating: 1, tz: TZ });
  assert.equal(o.status, 200, o.text);
  assert.deepEqual([o.body.review.rating, o.body.review.verdict], [1, "self"]);
  // An edit of the phrase since the card was shown: refused before grading.
  await sam.call("PATCH", `/api/phrases/${other.phraseId}`, { meaning: "something else" });
  const edited = await answer(sam, other, { choice: other.choices[0] });
  assert.equal(edited.status, 409);
  assert.match(edited.body.error, /edited/);
});

test("a typed listening answer: the words heard or the meaning match locally; a miss asks the grader as a heard phrase", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS);
  const items = (await queue(sam, "&mode=listening&length=5")).body.items;
  const byText = (t) => items.find((i) => i.phraseId === p[t].id);
  const runs = fake.runs();
  const words = await answer(sam, byText("la vuelta"), { answer: "La vuelta" });
  assert.deepEqual([words.body.review.verdict, words.body.review.rating], ["exact", 3]);
  const meaning = await answer(sam, byText("adiós"), { answer: "goodbye" });
  assert.equal(meaning.body.review.verdict, "exact");
  assert.equal(fake.runs(), runs);
  fake.answer(REJECT);
  const miss = await answer(sam, byText("el kilo"), { answer: "a pound" });
  assert.deepEqual([miss.body.review.verdict, miss.body.review.rating, miss.body.review.note], ["wrong", 1, "That means something else."]);
  assert.equal(fake.runs(), runs + 1);
  const prompt = fake.lastArgs().join("\n");
  assert.match(prompt, /heard a phrase in Mexican Spanish \(they were not shown it\)/);
  assert.match(prompt, /Phrase the learner heard: el kilo/);
  // "I don't know": an empty answer is wrong, no grader.
  const blank = await answer(sam, byText("la cuenta"), { answer: "" });
  assert.deepEqual([blank.body.review.verdict, fake.runs()], ["wrong", runs + 1]);
});

test("speak-it: transcribed with no hint of the answer, then graded as spoken; recorded as mode speak on the produce card", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS);
  const items = (await queue(sam, "&mode=speak&length=5")).body.items;
  assert.ok(items.every((i) => i.skill === "produce" && i.drill === "speak" && i.choices === null && i.text && i.meaning));
  const item = items.find((i) => i.phraseId === p["¿Cuánto cuesta?"].id);
  stt.reply = "  cuanto cuesta ";
  const heard = await transcribe(sam);
  assert.equal(heard.status, 200, heard.text);
  assert.deepEqual(heard.body, { text: "cuanto cuesta" });
  const form = stt.forms.at(-1);
  assert.deepEqual([form.keyterms, form.language, form.model], [[], "es", "scribe_v2"], "no keyterms: the recogniser isn't told what to expect");
  assert.equal((await reviewsOf(item.phraseId)).length, 0, "transcribing records nothing");
  const runs = fake.runs();
  const r = await answer(sam, item, { answer: heard.body.text });
  assert.equal(r.status, 200, r.text);
  // No accent from the recogniser is no fault of the learner's: exact.
  assert.deepEqual([r.body.review.verdict, r.body.review.rating, r.body.review.answer, fake.runs()], ["exact", 3, "cuanto cuesta", runs]);
  const [row] = await reviewsOf(item.phraseId);
  assert.deepEqual([row.mode, row.skill], ["speak", "produce"]);
  // A miss: the grader is told it is a transcript; an accepted transcript is not kept as an alternate.
  const other = items.find((i) => i.phraseId === p["la cuenta"].id);
  const accepted = await answer(sam, other, { answer: "la nota" });
  assert.deepEqual([accepted.body.review.verdict, accepted.body.alternateAdded], ["accepted", false]);
  assert.match(fake.lastArgs().join("\n"), /speech-to-text transcript/);
  const bank = (await sam.call("GET", `/api/phrases/${other.phraseId}`)).body.phrase;
  assert.deepEqual(bank.alternates, []);
  // The override works as for a flashcard.
  const o = await sam.call("POST", `/api/practice/reviews/${accepted.body.review.id}/override`, { rating: 1, tz: TZ });
  assert.deepEqual([o.status, o.body.review.rating], [200, 1]);
});

test("speak-it failures record nothing: nothing heard, an empty answer, a provider error, no audio", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS.slice(0, 2));
  const [item] = (await queue(sam, "&mode=speak&length=5")).body.items;
  stt.reply = "";
  const silent = await transcribe(sam);
  assert.deepEqual([silent.status, silent.body], [200, { text: "" }]);
  const empty = await answer(sam, item, { answer: "   " });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /nothing was heard/);
  stt.status = 429;
  const failed = await transcribe(sam);
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /ElevenLabs answered 429/);
  assert.doesNotMatch(failed.text, /test-key/);
  const noAudio = await sam.call("POST", "/api/practice/transcribe", new Uint8Array(0), { "Content-Type": "audio/wav" });
  assert.equal(noAudio.status, 400);
  for (const phrase of Object.values(p)) assert.equal((await reviewsOf(phrase.id)).length, 0);
  // Typed instead: a produce flashcard (mode flashcard), same card and version.
  const typed = await answer(sam, item, { drill: "flashcard", answer: Object.values(p).find((x) => x.id === item.phraseId).text });
  assert.equal(typed.status, 200, typed.text);
  assert.equal((await reviewsOf(item.phraseId))[0].mode, "flashcard");
});

test("mixed: recognize as a flashcard first, then listen or speak; a phrase with several cards due is one card and counts once", async () => {
  const sam = await someone();
  const p = await add(sam, PAIRS.slice(0, 2));
  const first = (await queue(sam, "&mode=mixed&length=5")).body.items;
  assert.deepEqual(first.map((i) => [i.skill, i.drill]), [["recognize", "flashcard"], ["recognize", "flashcard"]]);
  for (const item of first) await answer(sam, item, { answer: Object.values(p).find((x) => x.id === item.phraseId).meaning });
  const next = (await queue(sam, "&mode=mixed&length=5")).body.items;
  assert.deepEqual(next.map((i) => [i.skill, i.drill]), [["listen", "listening"], ["listen", "listening"]]);
  // Every card of one phrase due at once: still one card, counted once.
  const id = p["la vuelta"].id;
  for (const skill of ["listen", "produce"]) {
    await q("insert into cards (phrase_id, learner_id, language_profile_id, skill) values ($1, $2, $3, $4) on conflict do nothing", [id, sam.learnerId, sam.languageId, skill]);
  }
  await q("update cards set reps = 1, state = 2, last_review = now() - interval '3 days', due = now() - interval '1 day' where phrase_id = $1", [id]);
  const stats = (await sam.call("GET", `/api/practice?tz=${TZ}&mode=mixed`)).body.stats;
  assert.equal(stats.due, 1);
  const items = (await queue(sam, "&mode=mixed&length=20")).body.items.filter((i) => i.phraseId === id);
  assert.equal(items.length, 1);
});

test("kids learners: every practice route, the audio and the transcription included, is a 403", async () => {
  const pip = await someone([KID, ADULT], { voices: false });
  for (const [method, url, body] of [
    ["GET", `/api/practice?tz=${TZ}&mode=listening`],
    ["GET", `/api/practice/queue?mode=speak`],
    ["GET", `/api/practice/audio/${crypto.randomUUID()}`],
    ["POST", "/api/practice/transcribe", new Uint8Array([1, 2, 3])],
  ]) {
    const r = await pip.call(method, url, body, body ? { "Content-Type": "audio/wav" } : {});
    assert.equal(r.status, 403, `${method} ${url}`);
  }
});
