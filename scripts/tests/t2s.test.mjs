// Traditional text through OpenCC's tables (web/src/script/t2s.ts) and the
// reader around it (zh.ts), ld-37t: 蘋果 read pín guǒ, 瞭解 liào jiě and
// 徵求 zhǐ qiú because the old Unihan table left out every character with
// several simplified forms. Each fix is pinned in pinyin and zhuyin, the
// words the old reader already got right are locked, and pinyinToZhuyin
// is swept over every syllable the reader can give.
//   node --test scripts/tests/t2s.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pinyin } from "../../web/node_modules/pinyin-pro/dist/index.mjs";
import STCharacters from "../../web/node_modules/opencc-js/dist/esm-lib/dict/STCharacters.js";
import TSCharacters from "../../web/node_modules/opencc-js/dist/esm-lib/dict/TSCharacters.js";
import { SHARED_FORMS, alignedStage, makeStage, mergedWith, simplifyAligned } from "../../web/src/script/t2s.ts";
import { READING_FIXES, charReadings, readCodePoints, readOffsets, readingCached, simplified } from "../../web/src/script/zh.ts";
import { isPinyin, pinyinToZhuyin, readingIn } from "../../web/src/script/script.ts";

const line = (t, l = "zh-TW") => readCodePoints(t, l, { cache: false }).map((r) => r ?? "·").join(" ");
const zhuyin = (t, l = "zh-TW") => readCodePoints(t, l, { cache: false }).map((r) => (r ? readingIn("zhuyin", r) : "·")).join(" ");

test("the reported words read as the dictionaries do, in pinyin and in zhuyin, for zh-TW and zh-CN", () => {
  const cases = [
    ["蘋果", "píng guǒ", "ㄆㄧㄥˊ ㄍㄨㄛˇ"],
    ["瞭解", "liǎo jiě", "ㄌㄧㄠˇ ㄐㄧㄝˇ"],
    ["徵求", "zhēng qiú", "ㄓㄥ ㄑㄧㄡˊ"],
  ];
  for (const [w, py, zy] of cases) {
    for (const l of ["zh-TW", "zh-CN"]) {
      assert.equal(line(w, l), py, `${w} ${l}`);
      assert.equal(zhuyin(w, l), zy, `${w} ${l}`);
    }
  }
  // The same in a sentence, beside other words.
  assert.equal(line("我想吃蘋果，你瞭解嗎？"), "wǒ xiǎng chī píng guǒ · nǐ liǎo jiě ma ·");
  // 時間 read shí jiàn before (the library lists only jiàn for 間).
  assert.equal(line("時間"), "shí jiān");
});

test("the words the old reader read right still read the same (zh-TW, then zh-CN)", () => {
  // Locked from the reader before ld-37t; Taiwan's 頭髮 fǎ, sandhi off (對不起 duì bù qǐ).
  const locked = {
    乾淨: "gān jìng", 乾杯: "gān bēi", 頭髮: ["tóu fǎ", "tóu fa"], 發現: "fā xiàn", 睡著: "shuì zháo", 看著: "kàn zhe", 為什麼: "wèi shén me",
    銀行: "yín háng", 音樂: "yīn yuè", 快樂: "kuài lè", 還有: "hái yǒu", 覺得: "jué de", 睡覺: "shuì jiào", 計程車: "jì chéng chē",
    腳踏車: "jiǎo tà chē", 週末: "zhōu mò", 颱風: "tái fēng", 麵包: "miàn bāo", 臺灣: "tái wān", 老闆: "lǎo bǎn", 手錶: "shǒu biǎo",
    遊戲: "yóu xì", 裡面: "lǐ miàn", 謝謝: "xiè xiè", 對不起: "duì bù qǐ", 沒關係: "méi guān xì", 喜歡: "xǐ huan", 電腦: "diàn nǎo",
    電話: "diàn huà", 學校: "xué xiào", 學生: "xué shēng", 老師: "lǎo shī", 朋友: "péng yǒu", 東西: "dōng xī", 時候: "shí hòu",
    現在: "xiàn zài", 認識: "rèn shi", 漂亮: "piào liang", 開車: "kāi chē", 飛機: "fēi jī", 醫院: "yī yuàn", 圖書館: "tú shū guǎn",
    餐廳: "cān tīng", 飯店: "fàn diàn", 機場: "jī chǎng", 車站: "chē zhàn", 捷運: "jié yùn", 網路: "wǎng lù", 簡單: "jiǎn dān",
    應該: "yīng gāi", 準備: "zhǔn bèi", 問題: "wèn tí", 經濟: "jīng jì", 歷史: "lì shǐ", 運動: "yùn dòng", 籃球: "lán qiú",
    衣服: "yī fu", 買東西: "mǎi dōng xī", 便宜: "pián yi", 號碼: "hào mǎ", 聽說: "tīng shuō", 這裡: "zhè lǐ", 那裡: "nà lǐ",
    哪裡: "nǎ lǐ", 幾點: "jǐ diǎn", 東京: "dōng jīng", 長大: "zhǎng dà", 重要: "zhòng yào", 願意: "yuàn yì", 習慣: "xí guàn",
    環境: "huán jìng", 關係: "guān xì", 筆記: "bǐ jì", 寫字: "xiě zì", 說話: "shuō huà", 讀書: "dú shū",
  };
  assert.ok(Object.keys(locked).length >= 60);
  for (const [w, r] of Object.entries(locked)) {
    const [tw, cn] = Array.isArray(r) ? r : [r, r];
    assert.equal(line(w, "zh-TW"), tw, `${w} zh-TW`);
    assert.equal(line(w, "zh-CN"), cn, `${w} zh-CN`);
  }
});

test("simplified text reads as before: the conversion leaves it alone", () => {
  const simp = {
    我们去银行吧: "wǒ men qù yín háng ba", 他长得很高: "tā zhǎng de hěn gāo", 为什么: "wèi shén me", 头发: "tóu fa", 了解: "liǎo jiě",
    苹果: "píng guǒ", 时间: "shí jiān", 著名: "zhù míng", 显著: "xiǎn zhù", 原著: "yuán zhù", 什么: "shén me", 干净: "gān jìng",
    干部: "gàn bù", 发现: "fā xiàn", 一只猫: "yī zhī māo", 只有: "zhǐ yǒu", 看着: "kàn zhe", 睡着了: "shuì zháo le",
  };
  for (const [w, r] of Object.entries(simp)) assert.equal(line(w, "zh-CN"), r, w);
  // Simplified characters pass through untouched (none is a key of TSCharacters).
  assert.deepEqual(simplifyAligned("我们去银行吧"), [..."我们去银行吧"]);
});

test("positions: one reading per code point in mixed text, UTF-16 offsets kept", () => {
  const text = "A蘋果😀，瞭解 2 次𠮷徵求!";
  const cps = [...text];
  const r = readCodePoints(text, "zh-TW", { cache: false });
  assert.equal(r.length, cps.length);
  assert.deepEqual(r, [null, "píng", "guǒ", null, null, "liǎo", "jiě", null, null, null, "cì", null, "zhēng", "qiú", null]);
  const off = readOffsets(text, "zh-TW");
  assert.equal(off.length, text.length);
  assert.equal(off[text.indexOf("瞭")], "liǎo");
  assert.equal(off[text.indexOf("徵")], "zhēng");
  assert.equal(off[text.indexOf("😀") + 1], null, "the emoji's second code unit");
  // The simplified spelling has exactly one code point per original one.
  assert.equal(simplifyAligned(text).length, cps.length);
});

test("alignedStage: phrases first, longest match, and an entry that isn't one for one never shifts a neighbour", () => {
  const stage = makeStage("甲乙 丙丁|甲乙丙 戊|乙 己|甲 庚|丙 辛", "甲 X");
  // Longest match: 甲乙丙 → 戊 is not one for one, so each character on its own: 甲 庚, 乙 己, 丙 辛.
  assert.deepEqual(alignedStage(stage, [..."甲乙丙丁"]), ["庚", "己", "辛", "丁"]);
  assert.deepEqual(alignedStage(stage, [..."甲乙x"]), ["丙", "丁", "x"]);
  // The earlier table wins a key both have.
  assert.deepEqual(alignedStage(stage, ["甲"]), ["庚"]);
  // OpenCC's own: by the word.
  assert.equal(simplifyAligned("乾淨乾隆").join(""), "干净乾隆");
  assert.equal(simplifyAligned("宮商角徵羽徵求").join(""), "宫商角徵羽征求");
  assert.equal(simplifyAligned("瞭望瞭解").join(""), "瞭望了解");
  assert.equal(simplifyAligned("看著著名顯著睡著").join(""), "看着著名显著睡着");
  assert.equal(simplifyAligned("這裡爲為").join(""), "这里为为");
  // A CJK compatibility ideograph reads as the one it stands for (U+F900 豈 → 豈 → 岂).
  assert.equal(simplifyAligned("豈")[0], "岂");
  assert.equal(simplified("蘋"), "苹");
  assert.equal(simplified("你"), "你");
});

test("SHARED_FORMS is what OpenCC's tables say, and mergedWith names the characters a form stands for", () => {
  const stKeys = new Set(STCharacters.split("|").map((l) => l.split(" ")[0]));
  const targets = new Set(TSCharacters.split("|").map((l) => l.split(" ")[1]));
  const derived = [...targets].filter((s) => [...s].length === 1 && s.length === 1 && !stKeys.has(s)).sort().join("");
  assert.equal(SHARED_FORMS, derived);
  assert.ok(mergedWith("髮", "发").includes("發"));
  assert.ok(mergedWith("隻", "只").includes("只"));
  assert.deepEqual(mergedWith("間", "间"), []);
});

test("the correction list: each word reads as the dictionaries do, in both scripts", () => {
  const trad = {
    不着: "不著", 不着边际: "不著邊際", 不当: "不當", 倒是: "倒是", 颠倒是非: "顛倒是非", 倒立: "倒立", 假日: "假日", 挨饿: "挨餓", 挨打: "挨打",
    待会儿: "待會兒", 嚣张: "囂張", 种植: "種植", 炸鸡: "炸雞", 油炸: "油炸", 有为: "有為", 受难: "受難", 弹珠: "彈珠", 和面: "和麵", 狗血: "狗血",
    喧嚣: "喧囂", 叫嚣: "叫囂",
  };
  for (const [simp, want] of Object.entries(READING_FIXES)) {
    // The erhua of 待会儿 is shown as r (particleDe).
    const shown = want.replace(/ ér$/, " r");
    assert.equal(line(simp, "zh-CN"), shown, simp);
    assert.ok(trad[simp], `a traditional spelling for ${simp}`);
    assert.equal(line(trad[simp], "zh-TW"), shown, trad[simp]);
  }
  // In sentences, and not where the word is not there.
  assert.equal(line("我睡不著"), "wǒ shuì bù zháo");
  assert.equal(line("他看著我"), "tā kàn zhe wǒ");
  assert.equal(line("招待會"), "zhāo dài huì");
  assert.equal(line("待會兒見"), "dāi huì r jiàn");
});

test("the server's cache: false read leaves nothing cached", () => {
  const text = "伺服器讀的蘋果句子";
  readCodePoints(text, "zh-TW", { cache: false });
  assert.equal(readingCached(text, "zh-TW"), false);
  readCodePoints(text, "zh-TW");
  assert.equal(readingCached(text, "zh-TW"), true);
});

test("the character card: the word's reading first, and a traditional character's readings complete", () => {
  // Opened from 蘋果, 銀行, 音樂: that reading leads.
  assert.equal(charReadings("蘋", "zh-TW", "píng")[0], "píng");
  assert.deepEqual(charReadings("行", "zh-TW", "háng").slice(0, 2), ["háng", "xíng"]);
  assert.equal(charReadings("樂", "zh-TW", "yuè")[0], "yuè");
  // Alone: 蘋 leads with píng (its simplified form's usual reading), 間 has jiān too, 還 hái first.
  for (const l of ["zh-TW", "zh-CN"]) {
    assert.deepEqual(charReadings("蘋", l), ["píng", "pín"], l);
    assert.equal(readingIn("zhuyin", charReadings("蘋", l)[0]), "ㄆㄧㄥˊ");
    assert.deepEqual(charReadings("間", l), ["jiān", "jiàn"], l);
    assert.equal(charReadings("還", l)[0], "hái", l);
    assert.equal(charReadings("髮", l).includes("fā"), false, l);
  }
  // A reading not in the lists still leads when the word gave it.
  assert.equal(charReadings("間", "zh-TW", "jian")[0], "jian");
});

/* ------------------------- pinyin → zhuyin and back ------------------------ */

const INITIAL = { ㄅ: "b", ㄆ: "p", ㄇ: "m", ㄈ: "f", ㄉ: "d", ㄊ: "t", ㄋ: "n", ㄌ: "l", ㄍ: "g", ㄎ: "k", ㄏ: "h", ㄐ: "j", ㄑ: "q", ㄒ: "x", ㄓ: "zh", ㄔ: "ch", ㄕ: "sh", ㄖ: "r", ㄗ: "z", ㄘ: "c", ㄙ: "s" };
const FINAL = {
  "": "i", ㄚ: "a", ㄛ: "o", ㄜ: "e", ㄝ: "ê", ㄞ: "ai", ㄟ: "ei", ㄠ: "ao", ㄡ: "ou", ㄢ: "an", ㄣ: "en", ㄤ: "ang", ㄥ: "eng", ㄦ: "er",
  ㄧ: "i", ㄧㄚ: "ia", ㄧㄛ: "io", ㄧㄝ: "ie", ㄧㄞ: "iai", ㄧㄠ: "iao", ㄧㄡ: "iou", ㄧㄢ: "ian", ㄧㄣ: "in", ㄧㄤ: "iang", ㄧㄥ: "ing", ㄩㄥ: "iong",
  ㄨ: "u", ㄨㄚ: "ua", ㄨㄛ: "uo", ㄨㄞ: "uai", ㄨㄟ: "uei", ㄨㄢ: "uan", ㄨㄣ: "uen", ㄨㄤ: "uang", ㄨㄥ: "ong",
  ㄩ: "ü", ㄩㄝ: "üe", ㄩㄢ: "üan", ㄩㄣ: "ün",
};
const ZERO = { i: "yi", ia: "ya", io: "yo", ie: "ye", iai: "yai", iao: "yao", iou: "you", ian: "yan", in: "yin", iang: "yang", ing: "ying", iong: "yong", u: "wu", ua: "wa", uo: "wo", uai: "wai", uei: "wei", uan: "wan", uen: "wen", uang: "wang", ong: "weng", ü: "yu", üe: "yue", üan: "yuan", ün: "yun" };
// Tones 1 to 4 on each letter that can carry one (combining marks where
// Unicode has no precomposed letter).
const MARK = {
  a: ["ā", "á", "ǎ", "à"], e: ["ē", "é", "ě", "è"], ê: ["ê̄", "ế", "ê̌", "ề"], i: ["ī", "í", "ǐ", "ì"], o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"], ü: ["ǖ", "ǘ", "ǚ", "ǜ"], m: ["m̄", "ḿ", "m̌", "m̀"], n: ["n̄", "ń", "ň", "ǹ"],
};

/** Zhuyin back to tone-marked pinyin, written independently of
 *  pinyinToZhuyin (the textbook spelling rules), for the round trip:
 *  every spelling it can be, since zhuyin writes 恩 ēn and the
 *  interjection 嗯 n alike (ㄣ). */
function zhuyinToPinyin(z) {
  let tone = 1;
  if (z.startsWith("˙")) {
    tone = 5;
    z = z.slice(1);
  } else if (/[ˊˇˋ]$/.test(z)) {
    tone = " ˊˇˋ".indexOf(z.at(-1)) + 1;
    z = z.slice(0, -1);
  }
  const bodies = [];
  const nasal = { ㄇ: "m", ㄣ: "n", ㄫ: "ng", ㄏㄇ: "hm", ㄏㄫ: "hng" }[z];
  if (nasal) bodies.push(nasal);
  const ini = INITIAL[z[0]] ?? "";
  let fin = FINAL[ini ? z.slice(1) : z];
  if (fin != null && !(ini && fin === "i" && z.length === 1 && !["zh", "ch", "sh", "r", "z", "c", "s"].includes(ini))) {
    if (!ini) bodies.push(ZERO[fin] ?? fin);
    else {
      if ("jqx".includes(ini) && fin.startsWith("ü")) fin = "u" + fin.slice(1);
      fin = { iou: "iu", uei: "ui", uen: "un" }[fin] ?? fin;
      bodies.push(ini + fin);
    }
  }
  return bodies.map((body) => {
    if (tone === 5) return body;
    // The mark: on a or e, on the o of ou, else on the last vowel (or the nasal).
    const at = /[aeê]/.test(body) ? body.search(/[aeê]/) : body.includes("ou") ? body.indexOf("o") : Math.max(...[..."iouü"].map((v) => body.lastIndexOf(v)));
    const pos = at >= 0 ? at : body.search(/[mn]/);
    return (body.slice(0, pos) + MARK[body[pos]][tone - 1] + body.slice(pos + 1)).normalize("NFC");
  });
}

test("pinyinToZhuyin round-trips every syllable the reader can give", () => {
  // Every reading pinyin-pro has for any character, and each one's neutral
  // tone (what a word's unstressed syllable reads), plus the reader's own.
  const syllables = new Set(["r", "de", "le", "zhe", "zháo", "dāi", "huó"]);
  for (let cp = 0x3400; cp <= 0x9fff; cp++) {
    if (cp > 0x4dbf && cp < 0x4e00) continue;
    for (const r of pinyin(String.fromCodePoint(cp), { multiple: true, type: "array", toneSandhi: false })) {
      if (!isPinyin(r)) continue;
      syllables.add(r.normalize("NFC"));
      syllables.add(r.normalize("NFD").replace(/[̀-̄̌]/g, "").normalize("NFC"));
    }
  }
  assert.ok(syllables.size > 1200, `${syllables.size} syllables`);
  const failed = [];
  for (const s of syllables) {
    const z = pinyinToZhuyin(s);
    // The r of erhua is ㄦ with no tone: its own spelling, not ēr.
    if (s === "r") {
      assert.equal(z, "ㄦ");
      continue;
    }
    if (z == null || !zhuyinToPinyin(z).includes(s)) failed.push(`${s} → ${z} → ${z && zhuyinToPinyin(z).join("/")}`);
  }
  assert.deepEqual(failed, []);
});
