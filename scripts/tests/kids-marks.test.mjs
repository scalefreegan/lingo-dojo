// Kids see the marks (ld-0mn, docs/VOICE.md §Kids: marks and resolving):
// an uncertain reading carries a child-friendly mark worded for the
// grown-up ("pronunciation being checked") in a kids learner's own views,
// with nothing to press there; the correction control is on the grown-up's
// side only (the Phrase bank, and the character card opened from it).
// The real components, bundled for node by the web app's own bundler
// (rolldown, Vite's) and rendered to static markup: no browser.
//   node --test scripts/tests/kids-marks.test.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "..", "web");
const require = createRequire(path.join(web, "package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

let m;
before(async () => {
  const { build } = await import(pathToFileURL(require.resolve("rolldown")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-kids-marks-"));
  const entry = path.join(dir, "entry.tsx");
  fs.writeFileSync(
    entry,
    [
      `export { ScriptContext, loadZh, rubyPieces } from ${JSON.stringify(path.join(web, "src/script/ruby.tsx"))};`,
      `export { RubyText } from ${JSON.stringify(path.join(web, "src/components/Ruby.tsx"))};`,
      `export { ReadingFix } from ${JSON.stringify(path.join(web, "src/components/ReadingFix.tsx"))};`,
    ].join("\n"),
  );
  const out = path.join(dir, "bundle.mjs");
  await build({
    input: entry,
    cwd: web,
    platform: "node",
    external: [/^react($|\/)/, /^react-dom($|\/)/],
    output: { file: out, format: "esm", codeSplitting: false },
    logLevel: "silent",
  });
  // The bundle's bare react imports resolve from web/node_modules.
  const linked = path.join(web, "node_modules", ".lingo-kids-marks.mjs");
  fs.copyFileSync(out, linked);
  try {
    m = await import(pathToFileURL(linked).href);
  } finally {
    fs.rmSync(linked, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await m.loadZh();
});

const KIDS = { stored: "pinyin", setMode: () => {}, kids: true, openChar: () => {}, languageId: null };
const ADULTS = { ...KIDS, kids: false };
const render = (value, el) => renderToStaticMarkup(React.createElement(m.ScriptContext.Provider, { value }, el));
// 你得去: the reader's dé is a guess, marked (docs/VOICE.md §Uncertain readings).
const LINE = "你得去。";

test("a kids learner's line shows the mark, worded for the grown-up, with nothing to press", () => {
  const html = render(KIDS, React.createElement(m.RubyText, { text: LINE, locale: "zh-CN", check: true }));
  assert.match(html, /ld-ruby-unsure/);
  assert.match(html, /title="Pronunciation being checked"/);
  assert.match(html, /\(pronunciation being checked\)/);
  assert.doesNotMatch(html, /<button/, "the child's own view offers no control");
  assert.doesNotMatch(html, /reading uncertain/);
});

test("the grown-up's side (the Phrase bank) makes the mark a button that opens the card", () => {
  const html = render({ ...KIDS, grownUp: true }, React.createElement(m.RubyText, { text: LINE, locale: "zh-CN", check: true }));
  assert.match(html, /<button[^>]*class="ld-unsure"[^>]*aria-label="[^"]*pronunciation being checked in 得去, check it"/);
});

test("an adult's mark is as before", () => {
  const html = render(ADULTS, React.createElement(m.RubyText, { text: LINE, locale: "zh-CN", check: true }));
  assert.match(html, /aria-label="[^"]*reading uncertain in 得去, check it"/);
  assert.doesNotMatch(html, /pronunciation being checked/i);
});

test("the correction control: never in a child's view, on the grown-up's side only", () => {
  const fix = (extra = {}) => React.createElement(m.ReadingFix, { word: "得去", reading: ["dé", "qù"], locale: "zh-CN", unsure: true, ...extra });
  assert.equal(render(KIDS, fix()), "", "a child's view: nothing");
  assert.match(render(KIDS, fix({ grownUp: true })), /This reading is wrong/, "the card opened from the grown-up's side");
  assert.match(render({ ...KIDS, grownUp: true }, fix()), /before your child learns it/, "inside the Phrase bank");
  assert.match(render(ADULTS, fix()), /This reading is wrong/);
});
