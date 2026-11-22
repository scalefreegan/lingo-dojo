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

test("the HSK 3.0 audit's --import takes only the pinned CSV: its repository, commit and SHA-256 are recorded, and any other file is refused before anything is written (PR #69 review, ld-7xi)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const m = await import("../pinyin-hsk-audit.mjs");
  assert.match(m.HSK_CSV_REPO, /shawkynasr\/HSK-official-Query-System$/);
  assert.match(m.HSK_CSV_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(m.HSK_CSV_URL.includes(m.HSK_CSV_COMMIT));
  assert.match(m.HSK_CSV_SHA256, /^[0-9a-f]{64}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsk-"));
  try {
    const csv = path.join(dir, "vocab.csv");
    const out = path.join(dir, "hsk-words.tsv");
    fs.writeFileSync(csv, "No.,级别,词语,拼音,词性\n1,一级,爱,ài,动\n");
    assert.throws(() => m.importCsv(csv, out), /SHA-256/);
    assert.ok(!fs.existsSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the HSK 3.0 audit's parsing (scripts/pinyin-hsk-audit.mjs, run by hand; no list here): printed rows into words, pinyin into one syllable a character, the conventions (ld-7xi)", async () => {
  const { rowWords, syllabify, wordVerdict } = await import("../pinyin-hsk-audit.mjs");
  const inv = new Set(["xi", "an", "xian", "chu", "lai", "fu", "qin", "yi", "dian", "jie", "er", "lian", "san", "nan", "hai", "bu", "ke", "qi", "dao", "shi"]);
  const syl = (p, w) => syllabify(p, [...w], inv)?.map((s) => (s.light ? "·" : "") + s.syl).join(" ");
  // Separators are syllable boundaries; a vowel never starts a syllable without one.
  assert.equal(syl("Xī’ān", "西安"), "xī ān");
  assert.equal(syl("xiān", "先"), "xiān");
  assert.equal(syl("xiān", "西安"), undefined);
  assert.equal(syl("chū∥·lái", "出来"), "chū ·lái");
  assert.equal(syl("fù·qīn", "父亲"), "fù ·qīn");
  assert.equal(syl("jiē‘èr-liánsān", "接二连三"), "jiē èr lián sān");
  // Erhua's r is the 儿's syllable.
  assert.equal(syl("yìdiǎnr", "一点儿"), "yì diǎn r");
  // Rows: variants, an optional part, an example, a sense's note, two readings.
  assert.deepEqual(rowWords("爸爸∣爸", "bàba∣bà"), [{ word: "爸爸", pinyin: "bàba" }, { word: "爸", pinyin: "bà" }]);
  assert.deepEqual(rowWords("妈妈", "māma∣mā"), [{ word: "妈妈", pinyin: "māma" }]);
  assert.deepEqual(rowWords("差（一）点儿", "chà(yì)diǎnr").map((x) => x.word), ["差点儿", "差一点儿"]);
  assert.deepEqual(rowWords("初（初一）", "chū (chūyī)"), [{ word: "初", pinyin: "chū" }, { word: "初一", pinyin: "chūyī" }]);
  assert.deepEqual(rowWords("才（名）", "cái"), [{ word: "才", pinyin: "cái" }]);
  assert.deepEqual(rowWords("称1（动）", "chēng"), [{ word: "称", pinyin: "chēng" }]);
  assert.deepEqual(rowWords("谁", "shéi/shuí").map((x) => x.pinyin), ["shéi", "shuí"]);
  assert.deepEqual(rowWords("…极了", "…jí le"), [{ word: "极了", pinyin: "jí le" }]);
  // The conventions: 一/不 sandhi, the neutral tone either way, erhua, "·".
  const v = (app, p, w) => wordVerdict(app.split(" "), syllabify(p, [...w], inv), [...w]);
  assert.deepEqual(v("bù kě qì", "bù kěqi", "不可气"), { ok: true, how: "neutral" });
  assert.deepEqual(v("bù ān", "bú’ān", "不安"), { ok: true, how: "sandhi" });
  assert.deepEqual(v("nán hái ér", "nánháir", "男孩儿"), { ok: true, how: "erhua" });
  assert.deepEqual(v("fù qīn", "fù·qīn", "父亲"), { ok: true, how: "exact" });
  assert.deepEqual(v("fù qin", "fù·qīn", "父亲"), { ok: true, how: "light" });
  assert.equal(v("dǎo shì", "dàoshì", "倒是").ok, false);
});
