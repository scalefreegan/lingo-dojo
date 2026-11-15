// A stand-in `claude` for the HTTP tests of the voice turn: put first on
// PATH, it answers with the text in `reply` after `delay` ms (both files,
// read on every run, so a test can change them) and appends a mark to `ran`
// per run. Nothing real is spawned and no provider is reachable. Not a test
// itself (the npm glob is *.test.mjs).
//
//   const fake = fakeClaude();
//   before(() => fake.install());  after(() => fake.restore());
//   fake.answer("NARRATOR-F: Hola.", 400);  fake.runs();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fakeClaude() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-fake-claude-"));
  const files = { reply: path.join(bin, "reply.txt"), delay: path.join(bin, "delay.txt"), ran: path.join(bin, "ran") };
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(files.ran)}, "x");
const text = fs.readFileSync(${JSON.stringify(files.reply)}, "utf8");
const delay = Number(fs.readFileSync(${JSON.stringify(files.delay)}, "utf8")) || 0;
setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: text, duration_ms: 1234, total_cost_usd: 0.0125 })), delay);
`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  const self = {
    answer(text, delay = 0) {
      fs.writeFileSync(files.reply, text);
      fs.writeFileSync(files.delay, String(delay));
    },
    runs: () => (fs.existsSync(files.ran) ? fs.readFileSync(files.ran, "utf8").length : 0),
    install() {
      process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    },
    restore() {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
  self.answer("NARRATOR-F: Hola.");
  return self;
}
