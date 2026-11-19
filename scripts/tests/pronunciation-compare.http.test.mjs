// Compare mode end to end (ld-ne0.9): GET /api/pronunciation/model, the
// model clip's analysis made on the server from its own cached audio, and
// the score route's frames for the take. The real plugin on an in-process
// PGlite; ElevenLabs and Azure stubbed in fetch (nothing reaches the
// network). The stand-in narrator "speaks" a generated 16 kHz WAV
// (scripts/pronunciation-synth.mjs), which the decoder takes as it is, so
// no converter runs. The audio cache and its analyses live in a temp dir.
// Every name here is made up.
//   node --test scripts/tests/pronunciation-compare.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-compare-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const withAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\nAZURE_SPEECH_KEY=test-key\nAZURE_SPEECH_REGION=eastus\n");
const withoutAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
withAzure();
const analysisDir = path.join(dataDir, "audio", "analysis");

/** The narrator's tones for each text the tests ask for. */
const SAYS = { 大: [4], 妈: [1], 喝茶: [1, 2], 好: [3] };
/** A generated clip of `tones` and where each syllable is. */
function clip(tones, voice = { lowHz: 210, spanSt: 12, ms: 380, seed: 3 }) {
  const { samples, timings } = speak(tones, { gaps: [300, ...tones.slice(1).map(() => 80), 300], ...voice });
  return { wav: new Uint8Array(encodeWav(samples, 16_000)), timings };
}

/* ElevenLabs and Azure, stubbed. Speech is the generated clip for the text
 * (labelled MP3, as ElevenLabs' is); Azure times each character where the
 * clip it was sent put it (found by the clip's length), or answers
 * `azureAnswer` when a test sets one. */
const synths = [];
const azureCalls = [];
const timingsByLength = new Map();
let azureAnswer = null;
let ttsDelayMs = 0;
/** Azure's delay (ms) by reference text, for tests that need it slow. */
const azureDelay = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.elevenlabs.io" && url.pathname.startsWith("/v1/text-to-speech/")) {
    const { text } = JSON.parse(init.body);
    synths.push(text);
    if (ttsDelayMs) await new Promise((r) => setTimeout(r, ttsDelayMs));
    const c = clip(SAYS[text] ?? [1]);
    timingsByLength.set(c.wav.length, c.timings);
    // The route pads a model clip with 250 ms of silence each side before
    // Azure hears it: the same syllables, 250 ms later.
    timingsByLength.set(c.wav.length + 2 * 250 * 32, c.timings.map((t) => ({ startMs: t.startMs + 250, endMs: t.endMs + 250 })));
    return new Response(c.wav, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.hostname.endsWith(".stt.speech.microsoft.com")) {
    const header = JSON.parse(Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"));
    azureCalls.push({ reference: header.ReferenceText, bytes: init.body.length });
    if (azureDelay[header.ReferenceText]) await sleep(azureDelay[header.ReferenceText]);
    if (azureAnswer) return azureAnswer();
    return azureReply(header.ReferenceText, timingsByLength.get(init.body.length) ?? []);
  }
  throw new Error(`unexpected fetch to ${url.hostname}`);
};

function azureReply(text, timings, score = 88) {
  const ticks = (ms) => Math.round(ms * 10_000);
  const words = [...text].map((ch, i) => ({
    Word: ch, Offset: ticks(timings[i]?.startMs ?? 0), Duration: ticks((timings[i]?.endMs ?? 100) - (timings[i]?.startMs ?? 0)), AccuracyScore: score, ErrorType: "None",
    Phonemes: [{ Phoneme: "x 1", Offset: ticks(timings[i]?.startMs ?? 0), Duration: ticks((timings[i]?.endMs ?? 100) - (timings[i]?.startMs ?? 0)), AccuracyScore: score }],
  }));
  return new Response(JSON.stringify({ RecognitionStatus: "Success", DisplayText: text, NBest: [{ Display: text, PronScore: score, AccuracyScore: score, Words: words }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const { apiPlugins } = await import("../../web/server/api.ts");
const { MODEL } = await import("../../web/server/pronunciation.ts");
const realDecode = MODEL.decode;

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
  const r = await c.call("PUT", "/api/voice/settings", { tts: "elevenlabs", stt: "elevenlabs", voices: { elevenlabs: { "zh-CN": { "narrator:female": `voice-${name}` } } } });
  assert.equal(r.status, 200, r.text);
  return c;
}
const modelOf = (who, text, locale = "zh-CN") => who.call("GET", `/api/pronunciation/model?sound=${encodeURIComponent(text)}&locale=${locale}`);

const captured = [];
async function logsOf(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  captured.length = 0;
  for (const k of Object.keys(saved)) console[k] = (...a) => captured.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return captured.join("\n");
}

test("the model route needs a session and the page's learner; another language isn't available", async () => {
  assert.equal((await modelOf(client(base), "大")).status, 401);
  await addUser(testDb.db, "nopick", undefined, { learners: [MANDARIN] });
  const unpicked = client(base);
  await unpicked.login("nopick");
  const r = await modelOf(unpicked, "大");
  assert.deepEqual([r.status, r.body.code], [409, "stale_learner"]);
  const spanish = await someone([ADULT]);
  const no = await modelOf(spanish, "大");
  assert.deepEqual([no.status, no.body.code], [422, "not_available"]);
  assert.equal(synths.length + azureCalls.length, 0);
});

test("what the model route takes is checked before any provider call; it takes no audio", async () => {
  const lin = await someone();
  const bad = [
    "/api/pronunciation/model",
    "/api/pronunciation/model?sound=大&phrase=abc",
    `/api/pronunciation/model?sound=${encodeURIComponent("大大大大大")}&locale=zh-CN`,
    "/api/pronunciation/model?sound=hello&locale=zh-CN",
    `/api/pronunciation/model?sound=${encodeURIComponent("大")}&locale=es-MX`,
    `/api/pronunciation/model?sound=${encodeURIComponent("大")}&locale=zh`,
    `/api/pronunciation/model?sound=${encodeURIComponent("大")}`,
    "/api/pronunciation/model?phrase=..%2F..%2Fetc",
  ];
  for (const url of bad) assert.equal((await lin.call("GET", url)).status, 400, url);
  // A "model" sent by the client is not a thing: the route is GET only.
  const { wav } = clip([4]);
  assert.equal((await lin.call("POST", `/api/pronunciation/model?sound=${encodeURIComponent("大")}&locale=zh-CN`, wav, { "Content-Type": "audio/wav" })).status, 405);
  assert.equal(synths.length + azureCalls.length, 0);
  assert.equal(fs.existsSync(analysisDir), false, "nothing written");
});

test("the card's model: made once from the server's own audio, one Azure call, then read from the cache", async () => {
  withAzure();
  const lin = await someone();
  const [s0, a0] = [synths.length, azureCalls.length];
  let first;
  const log = await logsOf(async () => {
    first = await modelOf(lin, "大");
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.available, true);
  assert.equal(first.body.engine, "azure");
  assert.equal(first.body.text, "大");
  assert.deepEqual(first.body.syllables.map((s) => [s.char, s.pinyin, s.expectedTone, s.real]), [["大", "dà", 4, true]]);
  assert.ok(first.body.syllables[0].startMs > 200 && first.body.syllables[0].endMs > first.body.syllables[0].startMs);
  assert.equal(first.body.frames.frameMs, 10);
  assert.equal(first.body.frames.pitch.length, first.body.frames.level.length);
  assert.ok(first.body.frames.pitch.filter((v) => v !== null).length > 20);
  assert.deepEqual([synths.length - s0, azureCalls.length - a0], [1, 1]);
  assert.ok(!log.includes("大") && !log.includes(encodeURIComponent("大")), log);
  // Again: nothing paid.
  const again = await modelOf(lin, "大");
  assert.deepEqual(again.body, first.body);
  // The card's play button reads the same file: no synthesis either.
  const played = await lin.call("POST", "/api/voice/sound", { text: "大", locale: "zh-CN" });
  assert.equal(played.status, 200);
  assert.deepEqual([synths.length - s0, azureCalls.length - a0], [1, 1]);
  // On disk: one record and one ledger, named by the server's own key.
  const files = fs.readdirSync(analysisDir).sort();
  assert.ok(files.every((f) => /^[0-9a-f]{64}-[0-9a-f]{24}\.(json|azure)$/.test(f)), files.join());
});

test("per account: another user's same text is their own clip and their own call", async () => {
  withAzure();
  const a = await someone();
  const b = await someone();
  await modelOf(a, "妈");
  const [s0, a0] = [synths.length, azureCalls.length];
  const r = await modelOf(b, "妈");
  assert.equal(r.status, 200);
  assert.deepEqual([synths.length - s0, azureCalls.length - a0], [1, 1]);
});

test("Azure failing on the model: read locally, and that clip's one call is spent", async () => {
  withAzure();
  const lin = await someone();
  azureAnswer = () => new Response("{}", { status: 500 });
  try {
    const a0 = azureCalls.length;
    const r = await modelOf(lin, "好");
    assert.deepEqual([r.status, r.body.available, r.body.engine], [200, true, "local"]);
    assert.equal(azureCalls.length - a0, 1);
  } finally {
    azureAnswer = null;
  }
  const a1 = azureCalls.length;
  const again = await modelOf(lin, "好");
  assert.equal(again.body.engine, "local");
  assert.equal(azureCalls.length, a1, "never a second call for the same clip");
});

test("no Azure keys: read locally; with keys later, the clip's one call is made once", async () => {
  withoutAzure();
  const lin = await someone();
  try {
    const r = await modelOf(lin, "大");
    assert.deepEqual([r.status, r.body.engine], [200, "local"]);
  } finally {
    withAzure();
  }
  const a0 = azureCalls.length;
  assert.equal((await modelOf(lin, "大")).body.engine, "azure");
  assert.equal((await modelOf(lin, "大")).body.engine, "azure");
  assert.equal(azureCalls.length - a0, 1);
});

test("a Practice phrase's model: the phrase's own audio; an unknown phrase is a 404", async () => {
  withAzure();
  const lin = await someone();
  const add = await lin.call("POST", "/api/phrases", { text: "喝茶", meaning: "to drink tea", starred: false });
  assert.equal(add.status, 201, add.text);
  const id = add.body.phrase.id;
  const r = await lin.call("GET", `/api/pronunciation/model?phrase=${encodeURIComponent(id)}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.syllables.map((s) => [s.char, s.expectedTone]), [["喝", 1], ["茶", 2]]);
  assert.equal(r.body.engine, "azure");
  const s0 = synths.length;
  assert.equal((await lin.call("GET", `/api/practice/audio/${id}`)).status, 200);
  assert.equal(synths.length, s0, "the drill's play reads the same file");
  assert.equal((await lin.call("GET", "/api/pronunciation/model?phrase=nope")).status, 404);
  // Someone else's phrase is not this learner's: 404 too.
  const other = await someone();
  assert.equal((await other.call("GET", `/api/pronunciation/model?phrase=${encodeURIComponent(id)}`)).status, 404);
});

test("a kids learner gets the same model analysis for the card; a Practice phrase is a 403, as Practice is", async () => {
  withAzure();
  const mei = await someone([KID_MANDARIN]);
  const r = await modelOf(mei, "大");
  assert.deepEqual([r.status, r.body.available, r.body.syllables.length], [200, true, 1]);
  const s0 = synths.length;
  const a0 = azureCalls.length;
  const p = await mei.call("GET", `/api/pronunciation/model?phrase=${encodeURIComponent("00000000-0000-4000-8000-000000000000")}`);
  assert.equal(p.status, 403, p.text);
  assert.equal((await mei.call("GET", "/api/practice/audio/00000000-0000-4000-8000-000000000000")).status, 403, "the same answer as Practice's own route");
  assert.deepEqual([synths.length, azureCalls.length], [s0, a0], "refused before any provider call");
});

test("a slow model analysis holds no one else's scoring slot: other users' scores go on", async () => {
  withAzure();
  const [a, b, c] = [await someone(), await someone(), await someone()];
  ttsDelayMs = 800;
  try {
    // Two users open Compare on clips not made yet: both wait on speech.
    const slow = [modelOf(a, "妈"), modelOf(b, "妈")];
    await new Promise((r) => setTimeout(r, 100));
    // A third checks a recording meanwhile: not a 429.
    const take = clip([4], { lowHz: 110, spanSt: 10, ms: 260 });
    timingsByLength.set(take.wav.length, take.timings);
    const r = await c.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}`, take.wav, { "Content-Type": "audio/wav" });
    assert.equal(r.status, 200, r.text);
    for (const m of await Promise.all(slow)) assert.equal(m.status, 200, m.text);
  } finally {
    ttsDelayMs = 0;
  }
});

test("requests sharing one clip's analysis: the first one's browser leaving doesn't cancel it for the second", async () => {
  withAzure();
  const [u1, u2, x] = [await someone(), await someone(), await someone()];
  MODEL.decode = async (audio) => {
    await sleep(700);
    return audio;
  };
  try {
    // Two other users' clips take both decoders.
    const busy = [modelOf(u1, "大"), modelOf(u2, "大")];
    await sleep(120);
    // X's first tab asks for 妈 and waits for a decoder; the second tab
    // asks for the same clip and shares that analysis.
    const ctrl = new AbortController();
    const first = fetch(`${base}/api/pronunciation/model?sound=${encodeURIComponent("妈")}&locale=zh-CN`, {
      headers: { Cookie: x.jar.cookie, "X-Learner-Id": x.learnerId, "X-Language-Profile-Id": x.languageId },
      signal: ctrl.signal,
    }).catch((e) => e);
    await sleep(120);
    const second = modelOf(x, "妈");
    await sleep(120);
    ctrl.abort(); // the first tab is closed while both wait
    assert.ok((await first) instanceof Error);
    const r = await second;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.available, true);
    for (const b of await Promise.all(busy)) assert.equal(b.status, 200, b.text);
  } finally {
    MODEL.decode = realDecode;
  }
});

test("once Azure has answered for a model clip, its answer is kept however long the workers stay busy", async () => {
  withAzure();
  const [s1, s2, m] = [await someone(), await someone(), await someone()];
  const savedWait = MODEL.waitMs;
  MODEL.waitMs = 100;
  azureDelay["大"] = 1200;
  try {
    // Two scores hold both workers through their (slow) Azure calls.
    const take = clip([4], { lowHz: 110, spanSt: 10, ms: 260 });
    timingsByLength.set(take.wav.length, take.timings);
    const scores = [s1, s2].map((u) => u.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}`, take.wav, { "Content-Type": "audio/wav" }));
    await sleep(150);
    // The model clip's Azure call answers at once; its analysis then waits
    // past MODEL.waitMs for a worker, and still makes its record from it.
    const r = await modelOf(m, "妈");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.engine, "azure");
    for (const s of await Promise.all(scores)) assert.equal(s.status, 200, s.text);
    // Without an answer (Azure failed on the clip) the wait has its limit:
    // a 503, nothing paid for is lost.
    const n = await someone();
    azureAnswer = () => new Response("{}", { status: 500 });
    const again = [s1, s2].map((u) => u.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}`, take.wav, { "Content-Type": "audio/wav" }));
    await sleep(150);
    const busy = await modelOf(n, "妈");
    assert.equal(busy.status, 503, busy.text);
    await Promise.all(again);
  } finally {
    azureAnswer = null;
    MODEL.waitMs = savedWait;
    delete azureDelay["大"];
  }
});

test("Azure set up with a malformed region: read locally once and served from the cache, never retried until the region is fixed", async () => {
  fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\nAZURE_SPEECH_KEY=test-key\nAZURE_SPEECH_REGION=East US!\n");
  try {
    const lin = await someone();
    const a0 = azureCalls.length;
    const first = await logsOf(async () => assert.equal((await modelOf(lin, "好")).status, 200));
    assert.match(first, /model clip made \(local\)/);
    const again = await logsOf(async () => assert.equal((await modelOf(lin, "好")).status, 200));
    assert.match(again, /model clip hit \(local\)/, "not analysed again");
    assert.equal(azureCalls.length, a0, "no call");
    // The region fixed: the next request makes the one call.
    withAzure();
    const fixed = await logsOf(async () => assert.equal((await modelOf(lin, "好")).body.engine, "azure"));
    assert.match(fixed, /model clip made \(azure\)/);
    assert.equal(azureCalls.length, a0 + 1);
  } finally {
    withAzure();
  }
});

test("no decoder on this machine, or a clip it can't read: the textbook shapes, nothing cached, nothing sent", async () => {
  withAzure();
  const lin = await someone();
  try {
    MODEL.decode = async () => null;
    const a0 = azureCalls.length;
    const r = await modelOf(lin, "妈");
    assert.deepEqual(r.body, { available: false, why: "no_decoder" });
    MODEL.decode = async () => {
      throw new Error("afconvert failed");
    };
    const u = await modelOf(lin, "妈");
    assert.deepEqual(u.body, { available: false, why: "unreadable" });
    // A "WAV" the scorer can't read is as unreadable.
    MODEL.decode = async () => new Uint8Array(encodeWav(new Float32Array(1600), 44_100));
    assert.deepEqual((await modelOf(lin, "妈")).body, { available: false, why: "unreadable" });
    assert.equal(azureCalls.length, a0);
  } finally {
    MODEL.decode = realDecode;
  }
  // With the decoder back, made now (nothing was cached).
  assert.equal((await modelOf(lin, "妈")).body.available, true);
});

test("two model analyses at a time per user, a third is a 429", async () => {
  withAzure();
  const lin = await someone();
  ttsDelayMs = 300;
  try {
    const slow = [modelOf(lin, "喝茶"), modelOf(lin, "好")];
    await new Promise((r) => setTimeout(r, 60));
    const third = await modelOf(lin, "大");
    assert.equal(third.status, 429);
    for (const r of await Promise.all(slow)) assert.equal(r.status, 200);
  } finally {
    ttsDelayMs = 0;
  }
});

test("a clip that starts on its first sound, and a lone short one, are padded before they are read; times stay the clip's own", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const { samples } = speak([4], { ms: 200, gaps: [0, 0], lowHz: 210, spanSt: 12 });
    MODEL.decode = async () => new Uint8Array(encodeWav(samples, 16_000));
    const r = await modelOf(lin, "大");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.available, true);
    assert.ok(Math.abs(r.body.durationMs - 200) <= 1, String(r.body.durationMs));
    assert.ok(Math.abs(r.body.frames.pitch.length - 21) <= 1, String(r.body.frames.pitch.length));
    const [s] = r.body.syllables;
    assert.ok(s.startMs !== null && s.startMs < 60 && s.endMs <= 210, JSON.stringify(s));
    assert.equal(s.real, true, "judged: not 'clipped', not too short");
  } finally {
    MODEL.decode = realDecode;
    withAzure();
  }
});

test("the score reply carries the take's frames; Azure's syllable score for adults only; the half third named", async () => {
  withAzure();
  const lin = await someone();
  const take = clip([4], { lowHz: 110, spanSt: 10, ms: 260 });
  timingsByLength.set(take.wav.length, take.timings);
  const r = await lin.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}`, take.wav, { "Content-Type": "audio/wav" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.frames.frameMs, 10);
  assert.ok(Math.abs(r.body.frames.pitch.length - take.wav.length / 2 / 160) <= 2);
  assert.equal(r.body.syllables[0].soundScore, 88);
  const mei = await someone([KID_MANDARIN]);
  const k = await mei.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}`, take.wav, { "Content-Type": "audio/wav" });
  assert.equal(k.status, 200, k.text);
  assert.ok(k.body.frames, "kids get the picture too");
  assert.equal(k.body.syllables[0].soundScore, undefined, "no scores for kids");
  const two = clip([3, 4], { lowHz: 110, spanSt: 10, ms: 260 });
  timingsByLength.set(two.wav.length, two.timings);
  const h = await lin.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("我是")}`, two.wav, { "Content-Type": "audio/wav" });
  assert.equal(h.body.syllables[0].half, true);
  assert.equal(h.body.syllables[1].half, undefined);
});
