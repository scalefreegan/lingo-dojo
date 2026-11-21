// POST /api/pronunciation/score end to end (web/server/pronunciation.ts,
// ld-ne0.2): a WAV scored against known Han text for the active learner's
// language. Mandarin only; validated before any provider call; with Azure
// keys a learner (adult or kids alike) is assessed by Azure (stubbed in
// fetch here: nothing reaches the network) with the local tone check on its
// timings; no keys, an Azure failure, a malformed region, a busy slot or the
// per-minute cap all fall back to the local scorer, never an error. A
// worker that hangs or crashes, a browser that drops the upload and a body
// that never finishes arriving each end cleanly, and no log line names the
// text. The real plugin on an in-process PGlite;
// the clips are generated (scripts/pronunciation-synth.mjs). Every name
// here is made up.
//   node --test scripts/tests/pronunciation.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
const withRegion = (region) => fs.writeFileSync(process.env.LINGO_ENV_FILE, `AZURE_SPEECH_KEY=test-key\nAZURE_SPEECH_REGION=${region}\n`);
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
// The route's worker and time limits, swapped below for a worker that
// hangs or crashes (the same module instance api.ts mounted).
const { SCORER } = await import("../../web/server/pronunciation.ts");
// The reader the route uses, for its cache (the same module instance).
const { readCodePoints, readingCached } = await import("../../web/src/script/zh.ts");

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
const pick = (y) => [y.verdict, y.pinyin, y.expectedTone];

/** Everything the server logged while `fn` ran, as one string (`captured`
 *  holds it as it comes, for a test waiting on a line). */
const captured = [];
async function logsOf(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  captured.length = 0;
  for (const k of Object.keys(saved)) console[k] = (...a) => captured.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return captured.join("\n");
}

const score = (who, text, wav, type = "audio/wav") => who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}`, wav, { "Content-Type": type });
/** As the character card asks: every reading of its one character. */
const scoreCard = (who, text, wav, readings = "all") => who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}&readings=${readings}`, wav, { "Content-Type": "audio/wav" });

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

test("a kids learner is scored like an adult: Azure with keys, the same fallbacks; only the reply differs", async () => {
  withAzure();
  const mei = await someone([KID_MANDARIN]);
  const right = clip([4]);
  azure = (text) => azureReply(text, right.timings);
  const before = azureCalls.length;
  const r = await score(mei, "大", right.wav);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.engine, r.body.fallback, r.body.overall], ["azure", null, null], "no score in kids mode");
  assert.equal(r.body.syllables[0].verdict, "ok");
  assert.equal(azureCalls.length, before + 1);
  assert.equal(azureCalls.at(-1).reference, "大");
  // The mode is still the session's: a page claiming another is a 400, and nothing is sent.
  const claimed = await mei.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("大")}&mode=adult`, right.wav, { "Content-Type": "audio/wav" });
  assert.equal(claimed.status, 400);
  assert.equal(azureCalls.length, before + 1);
  // Azure failing: the local scorer, as for an adult.
  azure = () => new Response("{}", { status: 500 });
  const failed = await score(mei, "大", right.wav);
  assert.deepEqual([failed.status, failed.body.engine, failed.body.fallback, failed.body.overall], [200, "local", "failed", null]);
  // No keys: local with "no_keys" (there is no "kids" reason any more).
  withoutAzure();
  try {
    const local = await score(mei, "大", right.wav);
    assert.deepEqual([local.status, local.body.engine, local.body.fallback], [200, "local", "no_keys"]);
  } finally {
    withAzure();
  }
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


test("a malformed Azure region: the local scorer, nothing sent, no per-minute call spent", async () => {
  withRegion("East US");
  const lin = await someone();
  const { wav, timings } = clip([4]);
  azure = (text) => azureReply(text, timings);
  const before = azureCalls.length;
  try {
    const log = await logsOf(async () => {
      for (let i = 0; i < AZURE_PER_MINUTE; i++) {
        const r = await score(lin, "大", wav);
        assert.deepEqual([r.status, r.body.engine, r.body.fallback], [200, "local", "failed"], r.text);
      }
    });
    assert.match(log, /AZURE_SPEECH_REGION/);
    assert.ok(!log.includes("East US") && !log.includes("test-key"), log);
    assert.equal(azureCalls.length, before);
  } finally {
    withAzure();
  }
  // Every token is still there: with the region fixed, Azure answers.
  assert.equal((await score(lin, "大", wav)).body.engine, "azure");
});

test("no log line carries Azure's reply", async () => {
  withAzure();
  const lin = await someone();
  const { wav } = clip([4]);
  azure = () => new Response("<html>谢谢 secret-body</html>", { status: 200 });
  const log = await logsOf(async () => assert.equal((await score(lin, "大", wav)).body.fallback, "failed"));
  assert.match(log, /isn't JSON/);
  assert.ok(!log.includes("secret-body") && !log.includes("谢"), log);
});

/* The route's failures, each with the text in the URL: none may reach a log. */
const SECRET = "谢谢你";
const leaks = (log) => [SECRET, "谢", encodeURIComponent("谢")].filter((x) => log.includes(x));

test("a worker that hangs or crashes: a clean 503, the slots freed, the text in no log", async () => {
  withoutAzure();
  const saved = { ...SCORER };
  const lin = await someone();
  const { wav } = clip([4, 4, 3]);
  try {
    for (const [kind, body] of [
      ["timeout", "setInterval(() => {}, 1000);"],
      ["crash", "throw new Error('谢谢你 inside the worker');"],
      ["crash", "process.exit(3);"],
      ["error", "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ error: '谢谢你' });"],
    ]) {
      const file = path.join(dataDir, `worker-${kind}-${Math.random().toString(36).slice(2)}.mjs`);
      fs.writeFileSync(file, body);
      SCORER.worker = file;
      SCORER.timeoutMs = 300;
      const log = await logsOf(async () => {
        const r = await score(lin, SECRET, wav);
        assert.equal(r.status, 503, r.text);
        assert.match(r.body.error, /couldn't be checked just now/);
        assert.deepEqual(leaks(r.text), []);
      });
      assert.match(log, new RegExp(`scoring failed \\(${kind}\\)`), log);
      assert.deepEqual(leaks(log), [], log);
    }
  } finally {
    Object.assign(SCORER, saved);
  }
  // The slots were given back each time: the next one scores.
  try {
    assert.equal((await score(lin, SECRET, wav)).status, 200);
  } finally {
    withAzure();
  }
});

/** Send the headers and part of a body, then (`drop`) cut the connection,
 *  or hold it open until the server answers. */
function partialUpload(who, text, bytes, { drop }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/pronunciation/score?text=${encodeURIComponent(text)}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "Content-Length": String(bytes.length * 2), Cookie: who.jar.cookie, "X-Learner-Id": who.learnerId, "X-Language-Profile-Id": who.languageId },
    });
    req.on("response", (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    req.on("error", (e) => (drop ? resolve(null) : reject(e)));
    req.write(bytes);
    if (drop) {
      setTimeout(() => {
        req.destroy();
        resolve(null);
      }, 50);
    }
  });
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

test("a browser that drops the upload: the request just ends, the text in no log", async () => {
  withAzure();
  const lin = await someone();
  const { wav, timings } = clip([4, 4, 3]);
  const before = azureCalls.length;
  const log = await logsOf(async () => {
    await partialUpload(lin, SECRET, wav.slice(0, 4000), { drop: true });
    assert.ok(await until(() => /went away/.test(captured.join("\n"))), "the drop was noticed");
  });
  assert.match(log, /pronunciation: the browser went away/);
  assert.doesNotMatch(log, /\[lingo-dojo\] POST/, "not wrap's 500 line");
  assert.deepEqual(leaks(log), [], log);
  assert.equal(azureCalls.length, before, "nothing sent for a recording never received");
  // Its slot is free again.
  azure = (text) => azureReply(text, timings);
  assert.equal((await score(lin, SECRET, wav)).status, 200);
});

test("a body that never finishes arriving: 408 after the limit, the text in no log", async () => {
  withoutAzure();
  const saved = { ...SCORER };
  SCORER.bodyTimeoutMs = 200;
  try {
    const lin = await someone();
    const { wav } = clip([4, 4, 3]);
    const log = await logsOf(async () => {
      const r = await partialUpload(lin, SECRET, wav.slice(0, 4000), { drop: false });
      assert.equal(r.status, 408, r.text);
      assert.match(r.text, /took too long to arrive/);
    });
    assert.deepEqual(leaks(log), [], log);
    assert.equal((await score(lin, SECRET, wav)).status, 200, "its slot is free again");
  } finally {
    Object.assign(SCORER, saved);
    withAzure();
  }
});

test("the limits come before the body: a second score while one is uploading is a 429", async () => {
  withoutAzure();
  const saved = { ...SCORER };
  SCORER.bodyTimeoutMs = 1500;
  try {
    const lin = await someone();
    const { wav } = clip([4]);
    const held = partialUpload(lin, "大", wav.slice(0, 2000), { drop: false });
    await new Promise((r) => setTimeout(r, 150));
    const second = await score(lin, "大", wav);
    assert.deepEqual([second.status, second.body.error], [429, "a recording is already being checked; try again in a moment"]);
    assert.equal((await held).status, 408);
  } finally {
    Object.assign(SCORER, saved);
    withAzure();
  }
});

test("the card's flag: a lone character judged against every reading it shows, another reading named", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const zhang = await scoreCard(lin, "长", clip([3]).wav);
    assert.equal(zhang.status, 200, zhang.text);
    assert.deepEqual(pick(zhang.body.syllables[0]), ["ok", "zhǎng", 3]);
    assert.equal(zhang.body.syllables[0].usual, "cháng", "said in another reading: the usual one named");
    const chang = (await scoreCard(lin, "长", clip([2]).wav)).body.syllables[0];
    assert.deepEqual(pick(chang), ["ok", "cháng", 2]);
    assert.equal(chang.usual, undefined, "the usual reading: nothing more to say");
    assert.deepEqual(pick((await scoreCard(lin, "行", clip([4]).wav)).body.syllables[0]), ["ok", "hàng", 4]);
    const miss = (await scoreCard(lin, "为", clip([1]).wav)).body.syllables[0];
    assert.deepEqual([...pick(miss), miss.heardTone, miss.usual], ["off", "wèi", 4, 1, undefined]);
    assert.deepEqual(pick((await scoreCard(lin, "了", clip([3]).wav)).body.syllables[0]), ["unsure", "le", 0]);
    // 拉's readings take all four tones: nothing can be checked.
    const la = await scoreCard(lin, "拉", clip([1]).wav);
    assert.deepEqual([...pick(la.body.syllables[0]), la.body.syllables[0].reason, la.body.overall], ["unsure", "lā", 1, "every_tone", null]);
    // The flag is only for one character alone, and only "all".
    assert.equal((await scoreCard(lin, "长大", clip([3, 4]).wav)).status, 400);
    assert.equal((await scoreCard(lin, "长", clip([3]).wav, "some")).status, 400);
  } finally {
    withAzure();
  }
});

test("without the flag (Practice) one character keeps its one reading: 好, 不！, 长大", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    // What is accepted is the point (the verdict on a generated clip is the
    // engine's business): hǎo's tone only, never hào's; bù's, never fǒu's.
    const hao = (await score(lin, "好", clip([4]).wav)).body.syllables[0];
    assert.deepEqual([hao.pinyin, hao.accept, hao.usual], ["hǎo", [3], undefined]);
    assert.deepEqual((await scoreCard(lin, "好", clip([4]).wav)).body.syllables[0].accept, [3, 4], "the card, for contrast");
    const bu = (await score(lin, "不！", clip([3]).wav)).body.syllables[0];
    assert.deepEqual([bu.pinyin, bu.accept, bu.usual], ["bù", [4], undefined]);
    assert.notEqual(bu.verdict, "ok", "fǒu's third tone is not bù");
    const word = await score(lin, "长大", clip([3, 4]).wav);
    assert.deepEqual(word.body.syllables.map((x) => [x.pinyin, x.accept]), [["zhǎng", [3]], ["dà", [4]]]);
    // 拉 in Practice is lā, checked.
    assert.notEqual((await score(lin, "拉", clip([1]).wav)).body.syllables[0].reason, "every_tone");
  } finally {
    withAzure();
  }
});

test("a bank phrase's stored reading (ld-op2) is what its recording is judged against, once it passes the hint checks again", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const said = (reading) =>
      lin.call("POST", `/api/pronunciation/score?text=${encodeURIComponent("你得去")}${reading == null ? "" : `&reading=${encodeURIComponent(reading)}`}`, clip([3, 3, 4]).wav, { "Content-Type": "audio/wav" });
    const got = async (reading) => (await said(reading)).body.syllables.map((x) => [x.pinyin, x.accept]);
    assert.deepEqual(await got(null), [["nǐ", [3]], ["dé", [2]], ["qù", [4]]], "the reader's reading without one");
    // (nǐ before a third tone is said as a second: the scorer's own sandhi.)
    assert.deepEqual(await got("nǐ děi qù"), [["nǐ", [2]], ["děi", [3]], ["qù", [4]]]);
    // Not a reading of the character, or the wrong count: ignored, never a
    // sound the text doesn't have.
    assert.deepEqual(await got("nǐ dǎi qù"), [["nǐ", [3]], ["dé", [2]], ["qù", [4]]]);
    assert.deepEqual(await got("děi"), [["nǐ", [3]], ["dé", [2]], ["qù", [4]]]);
  } finally {
    withAzure();
  }
});

test("a scored text stays in neither the reader's cache nor anywhere it can be found", async () => {
  withoutAzure();
  try {
    const lin = await someone();
    const text = "你谢好大";
    assert.equal(readingCached(text, "zh-CN"), false);
    assert.equal((await score(lin, text, clip([2, 4, 3, 4]).wav)).status, 200);
    assert.equal(readingCached(text, "zh-CN"), false, "the server read it with cache: false");
    // The page's own reads still fill it.
    readCodePoints(text, "zh-CN");
    assert.equal(readingCached(text, "zh-CN"), true);
  } finally {
    withAzure();
  }
});

test("wrap logs the path only: a failing session lookup on the score route names no text", async () => {
  const lin = await someone();
  const { wav } = clip([4, 4, 3]);
  const select = testDb.db.select;
  testDb.db.select = () => {
    throw new Error("the database is down");
  };
  try {
    const log = await logsOf(async () => {
      const r = await score(lin, SECRET, wav);
      assert.equal(r.status, 500, r.text);
      assert.deepEqual(leaks(r.text), []);
    });
    assert.match(log, /\[lingo-dojo\] POST \/score:/);
    assert.deepEqual(leaks(log), [], log);
    assert.doesNotMatch(log, /text=/);
  } finally {
    testDb.db.select = select;
  }
});

test("an error after the body is read, the browser still there: a 503, never 'went away'", async () => {
  withoutAzure();
  const saved = { ...SCORER };
  const file = path.join(dataDir, "worker-bad-result.mjs");
  fs.writeFileSync(file, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ result: { syllables: null } });");
  SCORER.worker = file;
  try {
    const lin = await someone();
    const log = await logsOf(async () => {
      const r = await score(lin, SECRET, clip([4, 4, 3]).wav);
      assert.equal(r.status, 503, r.text);
    });
    assert.match(log, /scoring failed \(error\)/);
    assert.doesNotMatch(log, /went away/);
    assert.deepEqual(leaks(log), [], log);
  } finally {
    Object.assign(SCORER, saved);
    withAzure();
  }
});

test("a browser that drops during the session lookup frees its slot at once, not after the body timeout", async () => {
  withoutAzure();
  const lin = await someone();
  const { wav } = clip([4, 4, 3]);
  // Every database query waits 300 ms: the drop lands while the session is
  // looked up, before the route has a listener on the body.
  const query = testDb.client.query;
  let slowed = 0;
  testDb.client.query = function (...a) {
    slowed++;
    return new Promise((r) => setTimeout(r, 300)).then(() => query.apply(this, a));
  };
  try {
    const log = await logsOf(async () => {
      await partialUpload(lin, SECRET, wav.slice(0, 4000), { drop: true });
      // Within the slowed lookup plus a little: never the 20 s body timeout.
      assert.ok(await until(() => /went away/.test(captured.join("\n")), 5000), `the drop was noticed: ${captured.join(" | ")}`);
    });
    assert.ok(slowed > 0, "the lookup was slowed");
    assert.deepEqual(leaks(log), [], log);
  } finally {
    testDb.client.query = query;
  }
  const t0 = Date.now();
  try {
    const r = await score(lin, SECRET, wav);
    assert.equal(r.status, 200, r.text);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    withAzure();
  }
});
