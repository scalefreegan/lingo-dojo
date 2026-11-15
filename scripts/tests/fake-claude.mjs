// A stand-in `claude` for the HTTP tests of the voice turn: put first on
// PATH, it answers with the text in `reply` after `delay` ms (both files,
// read on every run, so a test can change them) and appends a mark to `ran`
// per run. Nothing real is spawned and no provider is reachable. Not a test
// itself (the npm glob is *.test.mjs).
//
// A post-session extraction call (its system prompt is the recap's) is
// answered from its own files instead, so a voice test's run count never
// includes the recap that ending a conversation starts: an empty recap by
// default, `recap(text, delay)` to change it, "!fail" to exit 1 the way a
// failed CLI run does, and `recapRuns()` counts them.
//
//   const fake = fakeClaude();
//   before(() => fake.install());  after(() => fake.restore());
//   fake.answer("NARRATOR-F: Hola.", 400);  fake.runs();
//   fake.recap(JSON.stringify({ summary: "…", keep: [], events: [], corrections: [] }));  fake.recapRuns();

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
    recap: path.join(bin, "recap.txt"),
    recapDelay: path.join(bin, "recap-delay.txt"),
    recapRan: path.join(bin, "recap-ran"),
    recapArgs: path.join(bin, "recap-args.json"),
  };
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
const files = ${JSON.stringify(files)};
const args = process.argv.slice(2);
const recap = args.some((a) => a.startsWith("You review one finished practice session"));
fs.appendFileSync(recap ? files.recapRan : files.ran, "x");
if (recap) fs.writeFileSync(files.recapArgs, JSON.stringify(args));
const text = fs.readFileSync(recap ? files.recap : files.reply, "utf8");
const delay = Number(fs.readFileSync(recap ? files.recapDelay : files.delay, "utf8")) || 0;
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
    },
    runs: () => count(files.ran),
    /** The next extraction calls' reply (a JSON string, or "!fail"). */
    recap(text, delay = 0) {
      fs.writeFileSync(files.recap, text);
      fs.writeFileSync(files.recapDelay, String(delay));
    },
    recapRuns: () => count(files.recapRan),
    /** The argv of the last extraction call. */
    recapArgs: () => (fs.existsSync(files.recapArgs) ? JSON.parse(fs.readFileSync(files.recapArgs, "utf8")) : null),
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
  return self;
}
