// A stand-in `claude` for the HTTP tests of the voice turn: put first on
// PATH, it answers with the text in `reply` after `delay` ms (both files,
// read on every run, so a test can change them) and appends a mark to `ran`
// per run. The last run's argv is kept too (`lastArgs()`), so a test can
// read the prompt it was given. Nothing real is spawned and no provider is reachable. Not a test
// itself (the npm glob is *.test.mjs).
//
// A post-session extraction call (its system prompt is the recap's) is
// answered from its own files instead, so a voice test's run count never
// includes the recap that ending a conversation starts: an empty recap by
// default, `recap(text, delay)` to change it, "!fail" to exit 1 the way a
// failed CLI run does, and `recapRuns()` counts them. A cloze generation
// call (Practice's fill the gap) likewise: `cloze(text, delay)`,
// `clozeRuns()`, `clozeArgs()`; by default `{"items": []}`. History's daily
// digest likewise: `digest(text, delay)`, `digestRuns()`, `digestArgs()`.
//
//   const fake = fakeClaude();
//   before(() => fake.install());  after(() => fake.restore());
//   fake.answer("NARRATOR-F: Hola.", 400);  fake.runs();
//   fake.answers(["LOOKUP: market", "NARRATOR-F: Hola."]);  // one per run, the last repeating
//   fake.argsLog();  // every non-recap run's argv since the last answer()/answers()
//   fake.recap(JSON.stringify({ summary: "…", keep: [], events: [], corrections: [] }));  fake.recapRuns();
//   fake.mcpConfig();  // the last non-recap run's --mcp-config file, parsed (the server deletes it after the run)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EMPTY_RECAP = JSON.stringify({ summary: "", keep: [], events: [], corrections: [] });

export function fakeClaude() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-fake-claude-"));
  const files = {
    reply: path.join(bin, "reply.txt"),
    delay: path.join(bin, "delay.txt"),
    ran: path.join(bin, "ran"),
    args: path.join(bin, "args.json"),
    recap: path.join(bin, "recap.txt"),
    recapDelay: path.join(bin, "recap-delay.txt"),
    recapRan: path.join(bin, "recap-ran"),
    recapArgs: path.join(bin, "recap-args.json"),
    digest: path.join(bin, "digest.txt"),
    digestDelay: path.join(bin, "digest-delay.txt"),
    digestRan: path.join(bin, "digest-ran"),
    digestArgs: path.join(bin, "digest-args.json"),
    cloze: path.join(bin, "cloze.txt"),
    clozeDelay: path.join(bin, "cloze-delay.txt"),
    clozeRan: path.join(bin, "cloze-ran"),
    clozeArgs: path.join(bin, "cloze-args.json"),
    replies: path.join(bin, "replies.json"),
    argsLog: path.join(bin, "args.jsonl"),
    mcp: path.join(bin, "mcp.json"),
  };
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
const files = ${JSON.stringify(files)};
const args = process.argv.slice(2);
// A recap or a cloze generation call is a side channel with its own files.
const side = args.some((a) => a.startsWith("You review one finished practice session"))
  ? "recap"
  : args.some((a) => a.startsWith("You write fill-in-the-blank practice sentences"))
    ? "cloze"
    : args.some((a) => a.startsWith("You write a short weekly progress note"))
      ? "digest"
      : null;
fs.appendFileSync(side ? files[side + "Ran"] : files.ran, "x");
fs.writeFileSync(side ? files[side + "Args"] : files.args, JSON.stringify(args));
if (!side) fs.appendFileSync(files.argsLog, JSON.stringify(args) + "\\n");
const mcpAt = args.indexOf("--mcp-config");
if (!side && mcpAt >= 0) fs.copyFileSync(args[mcpAt + 1], files.mcp);
let text = fs.readFileSync(side ? files[side] : files.reply, "utf8");
// A sequence (answers()): the nth run since it was set takes the nth reply.
if (!side && fs.existsSync(files.replies)) {
  const list = JSON.parse(fs.readFileSync(files.replies, "utf8"));
  const n = fs.readFileSync(files.argsLog, "utf8").split("\\n").filter(Boolean).length;
  text = list[Math.min(n, list.length) - 1];
}
const delay = Number(fs.readFileSync(side ? files[side + "Delay"] : files.delay, "utf8")) || 0;
setTimeout(() => {
  if (text === "!fail") {
    process.stderr.write("something broke");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ type: "result", result: text, duration_ms: 1234, total_cost_usd: 0.0125 }));
}, delay);
`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  const count = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0);
  const self = {
    answer(text, delay = 0) {
      fs.writeFileSync(files.reply, text);
      fs.writeFileSync(files.delay, String(delay));
      fs.rmSync(files.replies, { force: true });
      fs.rmSync(files.argsLog, { force: true });
    },
    /** One reply per run from now on, in order; the last repeats. */
    answers(list, delay = 0) {
      self.answer(list[list.length - 1], delay);
      fs.writeFileSync(files.replies, JSON.stringify(list));
    },
    /** The argv of every non-recap run since the last answer()/answers(). */
    argsLog: () => (fs.existsSync(files.argsLog) ? fs.readFileSync(files.argsLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    runs: () => count(files.ran),
    /** The next extraction calls' reply (a JSON string, or "!fail"). */
    recap(text, delay = 0) {
      fs.writeFileSync(files.recap, text);
      fs.writeFileSync(files.recapDelay, String(delay));
    },
    recapRuns: () => count(files.recapRan),
    /** The next cloze generation calls' reply (a JSON string, or "!fail"). */
    cloze(text, delay = 0) {
      fs.writeFileSync(files.cloze, text);
      fs.writeFileSync(files.clozeDelay, String(delay));
    },
    clozeRuns: () => count(files.clozeRan),
    /** The next digest calls' reply (History's weekly note), or "!fail". */
    digest(text, delay = 0) {
      fs.writeFileSync(files.digest, text);
      fs.writeFileSync(files.digestDelay, String(delay));
    },
    digestRuns: () => count(files.digestRan),
    /** The argv of the last digest call. */
    digestArgs: () => (fs.existsSync(files.digestArgs) ? JSON.parse(fs.readFileSync(files.digestArgs, "utf8")) : null),
    /** The argv of the last cloze generation call. */
    clozeArgs: () => (fs.existsSync(files.clozeArgs) ? JSON.parse(fs.readFileSync(files.clozeArgs, "utf8")) : null),
    /** The argv of the last extraction call. */
    recapArgs: () => (fs.existsSync(files.recapArgs) ? JSON.parse(fs.readFileSync(files.recapArgs, "utf8")) : null),
    /** The argv of the last run that wasn't a recap (no "claude"), or null before any. */
    lastArgs: () => (fs.existsSync(files.args) ? JSON.parse(fs.readFileSync(files.args, "utf8")) : null),
    /** The last non-recap run's --mcp-config file, parsed, or null. */
    mcpConfig: () => (fs.existsSync(files.mcp) ? JSON.parse(fs.readFileSync(files.mcp, "utf8")) : null),
    install() {
      process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    },
    restore() {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
  self.answer("NARRATOR-F: Hola.");
  self.recap(EMPTY_RECAP);
  self.cloze(JSON.stringify({ items: [] }));
  self.digest(JSON.stringify({ digest: "You practised a lot this week." }));
  return self;
}
