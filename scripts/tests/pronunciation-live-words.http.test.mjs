// Word checks in live conversation end to end (ld-ne0.17; docs/VOICE.md
// §Words in conversation): a Go-tab recording in a language beyond Mandarin
// is transcribed (ElevenLabs, stubbed in fetch), its word check starts there
// with Azure (stubbed: nothing reaches the network), and the turn that sends
// those words picks it up: a word that clearly didn't sound right puts one
// block into the turn prompt (a stand-in `claude` records it) and the
// adult's reply carries the line's word marks. Nothing is stored: no check
// row, no clip. Kids: the gentle rule, no marks, no dial. No Azure keys, a
// phrase the check doesn't take, edited words, Azure failing: the turn is
// exactly as without the feature. The real plugin on an in-process PGlite.
// Every name is made up.
//   node --test scripts/tests/pronunciation-live-words.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "../pronunciation.mjs";
import { PRONUNCIATION_CLOSE, PRONUNCIATION_OPEN, PRONUNCIATION_RULES, WORD_PRONUNCIATION_RULES } from "../voice.mjs";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-live-words-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_CLIPS_DIR;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
const WITH_AZURE = "ELEVENLABS_API_KEY=test-key\nAZURE_SPEECH_KEY=test-azure\nAZURE_SPEECH_REGION=eastus\n";
fs.writeFileSync(process.env.LINGO_ENV_FILE, WITH_AZURE);
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const clipsDir = path.join(dataDir, "clips");

/* Speech-to-text "hears" `heard`; Azure answers `azure(reference)`. */
let heard = "Quiero un café.";
let azure = null;
const azureCalls = [];
/** The latest Azure request's abort signal (for the calls that hang). */
let lastSignal = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.elevenlabs.io" && url.pathname === "/v1/speech-to-text") {
    return new Response(JSON.stringify({ text: heard }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname.endsWith(".stt.speech.microsoft.com")) {
    const header = JSON.parse(Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"));
    azureCalls.push({ language: url.searchParams.get("language"), reference: header.ReferenceText });
    lastSignal = init.signal;
    return azure(header.ReferenceText);
  }
  throw new Error(`unexpected fetch to ${url.hostname}`);
};

/** A reply in Azure's live shape: `words` = [[word, score, errorType], …]. */
function reply(words) {
  const ticks = (ms) => Math.round(ms * 10_000);
  const Words = words.map(([w, score, error = "None"], i) => ({
    Word: w, ...(error === "Omission" ? {} : { Offset: ticks(300 + i * 300), Duration: ticks(280) }), AccuracyScore: score, ErrorType: error,
    Phonemes: [{ Phoneme: "", Offset: ticks(300 + i * 300), Duration: ticks(140), AccuracyScore: score }],
  }));
  const said = words.filter((x) => x[2] !== "Omission").map((x) => x[0]).join(" ");
  return new Response(JSON.stringify({ RecognitionStatus: "Success", NBest: [{ Display: said || ".", Lexical: said || ".", PronScore: 77.5, AccuracyScore: 80, Words }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
const MISSED = () => reply([["Quiero", 95], ["un", 97], ["café", 12, "Mispronunciation"]]);
const RIGHT = () => reply([["Quiero", 95], ["un", 97], ["café", 93]]);

/* A stand-in `claude` first on PATH: it keeps each run's arguments and
 * answers one line. */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-live-words-claude-"));
const argsFile = path.join(bin, "args.json");
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "result", result: "NARRATOR-F: <t>Muy bien.</t>" }));\n`,
  { mode: 0o755 },
);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
const prompt = () => JSON.parse(fs.readFileSync(argsFile, "utf8")).join("\n");

const { apiPlugins } = await import("../../web/server/api.ts");
const { LIVE, clearLive } = await import("../../web/server/livePronunciation.ts");
const { checksOf } = await import("../db/pronunciation.ts");

const testDb = await freshDb();
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
  fs.rmSync(argsFile, { force: true });
  fs.writeFileSync(process.env.LINGO_ENV_FILE, WITH_AZURE);
  heard = "Quiero un café.";
  azure = MISSED;
  azureCalls.length = 0;
});

let n = 0;
async function someone(learners = [ADULT]) {
  const name = `words${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}
const profileOf = (who) => ({ id: who.languageId, learnerId: who.learnerId });

/** A second of a loud tone: a take that isn't quiet. */
const WAV = new Uint8Array(encodeWav(Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16_000)), 16_000));

const ADULT_PACK = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };
const KIDS_PACK = { title: "", created: "", scenario: "farm", quick_scenario: "", units: ["intro-game", "story-quest", "game-echo"], overrides: {}, notes: "" };

async function start(who, mode = "adult") {
  const r = await who.call("POST", "/api/conversations", { mode, pack: mode === "kids" ? KIDS_PACK : ADULT_PACK, title: "Live words" });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation.id;
}
const transcribe = (who, conversationId, query = "", locale = "es-MX") =>
  who.call("POST", `/api/voice/transcribe?locales=${locale},en-US${conversationId ? `&conversation=${conversationId}` : ""}${query}`, WAV, { "Content-Type": "audio/wav" });
const turn = (who, conversationId, message, extra = {}) =>
  who.call("POST", "/api/voice/turn", { mode: extra.mode ?? "adult", pack: extra.mode === "kids" ? KIDS_PACK : ADULT_PACK, history: [], message, elapsedMs: 0, conversationId, conversationStart: 0, ...extra });
/** One spoken turn: transcribed, then sent as heard. */
async function say(who, id, { coaching = "light", message = heard, mode } = {}) {
  const t = await transcribe(who, id, mode === "kids" ? "" : `&coaching=${coaching}`, mode === "kids" ? "de-DE" : "es-MX");
  assert.equal(t.status, 200, t.text);
  const r = await turn(who, id, message, mode === "kids" ? { mode } : { coaching });
  assert.equal(r.status, 200, r.text);
  return r;
}

async function logsOf(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

test("an adult's word that clearly didn't sound right: one block in the prompt, word marks in the reply, nothing stored", async () => {
  const sam = await someone();
  const id = await start(sam);
  let r;
  const log = await logsOf(async () => {
    r = await say(sam, id);
  });
  assert.deepEqual(azureCalls, [{ language: "es-MX", reference: "Quiero un café." }]);
  const sent = prompt();
  assert.ok(sent.includes(`${PRONUNCIATION_OPEN}\n`), sent);
  assert.ok(sent.includes(`\n- "café", word 3 of their line: didn't sound clearly like the word (which sound was off isn't known)\n`), sent);
  assert.ok(sent.includes(`${PRONUNCIATION_CLOSE}\n${WORD_PRONUNCIATION_RULES.light}`));
  const p = r.body.pronunciation;
  assert.equal(p.kind, "words");
  assert.equal(p.engine, "azure");
  assert.equal(p.text, "Quiero un café.");
  assert.equal(p.locale, "es-MX");
  assert.deepEqual(p.words.map((w) => [w.text, w.verdict, w.score]), [["Quiero", "ok", 95], ["un", "ok", 97], ["café", "off", 12]]);
  assert.equal(p.overall, null);
  assert.equal(p.clipId, undefined);
  // Nothing is kept: no check row, no clip, and the turn is saved as ever.
  assert.equal(r.body.saved, true);
  assert.deepEqual(await checksOf(testDb.db, profileOf(sam), id), []);
  assert.equal(fs.existsSync(path.join(clipsDir, id)), false);
  // The log names the count only.
  assert.match(log, /pronunciation \(live\): azure \(words\), 3 words/);
  assert.doesNotMatch(log, /café|Quiero/);
});

test("said right, or a miss the live bar doesn't vouch for: marks, and a prompt with nothing added", async () => {
  const sam = await someone();
  const id = await start(sam);
  azure = RIGHT;
  const ok = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.deepEqual(ok.body.pronunciation.words.map((w) => w.verdict), ["ok", "ok", "ok"]);
  // Under the explicit check's 30, not under the live 20: not sure.
  azure = () => reply([["Quiero", 95], ["un", 97], ["café", 25, "Mispronunciation"]]);
  const low = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.deepEqual(low.body.pronunciation.words.map((w) => [w.verdict, w.reason ?? null]), [["ok", null], ["ok", null], ["unsure", "live_bar"]]);
  // A word Azure didn't hear: the transcript and Azure disagree, nothing flags.
  heard = "Quiero un café con leche y pan";
  azure = () => reply([["Quiero", 95], ["un", 0, "Omission"], ["café", 3, "Mispronunciation"], ["con", 95], ["leche", 95], ["y", 95], ["pan", 95]]);
  const om = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.deepEqual(om.body.pronunciation.words.map((w) => w.verdict), ["ok", "unsure", "unsure", "ok", "ok", "ok", "ok"]);
  // Most of a short line off: more likely a misheard line. No marks at all.
  heard = "Quiero un café.";
  azure = () => reply([["Quiero", 0, "Omission"], ["un", 97], ["café", 3, "Mispronunciation"]]);
  const most = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.equal(most.body.pronunciation, undefined);
  // Azure heard none of it: no marks at all.
  azure = () => reply([["Quiero", 0, "Omission"], ["un", 0, "Omission"], ["café", 0, "Omission"]]);
  const none = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.equal(none.body.pronunciation, undefined);
});

test("the dial: strict asks for the word again without naming a sound; off checks nothing", async () => {
  const sam = await someone();
  const id = await start(sam);
  await say(sam, id, { coaching: "strict" });
  assert.ok(prompt().includes(`${PRONUNCIATION_CLOSE}\n${WORD_PRONUNCIATION_RULES.strict}`));
  azureCalls.length = 0;
  const off = await say(sam, id, { coaching: "off" });
  assert.equal(azureCalls.length, 0);
  assert.equal(off.body.pronunciation, undefined);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  // Scored with the dial on, switched off before the turn: unused.
  assert.equal((await transcribe(sam, id, "&coaching=light")).status, 200);
  const later = await turn(sam, id, heard, { coaching: "off" });
  assert.equal(later.body.pronunciation, undefined);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  for (const bad of ["loud", "1"]) assert.equal((await transcribe(sam, id, `&coaching=${bad}`)).status, 400, bad);
});

test("words that aren't what was checked use nothing; punctuation and case alone still match", async () => {
  const sam = await someone();
  const id = await start(sam);
  const edited = await say(sam, id, { message: "Quiero un té." });
  assert.equal(edited.body.pronunciation, undefined);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  const same = await say(sam, id, { message: "quiero un café" });
  assert.equal(same.body.pronunciation?.kind, "words");
  assert.ok(prompt().includes(PRONUNCIATION_OPEN));
  // Another conversation's turn takes nothing.
  const other = await start(sam);
  assert.equal((await transcribe(sam, id, "&coaching=light")).status, 200);
  assert.equal((await turn(sam, other, heard, { coaching: "light" })).body.pronunciation, undefined);
});

test("no check is started without Azure's keys, for a phrase the check doesn't take, or in a language it doesn't measure", async () => {
  const sam = await someone();
  const id = await start(sam);
  fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
  const noKeys = await say(sam, id);
  assert.equal(noKeys.body.pronunciation, undefined);
  fs.writeFileSync(process.env.LINGO_ENV_FILE, WITH_AZURE);
  for (const text of ["Quiero 3 tacos.", "Quiero un café y un 茶.", Array(13).fill("hola").join(" ")]) {
    heard = text;
    const r = await say(sam, id);
    assert.equal(r.body.pronunciation, undefined, text);
  }
  const eleni = await someone([{ ...ADULT, name: "Eleni", targetLanguage: "Greek", targetVariant: "" }]);
  const gid = await start(eleni);
  heard = "Καλημέρα";
  assert.equal((await transcribe(eleni, gid, "&coaching=light", "el-GR")).status, 200);
  assert.equal((await turn(eleni, gid, heard, { coaching: "light" })).body.pronunciation, undefined);
  assert.equal(azureCalls.length, 0);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
});

test("a line in the learner's own language is never sent to Azure", async () => {
  const sam = await someone();
  const id = await start(sam);
  for (const text of ["Sorry, I don't understand.", "Can you say that again please"]) {
    heard = text;
    const r = await say(sam, id);
    assert.equal(r.body.pronunciation, undefined, text);
    assert.ok(!prompt().includes(PRONUNCIATION_OPEN), text);
  }
  assert.equal(azureCalls.length, 0);
  // One borrowed word in a line of the language is still a line of it.
  heard = "Quiero un coffee, por favor";
  azure = () => reply([["Quiero", 95], ["un", 97], ["coffee", 94], ["por", 99], ["favor", 90]]);
  const mixed = await say(sam, id);
  assert.equal(azureCalls.length, 1);
  assert.equal(mixed.body.pronunciation?.kind, "words");
  // ...and the borrowed word is never the one flagged, whatever its score.
  azure = () => reply([["Quiero", 95], ["un", 97], ["coffee", 4, "Mispronunciation"], ["por", 99], ["favor", 90]]);
  const borrowed = await say(sam, id);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.deepEqual(borrowed.body.pronunciation.words.map((w) => w.verdict), ["ok", "ok", "unsure", "ok", "ok"]);
  heard = "Quiero un café, por favor";
  azure = () => reply([["Quiero", 95], ["un", 97], ["café", 4, "Mispronunciation"], ["por", 99], ["favor", 90]]);
  await say(sam, id);
  assert.ok(prompt().includes(PRONUNCIATION_OPEN));
});

/** An Azure call that never answers until its signal aborts. */
function hanging(counts) {
  return () =>
    new Promise((_, reject) => {
      counts.started++;
      const signal = counts.signal();
      const stop = () => {
        counts.aborted++;
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
}
async function until(ok, what) {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a word check that comes too late is dropped and stopped at once, and the next turn's check runs", async () => {
  const sam = await someone();
  const id = await start(sam);
  const counts = { started: 0, aborted: 0, signal: () => lastSignal };
  const savedLive = { ...LIVE };
  try {
    azure = hanging(counts);
    LIVE.waitMs = 100;
    assert.equal((await transcribe(sam, id, "&coaching=light")).status, 200);
    await until(() => counts.started === 1, "the live Azure call");
    const late = await turn(sam, id, heard, { coaching: "light" });
    assert.equal(late.status, 200, late.text);
    assert.equal(late.body.pronunciation, undefined);
    assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
    await until(() => counts.aborted === 1, "the late call's abort");
    // The user's live Azure slot was given back: the next check is made and used.
    Object.assign(LIVE, savedLive);
    azure = MISSED;
    const next = await say(sam, id);
    assert.equal(next.body.pronunciation?.kind, "words");
    assert.ok(prompt().includes(PRONUNCIATION_OPEN));
  } finally {
    Object.assign(LIVE, savedLive);
  }
});

test("a newer transcription stops the older one's word check and starts its own", async () => {
  const sam = await someone();
  const id = await start(sam);
  const counts = { started: 0, aborted: 0, signal: () => lastSignal };
  azure = hanging(counts);
  assert.equal((await transcribe(sam, id, "&coaching=light")).status, 200);
  await until(() => counts.started === 1, "the first call");
  assert.equal((await transcribe(sam, id, "&coaching=light")).status, 200);
  await until(() => counts.aborted === 1, "the first call's abort");
  // Not skipped as busy: the replaced check's slot was given back.
  await until(() => counts.started === 2, "the second call");
  clearLive();
  await until(() => counts.aborted === 2, "the second call's abort");
});

test("Azure failing never breaks the turn: no marks, nothing added, the failure's kind in the log only", async () => {
  const sam = await someone();
  const id = await start(sam);
  azure = () => new Response("{}", { status: 500 });
  let r;
  const log = await logsOf(async () => {
    r = await say(sam, id);
  });
  assert.equal(r.body.pronunciation, undefined);
  assert.ok(!prompt().includes(PRONUNCIATION_OPEN));
  assert.match(log, /words not checked \(failed\)/);
  assert.doesNotMatch(log, /café/);
});

test("kids: the gentle rule, no marks, nothing stored, and no dial", async () => {
  const pip = await someone([KID]);
  const id = await start(pip, "kids");
  heard = "Die Kuh macht muh.";
  azure = () => reply([["Die", 95], ["Kuh", 8, "Mispronunciation"], ["macht", 95], ["muh", 95]]);
  const r = await say(pip, id, { mode: "kids" });
  assert.deepEqual(azureCalls, [{ language: "de-DE", reference: "Die Kuh macht muh." }]);
  const sent = prompt();
  assert.ok(sent.includes(`- "Kuh", word 2 of their line: `), sent);
  assert.ok(sent.includes(`${PRONUNCIATION_CLOSE}\n${PRONUNCIATION_RULES.kids}`));
  assert.equal(r.body.pronunciation, undefined);
  assert.deepEqual(await checksOf(testDb.db, profileOf(pip), id), []);
  assert.equal((await transcribe(pip, id, "&coaching=light", "de-DE")).status, 400);
});
