// Pronunciation in live conversation end to end (stage 2, ld-ne0.3;
// docs/VOICE.md §Pronunciation in conversation, docs/DATA.md §Pronunciation
// in sessions): a Go-tab recording is transcribed (ElevenLabs, stubbed in
// fetch: nothing reaches the network), its tone check starts there on the
// local scorer (no Azure keys: no paid call of any kind), and the turn that
// sends those words picks it up: a clear miss puts one block into the turn
// prompt (a stand-in `claude` records it), the adult's reply carries the
// line's marks, and the turn's row keeps the check and, for a flagged turn,
// its clip, served only to its own learner and gone with the conversation.
// Kids: the gentle rule, no marks, no rows, no clips, no dial. A scorer that
// fails, words that differ from what was scored and a late score all leave
// the turn as it was. The real plugin on an in-process PGlite; the speech
// is generated (scripts/pronunciation-synth.mjs). Every name is made up.
//   node --test scripts/tests/pronunciation-live.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "../pronunciation.mjs";
import { readScoreAudio, SCORE_MAX_BYTES } from "../pronunciation-app.mjs";
import { speak } from "../pronunciation-synth.mjs";
import { PRONUNCIATION_CLOSE, PRONUNCIATION_OPEN, PRONUNCIATION_RULES } from "../voice.mjs";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-live-pron-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_CLIPS_DIR;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
// ElevenLabs for speech-to-text (stubbed below); no Azure: the local scorer.
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
const clipsDir = path.join(dataDir, "clips");

/* Speech-to-text, stubbed: it "hears" `heard`. Any other host is refused. */
let heard = "妈";
let sttCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.elevenlabs.io" && url.pathname === "/v1/speech-to-text") {
    sttCalls++;
    return new Response(JSON.stringify({ text: heard }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  // Azure, stubbed (only in the tests that write its keys): a call that
  // never answers until its signal aborts (`azureHangs`), else a 500 (the
  // local scorer answers instead). Nothing reaches Azure.
  if (url.hostname.endsWith(".stt.speech.microsoft.com")) {
    azureStarted++;
    if (!azureHangs) return new Response("{}", { status: 500 });
    return new Promise((_, reject) => {
      const signal = init?.signal;
      const stop = () => {
        azureAborted++;
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
  }
  throw new Error(`unexpected fetch to ${url.hostname}`);
};
let azureHangs = false;
let azureStarted = 0;
let azureAborted = 0;
/** Azure's keys in the env file for the length of `fn` (read per call, as
 *  the app reads them: no restart). */
async function withAzure(fn) {
  const file = process.env.LINGO_ENV_FILE;
  const saved = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, `${saved}AZURE_SPEECH_KEY=test-azure\nAZURE_SPEECH_REGION=eastus\n`);
  try {
    return await fn();
  } finally {
    fs.writeFileSync(file, saved);
    azureHangs = false;
  }
}
/** Wait (at most 2 s) until `ok()`. */
async function until(ok, what) {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* A stand-in `claude` first on PATH: it keeps each run's arguments (the
 * system prompt and the turn prompt) and answers one line. */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-live-claude-"));
const argsFile = path.join(bin, "args.json");
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "result", result: "NARRATOR-F: <t>好。</t>" }));\n`,
  { mode: 0o755 },
);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
const prompt = () => JSON.parse(fs.readFileSync(argsFile, "utf8")).join("\n");

const { apiPlugins } = await import("../../web/server/api.ts");
const { SCORER } = await import("../../web/server/pronunciation.ts");
const { LIVE, clearLive } = await import("../../web/server/livePronunciation.ts");
const { MAX_CLIPS_PER_CONVERSATION, checksOf } = await import("../db/pronunciation.ts");

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
  heard = "妈";
});

const MANDARIN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };
const KID_MANDARIN = { ...KID, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin" };

let n = 0;
async function someone(learners = [MANDARIN]) {
  const name = `live${++n}`;
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
  const r = await who.call("POST", "/api/conversations", { mode, pack: mode === "kids" ? KIDS_PACK : ADULT_PACK, title: "Live tones" });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation.id;
}
const transcribe = (who, conversationId, wav, query = "") =>
  who.call("POST", `/api/voice/transcribe?locales=zh-CN,en-US${conversationId ? `&conversation=${conversationId}` : ""}${query}`, wav, { "Content-Type": "audio/wav" });
const turn = (who, conversationId, message, extra = {}, history = []) =>
  who.call("POST", "/api/voice/turn", { mode: extra.mode ?? "adult", pack: extra.mode === "kids" ? KIDS_PACK : ADULT_PACK, history, message, elapsedMs: 0, conversationId, conversationStart: 0, ...extra });

/** Everything logged while `fn` ran. */
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

test("an adult's clear tone miss: one block in the prompt, marks in the reply, the check and its clip kept, served to its learner only, gone with the conversation", async () => {
  const lin = await someone();
  const id = await start(lin);
  let r;
  const log = await logsOf(async () => {
    const t = await transcribe(lin, id, MISSED, "&coaching=light");
    assert.equal(t.status, 200, t.text);
    assert.equal(t.body.text, "妈");
    r = await turn(lin, id, "妈", { coaching: "light" });
  });
  assert.equal(r.status, 200, r.text);
  const sent = prompt();
  assert.ok(sent.includes(`${PRONUNCIATION_OPEN}\n`), sent);
  assert.ok(sent.includes("\n- 妈 (mā), character 1 of their line: should be tone 1 (high, level), sounded like tone 4 (falling)\n"));
  assert.ok(sent.includes(`${PRONUNCIATION_CLOSE}\n${PRONUNCIATION_RULES.light}`));
  // The marks: stage 1's shape, the miss named, no score, no frames.
  const p = r.body.pronunciation;
  assert.equal(p.engine, "local");
  assert.equal(p.text, "妈");
  assert.deepEqual(p.syllables.map((s) => [s.char, s.verdict, s.expectedTone, s.heardTone]), [["妈", "off", 1, 4]]);
  assert.equal(p.overall, null);
  assert.equal(p.frames, undefined);
  assert.match(p.clipId, /^[0-9a-f-]{36}$/);
  // Stored with the turn: one check, its clip on disk under the conversation.
  const [row, ...rest] = await checksOf(testDb.db, profileOf(lin), id);
  assert.equal(rest.length, 0);
  assert.equal(row.id, p.clipId);
  assert.deepEqual([row.engine, row.coaching, row.flagged], ["local", "light", 1]);
  assert.deepEqual(row.syllables.map((s) => [s.char, s.verdict, s.heardTone]), [["妈", "off", 4]]);
  const [learnerTurn] = await testDb.query("select id, text from turns where id = $1", [row.turnId]);
  assert.equal(learnerTurn.text, "妈");
  const file = path.join(clipsDir, id, row.clipFile);
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), MISSED);
  assert.equal(row.clipBytes, MISSED.length);
  assert.ok(row.clipMs > 500, String(row.clipMs));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // No log line carries what was said.
  assert.doesNotMatch(log, /妈|mā/);
  // Served to its own learner and language only.
  const got = await lin.call("GET", `/api/pronunciation/clips/${row.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "audio/wav");
  assert.match(got.headers.get("cache-control"), /no-store/);
  const stranger = await someone();
  assert.equal((await stranger.call("GET", `/api/pronunciation/clips/${row.id}`)).status, 404);
  assert.equal((await client(base).call("GET", `/api/pronunciation/clips/${row.id}`)).status, 401);
  assert.equal((await lin.call("GET", "/api/pronunciation/clips/not-an-id")).status, 404);
  assert.equal((await lin.call("POST", `/api/pronunciation/clips/${row.id}`)).status, 405);
  // The conversation's delete takes the row and the file.
  assert.equal((await lin.call("DELETE", `/api/conversations/${id}`)).status, 200);
  assert.deepEqual(await checksOf(testDb.db, profileOf(lin), id), []);
  assert.equal(fs.existsSync(path.join(clipsDir, id)), false);
  assert.equal((await lin.call("GET", `/api/pronunciation/clips/${row.id}`)).status, 404);
});

test("said right: the prompt carries nothing, the marks say so, the check is kept without audio", async () => {
  const lin = await someone();
  const id = await start(lin);
  await transcribe(lin, id, RIGHT);
  const r = await turn(lin, id, "妈");
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(prompt(), /PRONUNCIATION/);
  assert.deepEqual(r.body.pronunciation.syllables.map((s) => s.verdict), ["ok"]);
  assert.equal(r.body.pronunciation.clipId, undefined);
  const [row] = await checksOf(testDb.db, profileOf(lin), id);
  assert.deepEqual([row.flagged, row.clipFile, row.coaching], [0, null, "light"], "absent is light");
  assert.equal(fs.existsSync(path.join(clipsDir, id)), false);
});

test("the dial: a word or a 400 before anything is paid; strict asks for the word again; off scores nothing", async () => {
  const lin = await someone();
  const id = await start(lin);
  const before = sttCalls;
  for (const bad of ["loud", "Light", "1"]) assert.equal((await transcribe(lin, id, MISSED, `&coaching=${bad}`)).status, 400, bad);
  assert.equal(sttCalls, before, "no transcription paid for a bad word");
  for (const bad of ["loud", 1, true, ["light"]]) {
    const r = await turn(lin, id, "妈", { coaching: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /coaching must be off, light or strict/);
  }
  // Strict.
  await transcribe(lin, id, MISSED, "&coaching=strict");
  assert.equal((await turn(lin, id, "妈", { coaching: "strict" })).status, 200);
  assert.ok(prompt().includes(`${PRONUNCIATION_CLOSE}\n${PRONUNCIATION_RULES.strict}`));
  // Off: nothing scored, nothing shown, nothing kept.
  const off = await start(lin);
  await transcribe(lin, off, MISSED, "&coaching=off");
  const r = await turn(lin, off, "妈", { coaching: "off" });
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(prompt(), /PRONUNCIATION/);
  assert.equal(r.body.pronunciation, undefined);
  assert.deepEqual(await checksOf(testDb.db, profileOf(lin), off), []);
  // Turned off between the recording and the turn: not used either.
  const late = await start(lin);
  await transcribe(lin, late, MISSED, "&coaching=light");
  const r2 = await turn(lin, late, "妈", { coaching: "off" });
  assert.equal(r2.body.pronunciation, undefined);
  assert.doesNotMatch(prompt(), /PRONUNCIATION/);
});

test("words that aren't what was scored, English, a mixed or another conversation's turn: nothing", async () => {
  const lin = await someone();
  const id = await start(lin);
  // Edited in the box before sending.
  await transcribe(lin, id, MISSED);
  let r = await turn(lin, id, "他");
  assert.equal(r.body.pronunciation, undefined);
  assert.doesNotMatch(prompt(), /PRONUNCIATION/);
  // Taken once: the same words sent again later aren't scored again.
  r = await turn(lin, id, "妈", {}, [{ role: "learner", text: "他" }, { role: "master", lines: r.body.lines }]);
  assert.equal(r.body.pronunciation, undefined);
  // A code-switched or English transcript isn't scored at all.
  heard = "妈 okay";
  await transcribe(lin, id, MISSED);
  assert.equal((await turn(lin, id, "妈 okay", {}, [])).body.pronunciation, undefined);
  // Scored for one conversation, sent in another.
  heard = "妈";
  const other = await start(lin);
  await transcribe(lin, id, MISSED);
  assert.equal((await turn(lin, other, "妈")).body.pronunciation, undefined);
});

const score = (who, text, wav) => who.call("POST", `/api/pronunciation/score?text=${encodeURIComponent(text)}`, wav, { "Content-Type": "audio/wav" });

test("a live score dropped as late stops its Azure call at once, and its places are free for the next turn", async () => {
  const lin = await someone();
  const savedLive = { ...LIVE };
  try {
    await withAzure(async () => {
      azureHangs = true;
      LIVE.waitMs = 100;
      const id = await start(lin);
      const s0 = azureStarted;
      const a0 = azureAborted;
      await transcribe(lin, id, MISSED);
      await until(() => azureStarted === s0 + 1, "the live Azure call");
      const r = await turn(lin, id, "妈");
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.pronunciation, undefined);
      await until(() => azureAborted === a0 + 1, "the late call's abort");
      // The next turn's call goes out (nothing left busy) and its answer is
      // used: Azure fails (a 500 here), the local scorer answers in time.
      azureHangs = false;
      LIVE.waitMs = savedLive.waitMs;
      await transcribe(lin, id, MISSED);
      const r2 = await turn(lin, id, "妈", {}, [{ role: "learner", text: "妈" }, { role: "master", lines: r.body.lines }]);
      assert.equal(r2.status, 200, r2.text);
      assert.equal(azureStarted, s0 + 2);
      assert.deepEqual([r2.body.pronunciation?.engine, r2.body.pronunciation?.fallback], ["local", "failed"]);
    });
  } finally {
    Object.assign(LIVE, savedLive);
  }
});

test("a newer transcription stops the older one's scoring at once and starts its own", async () => {
  const lin = await someone();
  await withAzure(async () => {
    azureHangs = true;
    const id = await start(lin);
    const s0 = azureStarted;
    const a0 = azureAborted;
    await transcribe(lin, id, MISSED);
    await until(() => azureStarted === s0 + 1, "the first call");
    await transcribe(lin, id, RIGHT);
    await until(() => azureAborted === a0 + 1, "the first call's abort");
    // Not skipped as busy: the replaced score's places were given back
    // when it was stopped.
    await until(() => azureStarted === s0 + 2, "the second call");
    clearLive();
    await until(() => azureAborted === a0 + 2, "the second call's abort");
  });
});

test("an explicit tone check is never turned away by a live score in flight", async () => {
  const lin = await someone();
  const other = await someone();
  await withAzure(async () => {
    azureHangs = true;
    const id = await start(lin);
    const s0 = azureStarted;
    const a0 = azureAborted;
    await transcribe(lin, id, MISSED);
    await until(() => azureStarted === s0 + 1, "the live call");
    // While it hangs in Azure holding live scoring's worker and Azure slot,
    // the same learner's and another's explicit checks are answered (Azure
    // answers them 500: the local scorer, not a 429).
    azureHangs = false;
    for (const who of [lin, other]) {
      const r = await score(who, "妈", MISSED);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.body.engine, r.body.fallback], ["local", "failed"]);
      assert.equal(r.body.syllables[0].verdict, "off");
    }
    clearLive();
    await until(() => azureAborted === a0 + 1, "the live call's abort");
  });
});

test("a recording over the scorer's byte cap is never held, scored or kept", async () => {
  const lin = await someone();
  const id = await start(lin);
  // A valid 30-second-or-less header, then over a megabyte of junk after it.
  const big = new Uint8Array(MISSED.length + 1_200_000);
  big.set(MISSED);
  assert.equal(readScoreAudio(big).error, undefined, "the header alone would pass");
  assert.ok(big.length > SCORE_MAX_BYTES);
  assert.equal((await transcribe(lin, id, big)).status, 200);
  const r = await turn(lin, id, "妈");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.pronunciation, undefined);
  assert.doesNotMatch(prompt(), /PRONUNCIATION/);
  assert.deepEqual(await checksOf(testDb.db, profileOf(lin), id), []);
  assert.equal(fs.existsSync(path.join(clipsDir, id)), false);
});

test("a scorer that fails or is too late never breaks the turn", async () => {
  const lin = await someone();
  const saved = { ...SCORER };
  const savedLive = { ...LIVE };
  try {
    for (const body of ["process.exit(3);", "throw new Error('妈 inside the worker');"]) {
      const file = path.join(dataDir, `worker-${body.length}.mjs`);
      fs.writeFileSync(file, body);
      SCORER.worker = file;
      const id = await start(lin);
      let r;
      const log = await logsOf(async () => {
        await transcribe(lin, id, MISSED);
        r = await turn(lin, id, "妈");
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.pronunciation, undefined);
      assert.doesNotMatch(prompt(), /PRONUNCIATION/);
      assert.match(log, /scoring failed \((crash|error)\); the turn goes on without it/);
      assert.doesNotMatch(log, /妈/);
      assert.deepEqual(await checksOf(testDb.db, profileOf(lin), id), []);
    }
    // A worker that answers after the turn's wait: dropped, said so.
    const slow = path.join(dataDir, "worker-slow.mjs");
    fs.writeFileSync(slow, "await new Promise((r) => setTimeout(r, 1500)); process.exit(0);");
    SCORER.worker = slow;
    LIVE.waitMs = 150;
    const id = await start(lin);
    let r;
    const t0 = Date.now();
    const log = await logsOf(async () => {
      await transcribe(lin, id, MISSED);
      r = await turn(lin, id, "妈");
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.pronunciation, undefined);
    assert.ok(Date.now() - t0 < 1500, "the turn didn't wait for it");
    assert.match(log, /too late for its turn/);
  } finally {
    Object.assign(SCORER, saved);
    Object.assign(LIVE, savedLive);
    // Let the slow worker's slot go before the next test.
    await new Promise((r) => setTimeout(r, 1600));
  }
});

test("kids: the gentle rule, no marks, no rows, no clips, and no dial", async () => {
  const mei = await someone([KID_MANDARIN]);
  const id = await start(mei, "kids");
  assert.equal((await transcribe(mei, id, MISSED, "&coaching=light")).status, 400);
  const t = await transcribe(mei, id, MISSED);
  assert.equal(t.status, 200, t.text);
  const refused = await turn(mei, id, "妈", { mode: "kids", coaching: "light" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no coaching dial/);
  // The refused turn didn't take the score: the next one gets it.
  const r = await turn(mei, id, "妈", { mode: "kids" });
  assert.equal(r.status, 200, r.text);
  const sent = prompt();
  assert.ok(sent.includes(`${PRONUNCIATION_CLOSE}\n${PRONUNCIATION_RULES.kids}`), sent);
  assert.doesNotMatch(sent, new RegExp(PRONUNCIATION_RULES.light.slice(0, 30)));
  assert.equal(r.body.pronunciation, undefined, "no marks for a child");
  assert.deepEqual(await checksOf(testDb.db, profileOf(mei), id), []);
  assert.equal(fs.existsSync(path.join(clipsDir, id)), false, "no clip of a child's voice");
});

test("clips per conversation are capped; the checks go on without audio", async () => {
  const lin = await someone();
  const id = await start(lin);
  let history = [];
  for (let i = 0; i <= MAX_CLIPS_PER_CONVERSATION; i++) {
    await transcribe(lin, id, MISSED);
    const r = await turn(lin, id, "妈", {}, history);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.pronunciation.syllables[0].verdict, "off");
    assert.equal(!!r.body.pronunciation.clipId, i < MAX_CLIPS_PER_CONVERSATION, `turn ${i}`);
    history = [...history, { role: "learner", text: "妈" }, { role: "master", lines: r.body.lines }];
  }
  const rows = await checksOf(testDb.db, profileOf(lin), id);
  assert.equal(rows.length, MAX_CLIPS_PER_CONVERSATION + 1);
  assert.equal(rows.filter((x) => x.clipFile).length, MAX_CLIPS_PER_CONVERSATION);
  assert.equal(fs.readdirSync(path.join(clipsDir, id)).length, MAX_CLIPS_PER_CONVERSATION, "the refused clip's file is gone");
  // A browser that dropped the last reply (Stop raced it) rewrites only
  // that reply: every learner turn, so every check and clip, stays.
  await transcribe(lin, id, RIGHT);
  const r = await turn(lin, id, "妈", {}, history.slice(0, -1));
  assert.equal(r.status, 200, r.text);
  const after = await checksOf(testDb.db, profileOf(lin), id);
  assert.equal(after.length, MAX_CLIPS_PER_CONVERSATION + 2);
  assert.equal(fs.readdirSync(path.join(clipsDir, id)).length, MAX_CLIPS_PER_CONVERSATION);
});
