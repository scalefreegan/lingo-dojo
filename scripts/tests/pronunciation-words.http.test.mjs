// POST /api/pronunciation/score for a language beyond Mandarin (ld-ne0.16;
// web/server/pronunciation.ts scoreWords): a WAV checked word by word by
// Azure against a known phrase. Azure only: no keys, or a locale the proof
// didn't measure, is the 422 `not_available`; Azure failing, busy or past
// the per-minute cap is an error with a fixed sentence (there is no local
// scorer to fall back on). Kids get no marks. Validated before any provider
// call; nothing stored; no log line names the phrase. Azure is stubbed in
// fetch (nothing reaches the network); the real plugin on PGlite. Every
// name here is made up.
//   node --test scripts/tests/pronunciation-words.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav } from "../pronunciation.mjs";
import { AZURE_PER_MINUTE } from "../pronunciation-app.mjs";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-words-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const withAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "AZURE_SPEECH_KEY=test-key\nAZURE_SPEECH_REGION=eastus\n");
const withoutAzure = () => fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
withAzure();

/* Azure, stubbed: every call recorded; `azure` answers it. Any other host
 * is refused. */
const azureCalls = [];
let azure = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (!url.hostname.endsWith(".stt.speech.microsoft.com")) throw new Error(`unexpected fetch to ${url.hostname}`);
  const header = JSON.parse(Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"));
  azureCalls.push({ language: url.searchParams.get("language"), reference: header.ReferenceText });
  return azure(header.ReferenceText);
};

/** A reply in the live shape for a Latin-script locale (flat scores,
 *  unnamed phonemes): `words` = [[word, score, errorType], …], 300 ms each. */
function reply(words, { status = "Success" } = {}) {
  const ticks = (ms) => Math.round(ms * 10_000);
  const Words = words.map(([w, score, error = "None"], i) => ({
    Word: w, ...(error === "Omission" ? {} : { Offset: ticks(300 + i * 300), Duration: ticks(280) }), AccuracyScore: score, ErrorType: error,
    Phonemes: [{ Phoneme: "", Offset: ticks(300 + i * 300), Duration: ticks(140), AccuracyScore: score }],
  }));
  return new Response(JSON.stringify({ RecognitionStatus: status, NBest: [{ Display: words.map((x) => x[0]).join(" "), PronScore: 77.5, AccuracyScore: 80, Words }] }), { status: 200, headers: { "Content-Type": "application/json" } });
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

const JAPANESE = { ...ADULT, name: "Aki", targetLanguage: "Japanese", targetVariant: "Standard Japanese (Tokyo)" };
let n = 0;
async function someone(learners = [ADULT]) {
  const name = `wuser${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}
/** A second of quiet: the route reads the format, Azure (stubbed) the rest. */
const wav = new Uint8Array(encodeWav(new Float32Array(16_000), 16_000));
/** A second of something loud (a tone): not a quiet take. */
const loud = new Uint8Array(encodeWav(Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16_000)), 16_000));
/** Live replies (scripts/pronunciation-proof-echo.mjs; reply shape only). */
const ECHO = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pronunciation", "azure-echo.json"), "utf8"));
const fixture = (id) => new Response(JSON.stringify(ECHO[id].reply), { status: 200, headers: { "Content-Type": "application/json" } });
const score = (who, text, body = wav, extra = "") => who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}${extra}`, body, { "Content-Type": "audio/wav" });

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

test("no Azure keys, or a locale not measured: not available, nothing sent", async () => {
  const sam = await someone();
  const before = azureCalls.length;
  withoutAzure();
  try {
    const r = await score(sam, "quiero un café");
    assert.deepEqual([r.status, r.body.code], [422, "not_available"]);
  } finally {
    withAzure();
  }
  // Argentine Spanish: Azure has es-MX and es-ES, not es-AR; Swiss German
  // isn't German German; Greek isn't assessed at all.
  for (const l of [
    { ...ADULT, name: "Lu", targetVariant: "Argentine Spanish" },
    { ...ADULT, name: "Res", targetLanguage: "German", targetVariant: "Swiss German" },
    { ...ADULT, name: "Eleni", targetLanguage: "Greek", targetVariant: "" },
  ]) {
    const r = await score(await someone([l]), "hola");
    assert.deepEqual([r.status, r.body.code], [422, "not_available"], l.name);
  }
  assert.equal(azureCalls.length, before);
});

test("the phrase and the audio are checked before any provider call", async () => {
  const sam = await someone();
  const before = azureCalls.length;
  for (const [text, want] of [
    ["", 400],
    ["tengo 3 perros", 400],
    ["大", 400],
    ["uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece", 400],
    ["hola 🙂", 400],
  ]) assert.equal((await score(sam, text)).status, want, text);
  assert.equal((await score(sam, "hola", wav, "&readings=all")).status, 400);
  assert.equal((await score(sam, "hola", wav, "&reading=ni3")).status, 400);
  assert.equal((await sam.call("POST", "/api/pronunciation/score?text=hola", wav, { "Content-Type": "audio/mpeg" })).status, 415);
  assert.equal((await score(sam, "hola", new Uint8Array(encodeWav(new Float32Array(16_000), 44_100)))).status, 415);
  assert.equal((await score(sam, "hola", new Uint8Array(encodeWav(new Float32Array(1600), 16_000)))).status, 400);
  assert.equal(azureCalls.length, before);
});

test("an adult: one mark per word, laid on the phrase as written", async () => {
  const sam = await someone();
  azure = () => reply([["dónde", 96], ["está", 88], ["el", 60, "Mispronunciation"], ["baño", 12, "Mispronunciation"]]);
  const r = await score(sam, "¿Dónde está el baño?");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(azureCalls.at(-1), { language: "es-MX", reference: "¿Dónde está el baño?" });
  assert.equal(r.body.kind, "words");
  assert.equal(r.body.locale, "es-MX");
  assert.deepEqual(r.body.words.map((w) => [w.text, w.verdict, r.body.text.slice(w.start, w.end)]), [
    ["Dónde", "ok", "Dónde"],
    ["está", "ok", "está"],
    ["el", "unsure", "el"],
    ["baño", "off", "baño"],
  ]);
  const bano = r.body.words[3];
  assert.equal(bano.why, "sound");
  assert.equal(bano.score, 12);
  assert.deepEqual([bano.startMs, bano.endMs], [1200, 1480]);
  assert.equal(r.body.overall, 78);
  assert.ok(!("azureError" in bano), "Azure's own error word stays on the server");
  assert.ok(!("nudge" in r.body));
});

test("a word Azure didn't hear as itself is off (missing), with no score; a word it added isn't shown", async () => {
  const sam = await someone();
  azure = () => reply([["quiero", 95], ["un", 0, "Omission"], ["uh", 40, "Insertion"], ["café", 91]]);
  const r = await score(sam, "quiero un café");
  assert.deepEqual(r.body.words.map((w) => [w.text, w.verdict, w.why ?? null, w.score]), [
    ["quiero", "ok", null, 95],
    ["un", "off", "missing", null],
    ["café", "ok", null, 91],
  ]);
});

test("a word beside an inserted copy of itself is not sure, not off", async () => {
  const sam = await someone([{ ...ADULT, name: "Mo", targetLanguage: "French", targetVariant: "" }]);
  azure = () => reply([["je", 97], ["m'appelle", 100, "Insertion"], ["m'appelle", 26, "Mispronunciation"], ["Paul", 92]]);
  const r = await score(sam, "je m'appelle Paul");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.words.map((w) => [w.text, w.verdict, w.reason ?? null]), [
    ["je", "ok", null],
    ["m'appelle", "unsure", "unclear"],
    ["Paul", "ok", null],
  ]);
});

test("Japanese: Azure's own words, placed on the unspaced phrase", async () => {
  const aki = await someone([JAPANESE]);
  azure = () => reply([["水", 95], ["を", 90], ["ください", 20, "Mispronunciation"]]);
  const r = await score(aki, "水をください。");
  assert.equal(r.status, 200, r.text);
  assert.equal(azureCalls.at(-1).language, "ja-JP");
  assert.deepEqual(r.body.words.map((w) => [w.text, w.start, w.end, w.verdict]), [
    ["水", 0, 1, "ok"],
    ["を", 1, 2, "ok"],
    ["ください", 2, 6, "off"],
  ]);
  // Latin letters in a Japanese phrase: Azure would read them as Japanese.
  assert.equal((await score(aki, "mizu o kudasai")).status, 400);
});

test("a kids learner: Azure as for an adult, but no marks, no scores; a nudge when something was off", async () => {
  const pip = await someone([KID]);
  azure = () => reply([["Guten", 90], ["Morgen", 15, "Mispronunciation"]]);
  const r = await score(pip, "Guten Morgen");
  assert.equal(r.status, 200, r.text);
  assert.equal(azureCalls.at(-1).language, "de-DE");
  assert.equal(r.body.overall, null);
  assert.equal(r.body.nudge, true);
  for (const w of r.body.words) assert.deepEqual(Object.keys(w).sort(), ["end", "start", "text"]);
  azure = () => reply([["Guten", 90], ["Morgen", 91]]);
  assert.equal((await score(pip, "Guten Morgen")).body.nudge, false);
});

test("a quiet take with no speech: a 422 no_speech saying so, not an outage, and no marks", async () => {
  const sam = await someone();
  for (const quiet of [
    () => new Response(JSON.stringify({ RecognitionStatus: "NoMatch" }), { status: 200 }),
    () => new Response(JSON.stringify({ RecognitionStatus: "InitialSilenceTimeout" }), { status: 200 }),
    // Live replies for a take with no word of the phrase in it (silence or
    // noise; Azure answers both the same), here with a quiet take: the
    // default `wav` is a second of silence.
    () => fixture("es-silence"),
    () => fixture("es-noise"),
  ]) {
    azure = quiet;
    let r;
    const log = await logsOf(async () => {
      r = await score(sam, "la cuenta");
    });
    assert.deepEqual([r.status, r.body.code], [422, "no_speech"], r.text);
    assert.match(r.body.error, /no speech was heard/);
    assert.ok(!("words" in r.body));
    assert.ok(!log.includes("cuenta"), log);
  }
});

test("a loud take Azure heard none of the words in (live: a wrong word, or noise): heard none, no verdicts", async () => {
  // Live, "hola" said against "gracias" reads exactly like noise: Success,
  // every word omitted, no insertion, "." recognised. No word is judged.
  for (const [id, text, who] of [
    ["es-wrong1", "gracias", ADULT],
    ["es-wrong2", "muchas gracias", ADULT],
    ["es-noise", "hola", ADULT],
    ["fr-wrong1", "merci", { ...ADULT, name: "Mo", targetLanguage: "French", targetVariant: "" }],
    ["de-noise", "Danke schön", { ...ADULT, name: "Res", targetLanguage: "German", targetVariant: "" }],
  ]) {
    const sam = await someone([who]);
    azure = () => fixture(id);
    const r = await score(sam, text, loud);
    assert.equal(r.status, 200, `${id} ${r.text}`);
    assert.equal(r.body.heard, "none", id);
    assert.equal(r.body.overall, null, id);
    assert.ok(r.body.words.length > 0, id);
    for (const w of r.body.words) assert.deepEqual(Object.keys(w).sort(), ["end", "start", "text"], id);
  }
  // Kids: the nudge, as for anything off.
  const pip = await someone([KID]);
  azure = () => fixture("de-noise");
  const kid = await score(pip, "Danke schön", loud);
  assert.deepEqual([kid.status, kid.body.heard, kid.body.nudge], [200, "none", true]);
  // A partial reply keeps its marks: one word heard, the other off.
  const sam = await someone();
  azure = () => reply([["la", 95], ["cuenta", 0, "Omission"]]);
  const part = await score(sam, "la cuenta", loud);
  assert.equal(part.body.heard, undefined);
  assert.deepEqual(part.body.words.map((w) => [w.verdict, w.why ?? null]), [["ok", null], ["off", "missing"]]);
});

test("Azure failing: a 503 with a fixed sentence, nothing from Azure in the reply or the log", async () => {
  const sam = await someone();
  for (const fail of [
    () => new Response("{}", { status: 500 }),
    () => new Response(JSON.stringify({ RecognitionStatus: "Error" }), { status: 200 }),
    () => new Response("<html>secret-body</html>", { status: 200 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    azure = fail;
    let r;
    const log = await logsOf(async () => {
      r = await score(sam, "la cuenta, por favor");
    });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.error, "the words couldn't be checked just now; try again");
    assert.ok(!log.includes("cuenta") && !log.includes("secret-body"), log);
    assert.ok(!JSON.stringify(r.body).includes("test-key"));
  }
});

test("past the per-minute cap: a 429, no call made", async () => {
  const sam = await someone();
  azure = () => reply([["hola", 95]]);
  const before = azureCalls.length;
  for (let i = 0; i < AZURE_PER_MINUTE; i++) assert.equal((await score(sam, "hola")).status, 200);
  const r = await score(sam, "hola");
  assert.equal(r.status, 429);
  assert.equal(azureCalls.length, before + AZURE_PER_MINUTE);
  assert.equal((await score(await someone(), "hola")).status, 200, "another user has a cap of their own");
});

test("the log names the count of words only", async () => {
  const sam = await someone();
  azure = () => reply([["tengo", 95], ["hambre", 92]]);
  const log = await logsOf(async () => assert.equal((await score(sam, "tengo hambre")).status, 200));
  assert.match(log, /azure \(words\), 2 words/);
  assert.ok(!log.includes("tengo") && !log.includes("hambre"), log);
});
