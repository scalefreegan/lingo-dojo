// The export CLI end to end, in a child process, against the fixture library
// (LINGO_CONTENT_DIR) and a temp exports dir (LINGO_EXPORTS_DIR), so it never
// writes into the real exports/.
//   node --test scripts/tests/export.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, loadPackFiles } from "../content.mjs";
import { assemble } from "../assemble.mjs";
import { FIXTURE, write } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "export.mjs");

function cli(args, exportsDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, LINGO_CONTENT_DIR: FIXTURE, LINGO_EXPORTS_DIR: exportsDir },
  });
}

test("writes exports/<id>.md, prints the path and stats; output equals assemble()", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));
  const exportsDir = path.join(out, "nested", "exports"); // mkdir -p
  const packFile = path.join(FIXTURE, "packs", "2026-10-19-market-gentle.yaml");
  const r = cli([packFile], exportsDir);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(exportsDir, "2026-10-19-market-gentle.md");
  const [printedPath, statsLine] = r.stdout.trim().split("\n");
  assert.equal(printedPath, file);
  assert.match(statsLine, /^\d+ words, ~\d+ tokens$/);
  const content = loadContent(FIXTURE);
  assert.equal(fs.readFileSync(file, "utf8"), assemble(content, loadPackFiles(FIXTURE).packs[0]).markdown);
});

test("warnings go to stderr and do not fail the export; a bad pack exits 1", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));
  const warnPack = write(out, "2026-10-21-warn.yaml", "title: Warn\nunits: [ghost]\n");
  const ok = cli([warnPack], out);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /warning: Unknown unit "ghost"/);
  assert.match(ok.stderr, /warning: Required slot "Introduction" has no unit selected\./);

  const badPack = write(out, "2026-10-21-bad.yaml", "units: [intro-native]\n");
  const bad = cli([badPack], out);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing required key\(s\): title/);
  assert.ok(!fs.existsSync(path.join(out, "2026-10-21-bad.md")));

  const usage = cli([], out);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
});
