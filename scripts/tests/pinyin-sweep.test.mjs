// The CC-CEDICT sweep's comparison rules (scripts/pinyin-sweep.mjs, run by
// hand): no dictionary here, only the parsing and the tolerances.
//   node --test scripts/tests/pinyin-sweep.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { cedictSyllables, numbered, parseCedict, wordAgrees } from "../pinyin-sweep.mjs";
import { TAIWAN_READINGS, TAIWAN_WORDS } from "../../web/src/script/script.ts";

test("numbered and cedictSyllables spell a syllable alike", () => {
  assert.deepEqual(["píng", "guǒ", "lǜ", "de", "r", "ńg", "ê"].map(numbered), ["ping2", "guo3", "lü4", "de5", "r5", "ng2", "ê5"]);
  assert.deepEqual(cedictSyllables("Ping2 guo3"), ["ping2", "guo3"]);
  assert.deepEqual(cedictSyllables("nu:3 er2"), ["nü3", "er2"]);
  assert.deepEqual(cedictSyllables("xia4hai2"), ["xia4", "hai2"]);
  assert.equal(cedictSyllables("san1 D da3"), null);
});

test("parseCedict: 2+ Han characters, readings and Taiwan's grouped by headword", () => {
  const { words } = parseCedict(
    ["# comment", "蘋果 苹果 [Ping2 guo3] /Apple/", "蘋果 苹果 [ping2 guo3] /apple/", "垃圾 垃圾 [la1 ji1] /trash/Taiwan pr. [le4 se4]/", "3C 3C [san1 C] /x/", "好 好 [hao3] /good/"].join("\n"),
  );
  assert.deepEqual(words.map((w) => w.trad), ["蘋果", "垃圾"]);
  assert.equal(words[0].proper, false);
  assert.deepEqual(words[1].taiwan, [["le4", "se4"]]);
});

test("wordAgrees: exact, or by the app's deliberate choices only", () => {
  const opts = { taiwan: TAIWAN_READINGS, taiwanWords: TAIWAN_WORDS };
  const app = (s) => s.split(" ").map(numbered);
  assert.deepEqual(wordAgrees(app("píng guǒ"), [["ping2", "guo3"]], [..."蘋果"], opts), { ok: true, how: "exact" });
  assert.equal(wordAgrees(app("pín guǒ"), [["ping2", "guo3"]], [..."蘋果"], opts).ok, false);
  assert.equal(wordAgrees(app("tóu fa"), [["tou2", "fa4"]], [..."頭髮"], opts).how, "neutral");
  assert.equal(wordAgrees(app("bù shì"), [["bu2", "shi4"]], [..."不是"], opts).how, "sandhi");
  assert.equal(wordAgrees(app("xīng qí"), [["xing1", "qi1"]], [..."星期"], { ...opts, tw: true }).how, "taiwan");
  assert.equal(wordAgrees(app("xīng qí"), [["xing1", "qi1"]], [..."星期"], opts).ok, false, "zh-CN takes no Taiwan reading");
  assert.equal(wordAgrees(app("lè sè"), [["la1", "ji1"]], [..."垃圾"], { ...opts, tw: true }).how, "taiwan");
});
