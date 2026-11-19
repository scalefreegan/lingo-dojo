// POST /api/pronunciation/score end to end (web/server/pronunciation.ts,
// ld-ne0.2): a WAV scored against known Han text for the active learner's
// language. Mandarin only; validated before any provider call; an adult
// with Azure keys is assessed by Azure (stubbed in fetch here: nothing
// reaches the network) with the local tone check on its timings; a kids
// learner's audio never goes to Azure, whatever keys are set; no keys, an
// Azure failure, a busy slot or the per-minute cap all fall back to the
// local scorer, never an error. The real plugin on an in-process PGlite;
// the clips are generated (scripts/pronunciation-synth.mjs). Every name
// here is made up.
//   node --test scripts/tests/pronunciation.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "../pronunciation.mjs";
import { AZURE_PER_MINUTE } from "../pronunciation-app.mjs";
import { speak } from "../pronunciation-synth.mjs";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-pron-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const withAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "AZURE_SPEECH_KEY=test-key\nAZURE_SPEECH_REGION=eastus\n");
const withoutAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
withAzure();

/* Azure, stubbed: every call is recorded; `azure` answers it. By default a
 * reply that times each character where the clip put it (one "phoneme" per
 * syllable, as the live zh-CN service does). Any other host is refused:
 * nothing in this file may reach the network. */
const azureCalls = [];
let azure = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (!url.hostname.endsWith(".stt.speech.microsoft.com")) throw new Error(`unexpected fetch to ${url.hostname}`);
  const header = JSON.parse(Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"));
  azureCalls.push({ url: url.toString(), reference: header.ReferenceText, bytes: init.body.length });
  return azure(header.ReferenceText);
};

/** A reply timing each character of `text` at `timings`. */
function azureReply(text, timings, { score = 90 } = {}) {
  const ticks = (ms) => Math.round(ms * 10_000);
  const words = [...text].map((ch, i) => ({
    Word: ch, Offset: ticks(timings[i].startMs), Duration: ticks(timings[i].endMs - timings[i].startMs), AccuracyScore: score, ErrorType: "None",
    Phonemes: [{ Phoneme: "x 1", Offset: ticks(timings[i].startMs), Duration: ticks(timings[i].endMs - timings[i].startMs), AccuracyScore: score }],
  }));
  return new Response(JSON.stringify({ RecognitionStatus: "Success", DisplayText: text, NBest: [{ Display: text, PronScore: score, AccuracyScore: score, Words: words }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

const { apiPlugins } = await import("../../web/server/api.ts");

const testDb = await freshDb();
let base, close;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  globalThis.fetch = realFetch;
  await close();
  await testDb.close();
});

const MANDARIN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };
const KID_MANDARIN = { ...KID, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };

let n = 0;
async function someone(learners = [MANDARIN]) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}

/** A generated voice saying `shapes` (tones), 300 ms of quiet around it. */
function clip(shapes) {
  const { samples, timings } = speak(shapes, { gaps: [300, ...shapes.slice(1).map(() => 80), 300] });
  return { wav: new Uint8Array(encodeWav(samples, 16_000)), timings };
}
const score = (who, text, wav, type = "audio/wav") => who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}`, wav, { "Content-Type": type });

test("a score needs a session and the page's own learner; another language is not available", async () => {
  const { wav } = clip([4]);
  assert.equal((await score(client(base), "大", wav)).status, 401);
  await addUser(testDb.db, "nopick", undefined, { learners: [MANDARIN] });
  const unpicked = client(base);
  await unpicked.login("nopick");
  const r = await score(unpicked, "大", wav);
  assert.deepEqual([r.status, r.body.code], [409, "stale_learner"]);
  const spanish = await someone([ADULT]);
  const before = azureCalls.length;
  const no = await score(spanish, "大", wav);
  assert.deepEqual([no.status, no.body.code], [422, "not_available"]);
  assert.match(no.body.error, /aren't available for this language/);
  assert.equal(azureCalls.length, before, "nothing sent for a language that isn't scored");
  const lin = await someone();
  assert.equal((await lin.call("GET", "/api/pronunciation/score")).status, 405);
  assert.equal((await lin.call("POST", "/api/pronunciation/other", wav, { "Content-Type": "audio/wav" })).status, 404);
});

test("text and audio are validated before any provider call", async () => {
  withAzure();
  const lin = await someone();
  const { wav } = clip([4]);
  const before = azureCalls.length;
  for (const bad of ["", "hello", "大a", "我有3个", "😀", "一".repeat(25)]) {
    const r = await score(lin, bad, wav);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await score(lin, "大", wav, "audio/webm")).status, 415);
  assert.equal((await score(lin, "大", new TextEncoder().encode("not a wav file, just some bytes that are long enough to look like one"))).status, 415);
  assert.equal((await score(lin, "大", new Uint8Array(encodeWav(new Float32Array(44_100), 44_100)))).status, 415, "44.1 kHz");
  assert.equal((await score(lin, "大", new Uint8Array(encodeWav(new Float32Array(1_600), 16_000)))).status, 400, "0.1 s");
  assert.equal((await score(lin, "大", new Uint8Array(encodeWav(new Float32Array(16_000 * 31), 16_000)))).status, 413, "31 s");
  assert.equal((await score(lin, "大", new Uint8Array(2 << 20))).status, 413, "a body past the cap");
  assert.equal(azureCalls.length, before);
});

test("an adult with Azure keys: Azure's timings, the local tone check on them", async () => {
  withAzure();
  const lin = await someone();
  const right = clip([4]);
  azure = (text) => azureReply(text, right.timings);
  const before = azureCalls.length;
  const r = await score(lin, "大", right.wav);
  assert.equal(r.status, 200, r.text);
  assert.equal(azureCalls.length, before + 1);
  assert.equal(azureCalls.at(-1).reference, "大");
  assert.match(azureCalls.at(-1).url, /^https:\/\/eastus\.stt\.speech\.microsoft\.com\/.*language=zh-CN/);
  assert.equal(r.body.engine, "azure");
  assert.equal(r.body.fallback, null);
  assert.equal(r.body.locale, "zh-CN");
  const [s] = r.body.syllables;
  assert.deepEqual([s.char, s.pinyin, s.expectedTone, s.verdict], ["大", "dà", 4, "ok"]);
  assert.equal(s.heardTone, undefined, "no heard tone on an ok");
  assert.equal(s.heard.length, 16);
  assert.equal(s.reference.length, 16);
  assert.equal(typeof r.body.overall, "number");

  const wrong = clip([1]);
  azure = (text) => azureReply(text, wrong.timings);
  const w = await score(lin, "大", wrong.wav);
  assert.equal(w.status, 200, w.text);
  assert.deepEqual([w.body.syllables[0].verdict, w.body.syllables[0].heardTone, w.body.syllables[0].why], ["off", 1, "tone"]);

  // A short single syllable on Azure's timings: the engine judges it but
  // draws no curve (too few frames for a range of its own); the worker
  // draws it from the whole track, so the picture still has a line.
  const { samples, timings } = speak([1], { ms: 200, gaps: [300, 300] });
  azure = (text) => azureReply(text, timings);
  const short = await score(lin, "大", new Uint8Array(encodeWav(samples, 16_000)));
  assert.equal(short.status, 200, short.text);
  assert.equal(short.body.syllables[0].verdict, "off");
  assert.ok(short.body.syllables[0].heard.filter((v) => typeof v === "number").length >= 2, JSON.stringify(short.body.syllables[0].heard));
});

test("a kids learner's audio never goes to Azure, whatever keys are set", async () => {
  withAzure();
  const mei = await someone([KID_MANDARIN]);
  const { wav, timings } = clip([4]);
  azure = (text) => azureReply(text, timings);
  const before = azureCalls.length;
  const r = await score(mei, "大", wav);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.engine, r.body.fallback, r.body.overall], ["local", "kids", null]);
  assert.equal(r.body.syllables.length, 1);
  // A page claiming adult mode changes nothing: the mode is the session's.
  const claimed = await mei.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}&mode=adult`, wav, { "Content-Type": "audio/wav" });
  assert.equal(claimed.status, 400);
  assert.equal(azureCalls.length, before, "not one call to Azure for a child");
});

test("no Azure keys: the local scorer", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const { wav } = clip([4]);
    const before = azureCalls.length;
    const r = await score(lin, "大", wav);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.engine, r.body.fallback, r.body.syllables[0].verdict], ["local", "no_keys", "ok"]);
    assert.equal(azureCalls.length, before);
  } finally {
    withAzure();
  }
});

test("Azure failing, refusing or hearing nothing: the local scorer answers, never an error", async () => {
  withAzure();
  const lin = await someone();
  const { wav } = clip([4]);
  for (const fail of [
    () => new Response("{}", { status: 500 }),
    () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    () => new Response(JSON.stringify({ RecognitionStatus: "NoMatch" }), { status: 200 }),
    () => new Response("not json", { status: 200 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    azure = fail;
    const r = await score(lin, "大", wav);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.engine, r.body.fallback], ["local", "failed"]);
    assert.ok(!JSON.stringify(r.body).includes("test-key"));
  }
});

test("past the per-minute cap, the local scorer answers", async () => {
  withAzure();
  const lin = await someone();
  const { wav, timings } = clip([4]);
  azure = (text) => azureReply(text, timings);
  const before = azureCalls.length;
  for (let i = 0; i < AZURE_PER_MINUTE; i++) assert.equal((await score(lin, "大", wav)).body.engine, "azure");
  const r = await score(lin, "大", wav);
  assert.deepEqual([r.status, r.body.engine, r.body.fallback], [200, "local", "limit"]);
  assert.equal(azureCalls.length, before + AZURE_PER_MINUTE);
  // Another user has a cap of their own.
  assert.equal((await score(await someone(), "大", wav)).body.engine, "azure");
});

test("a phrase: one syllable per character, punctuation kept out", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const { wav } = clip([2, 3]);
    const r = await score(lin, "你好！", wav);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.syllables.map((s) => [s.char, s.expectedTone]), [["你", 2], ["好", 3]]);
    assert.equal(r.body.text, "你好！");
  } finally {
    withAzure();
  }
});
