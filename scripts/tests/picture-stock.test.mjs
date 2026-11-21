// The shared stock pictures' functions and CLI (scripts/picture-stock.mjs,
// docs/DATA.md §Stock pictures): idempotent drawing in the current theme,
// the dry run, --limit, a clean stop on 402/429, a refusal skipped, the
// credits counted from each submit, a new theme starting a fresh set, and
// adding a concept to the list. A stub provider: nothing here reaches one.
//   node --test scripts/tests/picture-stock.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addStockConcept, drawnStock, listStock, parseArgs, removeStockPicture, runStock } from "../picture-stock.mjs";
import { PICTURE_THEME } from "../pictures.mjs";

const LIST = `# a comment that stays
categories:
  Animals:
    - { id: dog, description: a friendly brown dog, words: [dog] }
    - { id: cat, description: a fluffy orange cat, words: [cat] }
  Toys:
    - { id: ball, description: a colourful ball, words: [ball] }
`;

function setup() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-stock-cli-"));
  const root = path.join(top, "content");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "pictures.yaml"), LIST);
  return { top, root, dir: path.join(top, "images") };
}

/** A stub provider: a JPEG per prompt, 0.8 credits; `fail` maps a call's
 *  number to an error to throw instead. */
function stubProvider(fail = {}) {
  const prompts = [];
  return {
    prompts,
    async draw(prompt) {
      prompts.push(prompt);
      const err = fail[prompts.length];
      if (err) throw err;
      return { bytes: Buffer.from([0xff, 0xd8, 0xff, prompts.length]), type: "image/jpeg", credits: 0.8 };
    },
  };
}
class ImageFailed extends Error {
  constructor(m, status) {
    super(m);
    this.status = status;
  }
}
class ImageRefused extends Error {}

test("draws each concept with no file once, in the theme; a second run draws nothing", async () => {
  const { top, root, dir } = setup();
  const lines = [];
  const p = stubProvider();
  const out = await runStock({ provider: p, root, dir, log: (l) => lines.push(l) });
  assert.deepEqual([out.drawn, out.missing, out.stopped], [3, 0, null]);
  assert.equal(Math.round(out.credits * 10), 24, "the credits each submit billed");
  assert.equal(p.prompts.length, 3);
  assert.ok(p.prompts.every((x) => x.startsWith(PICTURE_THEME.style[0])));
  assert.deepEqual(fs.readdirSync(path.join(dir, "stock", PICTURE_THEME.id)).sort(), ["ball.jpg", "cat.jpg", "dog.jpg"]);
  assert.match(lines.at(-1), /Drew 3 picture\(s\) for 2\.4 credits/);
  const again = await runStock({ provider: p, root, dir, log: () => {} });
  assert.equal(again.drawn, 0);
  assert.equal(p.prompts.length, 3, "idempotent: nothing drawn twice");
  assert.equal(drawnStock({ root, dir }).length, 3);
  fs.rmSync(top, { recursive: true, force: true });
});

test("--dry-run names the theme, lists what it would draw and the cost, and draws nothing; --limit bounds a run", async () => {
  const { top, root, dir } = setup();
  const lines = [];
  const p = stubProvider();
  await runStock({ provider: p, root, dir, dryRun: true, limit: 2, log: (l) => lines.push(l) });
  assert.equal(p.prompts.length, 0);
  assert.ok(!fs.existsSync(dir));
  const text = lines.join("\n");
  assert.match(text, /Picture theme cream-outline-1 \(seed 7\): 3 stock concepts, 0 drawn, 3 to draw/);
  assert.match(text, /would draw dog \(Animals\): a friendly brown dog\n {2}would draw cat/);
  assert.doesNotMatch(text, /would draw ball/);
  assert.match(text, /Would draw 2 picture\(s\): about 1\.6 credits \(\$0\.02\)\. All 3 left: about 2\.4 credits/);
  const out = await runStock({ provider: p, root, dir, limit: 1, log: () => {} });
  assert.deepEqual([out.drawn, out.missing], [1, 2]);
  assert.deepEqual(parseArgs(["--limit", "3", "--dry-run"]), { limit: 3, dryRun: true });
  assert.deepEqual(parseArgs(["--limit=0"]), { limit: 0, dryRun: false });
  assert.ok(parseArgs(["--limit", "x"]).error);
  assert.ok(parseArgs(["--all"]).error);
  fs.rmSync(top, { recursive: true, force: true });
});

test("stops cleanly at 402 or 429 with what it drew kept; a refusal is skipped and the run goes on", async () => {
  const { top, root, dir } = setup();
  const lines = [];
  const out = await runStock({ provider: stubProvider({ 2: new ImageFailed("out of credits", 402) }), root, dir, log: (l) => lines.push(l) });
  assert.deepEqual([out.drawn, out.stopped, out.missing], [1, 402, 2]);
  assert.match(lines.join("\n"), /stopped at cat: out of credits/);
  const rate = await runStock({ provider: stubProvider({ 1: new ImageFailed("busy", 429) }), root, dir, log: () => {} });
  assert.deepEqual([rate.drawn, rate.stopped], [0, 429]);
  const refused = await runStock({ provider: stubProvider({ 1: new ImageRefused("moderated") }), root, dir, log: () => {} });
  assert.deepEqual([refused.drawn, refused.refused, refused.stopped, refused.missing], [1, 1, null, 1]);
  fs.rmSync(top, { recursive: true, force: true });
});

test("a new theme is a fresh set: the old theme's files aren't counted as drawn", async () => {
  const { top, root, dir } = setup();
  await runStock({ provider: stubProvider(), root, dir, log: () => {} });
  const next = { ...PICTURE_THEME, id: "cream-outline-2" };
  assert.equal(listStock({ root, dir, theme: next.id }).filter((c) => c.drawn).length, 0);
  const p = stubProvider();
  const out = await runStock({ provider: p, root, dir, theme: next, log: () => {} });
  assert.equal(out.drawn, 3);
  assert.ok(fs.existsSync(path.join(dir, "stock", "cream-outline-1", "dog.jpg")), "the old set is left as it was");
  removeStockPicture("dog", { dir, theme: next.id });
  assert.equal(listStock({ root, dir, theme: next.id }).find((c) => c.id === "dog").drawn, null);
  assert.throws(() => removeStockPicture("../dog", { dir }));
  fs.rmSync(top, { recursive: true, force: true });
});

test("a concept is added to the list by the list's own rules, the file's comments kept", () => {
  const { top, root } = setup();
  const ok = addStockConcept({ id: "kite", category: "Toys", description: "a red kite flying", words: ["kite"] }, { root });
  assert.equal(ok.concept.id, "kite");
  const text = fs.readFileSync(path.join(root, "pictures.yaml"), "utf8");
  assert.match(text, /# a comment that stays/);
  assert.match(text, /- \{ id: kite, description: a red kite flying, words: \[ kite \] \}/);
  assert.ok(addStockConcept({ id: "kite", category: "Toys", description: "another kite", words: ["kite"] }, { root }).error, "a duplicate id");
  assert.ok(addStockConcept({ id: "x", category: "Toys", description: "!!", words: ["x"] }, { root }).error, "nothing to draw");
  assert.ok(addStockConcept({ id: "boat", category: "New", description: "a little boat", words: ["boat"] }, { root }).concept);
  assert.equal(listStock({ root, dir: path.join(top, "images") }).length, 5);
  fs.rmSync(top, { recursive: true, force: true });
});
