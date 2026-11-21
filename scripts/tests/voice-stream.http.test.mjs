// The streamed voice turn over HTTP (docs/VOICE.md §Streaming the reply):
// POST /api/voice/turn with Accept: text/event-stream on the real plugin,
// against a stand-in `claude` that writes stream-json the way the CLI does,
// a piece at a time with pauses. What it pins: the first line is out while
// the run is still writing; the whole reply follows and is what is stored;
// a plain request is still plain JSON; Stop (the request closing) kills the
// run and frees the turn lock; a failure after the first line is an `error`
// event; a LOOKUP still reruns. Nothing real is spawned and no provider is
// reachable.
//   node --test scripts/tests/voice-stream.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");

/**
 * A `claude` first on PATH that streams. Each run takes the next script in
 * `scripts.json` (the last repeating): a list of steps, each `{text}` (one
 * text delta), `{wait}` (ms) or `{fail}` (exit 1 with that on stderr); then
 * the result envelope with the whole text. Its pid goes to `pid`, and its
 * argv to `args.json`.
 */
function streamingClaude() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-stream-claude-"));
  const f = { scripts: path.join(bin, "scripts.json"), runs: path.join(bin, "runs"), pid: path.join(bin, "pid"), args: path.join(bin, "args.json") };
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
const f = ${JSON.stringify(f)};
fs.writeFileSync(f.pid, String(process.pid));
fs.writeFileSync(f.args, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(f.runs, "x");
const n = fs.readFileSync(f.runs, "utf8").length;
const all = JSON.parse(fs.readFileSync(f.scripts, "utf8"));
const steps = all[Math.min(n, all.length) - 1];
// As the CLI: events only for stream-json; \`json\` prints the envelope alone.
const streams = process.argv.includes("stream-json");
const out = (o) => streams && process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", tools: [] });
let text = "";
(async () => {
  for (const s of steps) {
    if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
    if (s.fail) { process.stderr.write(s.fail); process.exit(1); }
    if (s.text) {
      text += s.text;
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s.text } }, parent_tool_use_id: null });
    }
  }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, duration_ms: 1234, total_cost_usd: 0.0125 }));
})();
`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  const self = {
    /** One script per run from now on, the last repeating. */
    scripts(list) {
      fs.writeFileSync(f.scripts, JSON.stringify(list));
      fs.rmSync(f.runs, { force: true });
    },
    runs: () => (fs.existsSync(f.runs) ? fs.readFileSync(f.runs, "utf8").length : 0),
    pid: () => Number(fs.readFileSync(f.pid, "utf8")),
    args: () => JSON.parse(fs.readFileSync(f.args, "utf8")),
    install() {
      process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    },
    restore() {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
  return self;
}

const fake = streamingClaude();
const testDb = await freshDb();
let base, close, sam;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
  await addUser(testDb.db, "robin", undefined, { learners: [ADULT] });
  sam = client(base);
  await sam.login("robin");
  await sam.pick("Sam");
});
after(async () => {
  await close();
  await testDb.close();
  fake.restore();
});

const pack = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };
const body = (extra = {}) => ({ mode: "adult", pack, history: [], message: "", elapsedMs: 0, ...extra });

/** POST a turn asking for the stream; every SSE event with the ms since the
 *  request went out. `abortAfterFirstLine` closes the request then. */
async function streamTurn(b, { abortAfterFirstLine = false } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/voice/turn`, {
    method: "POST",
    signal: ctrl.signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      Cookie: sam.jar.cookie,
      "X-Learner-Id": sam.learnerId,
      "X-Language-Profile-Id": sam.languageId,
    },
    body: JSON.stringify(b),
  });
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/event-stream")) return { status: res.status, type, json: await res.json(), events: [] };
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
        events.push({ event, data, ms: Date.now() - t0 });
        if (abortAfterFirstLine && event === "line") {
          ctrl.abort();
          return { status: res.status, type, events };
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
  return { status: res.status, type, events };
}

const MARKET = [
  { text: "NARRATOR-F: Welcome to the market. Ask for <t>jitom" },
  { text: "ates</t>.\nCAST: CHARACTER-M old, Don Pepe, the vendor\n" },
  { text: "CHARACTER-M: <t>¡Buenos días!</t>\n" },
  // The rest of the reply is a while coming: the first lines are long out.
  { wait: 900 },
  { text: "NARRATOR-F: Answer him.\nGLOSS: ¡Buenos días! = Good morning!\nSTAGE: scene" },
];

test("streamed: the first lines are out while the run is still writing; the reply follows, its lines starting with them", async () => {
  fake.scripts([MARKET]);
  const r = await streamTurn(body());
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/event-stream/);
  const lines = r.events.filter((e) => e.event === "line");
  const reply = r.events.find((e) => e.event === "reply");
  assert.ok(reply, JSON.stringify(r.events));
  assert.equal(r.events.at(-1).event, "reply", "the reply is the last event");
  assert.ok(lines.length >= 2, `${lines.length} lines streamed`);
  assert.deepEqual(lines.map((l) => l.data.index), lines.map((_, i) => i), "in order, from 0");
  // The narrator's first line (and the character's) before the 900 ms pause ended.
  assert.ok(reply.ms - lines[0].ms >= 700, `first line at ${lines[0].ms} ms, reply at ${reply.ms} ms`);
  assert.equal(lines[0].data.line.text, "Welcome to the market. Ask for jitomates.");
  // The character's line came with its CAST note, so its voice is drawn first.
  assert.deepEqual(lines[1].data.castNotes, [{ slot: "character:male", age: "old", who: "Don Pepe, the vendor" }]);
  assert.deepEqual(reply.data.lines.slice(0, lines.length), lines.map((l) => l.data.line));
  assert.equal(reply.data.lines.length, 3);
  assert.equal(reply.data.stage, "scene");
  assert.deepEqual(reply.data.glosses, [{ term: "¡Buenos días!", meaning: "Good morning!" }]);
  // Still a run with no tools at all, now asking for stream-json.
  const args = fake.args();
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose") && args.includes("--include-partial-messages"));
});

test("a plain request (no Accept: text/event-stream) is the same reply as JSON; so is a stream whose lines weren't final before the end", async () => {
  fake.scripts([MARKET]);
  const plain = await sam.call("POST", "/api/voice/turn", body());
  assert.equal(plain.status, 200, plain.text);
  fake.scripts([MARKET]);
  const streamed = await streamTurn(body());
  const reply = streamed.events.find((e) => e.event === "reply").data;
  const strip = ({ durationMs, costUsd, ...rest }) => rest;
  assert.deepEqual(strip(reply), strip(plain.body));
  // One line, no GLOSS: nothing is final before the run ends, so JSON.
  fake.scripts([[{ text: "NARRATOR-F: Hola.\n" }, { text: "y más" }]]);
  const whole = await streamTurn(body());
  assert.equal(whole.status, 200);
  assert.match(whole.type, /^application\/json/);
  assert.equal(whole.json.lines[0].text, "Hola. y más");
});

test("a streamed turn of a saved conversation stores the whole reply, the lines heard first included", async () => {
  const made = await sam.call("POST", "/api/conversations", { mode: "adult", pack, title: "At the market" });
  assert.equal(made.status, 201, made.text);
  const c = made.body.conversation;
  fake.scripts([MARKET]);
  const r = await streamTurn(body({ conversationId: c.id }));
  const reply = r.events.find((e) => e.event === "reply").data;
  assert.equal(reply.saved, true);
  const g = await sam.call("GET", `/api/conversations/${c.id}`);
  const master = g.body.turns.find((t) => t.role === "master");
  assert.deepEqual(master.lines, reply.lines);
  assert.deepEqual(master.glosses, reply.glosses);
});

/** Whether a process is still running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Stop mid-stream (the request closes): the claude process is killed, and the turn lock is free at once", async () => {
  fake.scripts([[...MARKET.slice(0, 3), { wait: 20_000 }, { text: "NARRATOR-F: never.\n" }]]);
  const r = await streamTurn(body(), { abortAfterFirstLine: true });
  assert.equal(r.events[0].event, "line");
  const pid = fake.pid();
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(alive(pid), false, "the run was killed, not left to finish");
  // The lock was released: the next turn of this session runs.
  fake.scripts([MARKET]);
  const next = await streamTurn(body());
  assert.equal(next.status, 200);
  assert.ok(next.events.some((e) => e.event === "reply"));
});

test("a run that fails after its first line ends the stream with an error event; one that fails before is the usual JSON error", async () => {
  fake.scripts([[...MARKET.slice(0, 3), { fail: "something broke" }]]);
  const mid = await streamTurn(body());
  assert.equal(mid.status, 200);
  const last = mid.events.at(-1);
  assert.equal(last.event, "error");
  assert.equal(last.data.status, 502);
  assert.match(last.data.error, /something broke/);
  assert.ok(!mid.events.some((e) => e.event === "reply"));
  fake.scripts([[{ fail: "something broke" }]]);
  const early = await streamTurn(body());
  assert.equal(early.status, 502);
  assert.match(early.json.error, /something broke/);
});

test("a LOOKUP first holds everything back and reruns; the rerun's lines stream", async () => {
  fake.scripts([[{ text: "LOOKUP: market phrases\n" }, { text: "NARRATOR-F: ignored.\nNARRATOR-M: ignored too.\n" }], MARKET]);
  const r = await streamTurn(body());
  assert.equal(fake.runs(), 2);
  const lines = r.events.filter((e) => e.event === "line");
  assert.equal(lines[0].data.line.text, "Welcome to the market. Ask for jitomates.");
  const reply = r.events.find((e) => e.event === "reply").data;
  assert.deepEqual(reply.lines.slice(0, lines.length), lines.map((l) => l.data.line));
  assert.ok(!reply.lines.some((l) => /ignored/.test(l.text)));
});

test("a LOOKUP after lines went out is too late: no rerun, the reply stands with every spoken line", async () => {
  fake.scripts([[{ text: "NARRATOR-F: One.\nNARRATOR-M: Two.\n" }, { wait: 200 }, { text: "LOOKUP: market\nNARRATOR-F: Three.\nGLOSS: x = y" }], MARKET]);
  const r = await streamTurn(body());
  assert.equal(fake.runs(), 1, "never rerun");
  const reply = r.events.find((e) => e.event === "reply").data;
  assert.deepEqual(reply.lines.map((l) => l.text), ["One.", "Two.", "Three."]);
});
