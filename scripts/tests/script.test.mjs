import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  KANGXI_RADICALS, hanChars, isHan, isTaiwan, parseRadical, particleDe, pinyinToZhuyin, readingIn, resolveMode, rubyStorageKey, scriptFor,
  simplifyForReading, splitHan, taiwanize,
} from "../../web/src/script/script.ts";
import { charReadings, readCodePoints, readOffsets, simplified } from "../../web/src/script/zh.ts";
import { strokeFile } from "../../web/server/hanzi.ts";

// Reading aids (web/src/script/): which locales get pinyin / zhuyin, the
// stored choice, splitting mixed text, the pinyin reader over traditional
// and simplified text, pinyin → zhuyin, and the stroke-data path guard.

test("scriptFor: Mandarin in any script or region, never Cantonese or another language", () => {
  for (const l of ["zh-CN", "zh-TW", "zh", "zh-Hant-TW", "zh-Hans", "zh_TW", "cmn-TW", "zh-SG"]) assert.equal(scriptFor(l)?.id, "zh", l);
  for (const l of ["zh-HK", "zh-MO", "zh-Hant-HK", "yue-HK", "es-MX", "ja-JP", "ko-KR", "en", "", null, undefined]) assert.equal(scriptFor(l), null, String(l));
});

test("isTaiwan: zh-TW and traditional-script Mandarin", () => {
  assert.equal(isTaiwan("zh-TW"), true);
  assert.equal(isTaiwan("cmn-TW"), true);
  assert.equal(isTaiwan("zh-Hant"), true);
  assert.equal(isTaiwan("zh-CN"), false);
  assert.equal(isTaiwan("zh-Hant-HK"), false);
  assert.equal(isTaiwan(null), false);
});

test("resolveMode: the stored choice where offered, else the default, off where there's no aid", () => {
  assert.equal(resolveMode(null, "zh-TW"), "pinyin");
  assert.equal(resolveMode("zhuyin", "zh-TW"), "zhuyin");
  assert.equal(resolveMode("off", "zh-CN"), "off");
  assert.equal(resolveMode("furigana", "zh-CN"), "pinyin");
  assert.equal(resolveMode("pinyin", "es-MX"), "off");
  assert.equal(resolveMode("zhuyin", null), "off");
});

test("rubyStorageKey is per language profile", () => {
  assert.equal(rubyStorageKey("abc"), "lingo-dojo.ruby.v1.language.abc");
  assert.notEqual(rubyStorageKey("a"), rubyStorageKey("b"));
});

test("splitHan: single characters and runs of everything else, with UTF-16 offsets", () => {
  assert.deepEqual(splitHan("OK，你好 abc!"), [
    { text: "OK，", at: 0, han: false },
    { text: "你", at: 3, han: true },
    { text: "好", at: 4, han: true },
    { text: " abc!", at: 5, han: false },
  ]);
  // A character beyond the BMP is one character, two code units.
  assert.deepEqual(splitHan("𠮷野"), [
    { text: "𠮷", at: 0, han: true },
    { text: "野", at: 2, han: true },
  ]);
  assert.deepEqual(splitHan(""), []);
  assert.equal(isHan("你"), true);
  assert.equal(isHan("a"), false);
  assert.equal(isHan("你好"), false);
  assert.deepEqual(hanChars("你好，你們好"), ["你", "好", "們"]);
});

test("simplifyForReading: one for one, with 著 and 乾 by their neighbours", () => {
  const t = { 們: "们", 銀: "银", 覺: "觉" };
  assert.equal(simplifyForReading("我們睡覺", t), "我们睡觉");
  assert.equal(simplifyForReading("看著", t), "看着");
  assert.equal(simplifyForReading("著名", t), "著名");
  assert.equal(simplifyForReading("顯著", t), "顯着".replace("着", "著"));
  assert.equal(simplifyForReading("乾淨", t), "干淨");
  assert.equal(simplifyForReading("乾隆", t), "乾隆");
  assert.equal(simplifyForReading("這裡", t), "這里");
  // A two-character "simplified form" would shift every offset: ignored.
  assert.equal(simplifyForReading("甲", { 甲: "ab" }), "甲");
  assert.equal([...simplifyForReading("𠮷們", t)].length, 2);
});

test("taiwanize: Taiwan's readings, only over the mainland's usual one", () => {
  assert.deepEqual(taiwanize("星期", ["xīng", "qī"]), ["xīng", "qí"]);
  assert.deepEqual(taiwanize("垃圾", ["lā", "jī"]), ["lè", "sè"]);
  assert.deepEqual(taiwanize("誰", ["shuí"]), ["shéi"]);
  assert.deepEqual(taiwanize("頭髮", ["tóu", "fa"]), ["tóu", "fǎ"]);
  // A reading picked from context is left alone.
  assert.deepEqual(taiwanize("期", ["jī"]), ["jī"]);
  assert.deepEqual(taiwanize("a期", [null, "qī"]), [null, "qí"]);
});

test("particleDe: the adverbial 地 after a doubled character or a common adjective", () => {
  assert.deepEqual(particleDe("慢慢地走", ["màn", "màn", "dì", "zǒu"]), ["màn", "màn", "de", "zǒu"]);
  assert.deepEqual(particleDe("開心地笑", ["kāi", "xīn", "dì", "xiào"]), ["kāi", "xīn", "de", "xiào"]);
  assert.deepEqual(particleDe("地方", ["dì", "fāng"]), ["dì", "fāng"]);
  assert.deepEqual(particleDe("草地", ["cǎo", "dì"]), ["cǎo", "dì"]);
  assert.deepEqual(particleDe("跑得很快", ["pǎo", "dé", "hěn", "kuài"]), ["pǎo", "de", "hěn", "kuài"]);
  assert.deepEqual(particleDe("長得高", ["cháng", "dé", "gāo"]), ["zhǎng", "de", "gāo"]);
  // 得 as the verb stays dé.
  assert.deepEqual(particleDe("不得不", ["bù", "dé", "bù"]), ["bù", "dé", "bù"]);
  assert.deepEqual(particleDe("獲得很多", ["huò", "dé", "hěn", "duō"]), ["huò", "dé", "hěn", "duō"]);
  assert.deepEqual(particleDe("得到", ["dé", "dào"]), ["dé", "dào"]);
});

test("pinyinToZhuyin: initials, finals, y/w spellings, ü, and the four tones and the neutral", () => {
  const cases = {
    nǐ: "ㄋㄧˇ", hǎo: "ㄏㄠˇ", ma: "˙ㄇㄚ", mā: "ㄇㄚ", má: "ㄇㄚˊ", mà: "ㄇㄚˋ",
    zhī: "ㄓ", chī: "ㄔ", shì: "ㄕˋ", rì: "ㄖˋ", zì: "ㄗˋ", cí: "ㄘˊ", sì: "ㄙˋ",
    yī: "ㄧ", yǒu: "ㄧㄡˇ", yuè: "ㄩㄝˋ", yuán: "ㄩㄢˊ", yún: "ㄩㄣˊ", yǔ: "ㄩˇ", yīn: "ㄧㄣ", yīng: "ㄧㄥ", yòng: "ㄩㄥˋ", yā: "ㄧㄚ", yě: "ㄧㄝˇ",
    wǒ: "ㄨㄛˇ", wèi: "ㄨㄟˋ", wén: "ㄨㄣˊ", wǔ: "ㄨˇ", wàng: "ㄨㄤˋ", wēng: "ㄨㄥ",
    jū: "ㄐㄩ", qù: "ㄑㄩˋ", xué: "ㄒㄩㄝˊ", juān: "ㄐㄩㄢ", qún: "ㄑㄩㄣˊ", xióng: "ㄒㄩㄥˊ",
    lǜ: "ㄌㄩˋ", nǚ: "ㄋㄩˇ", lüè: "ㄌㄩㄝˋ", lv4: null,
    guì: "ㄍㄨㄟˋ", liù: "ㄌㄧㄡˋ", lùn: "ㄌㄨㄣˋ", zhuàng: "ㄓㄨㄤˋ", dōng: "ㄉㄨㄥ", ér: "ㄦˊ", èr: "ㄦˋ", ài: "ㄞˋ", ō: "ㄛ",
    bō: "ㄅㄛ", fó: "ㄈㄛˊ", xiǎo: "ㄒㄧㄠˇ", jiàn: "ㄐㄧㄢˋ", chuáng: "ㄔㄨㄤˊ", de: "˙ㄉㄜ", men: "˙ㄇㄣ",
    "": null, abc: null, n: null, "hello": null,
  };
  for (const [py, zy] of Object.entries(cases)) assert.equal(pinyinToZhuyin(py), zy, py);
  assert.equal(readingIn("zhuyin", "nǐ"), "ㄋㄧˇ");
  assert.equal(readingIn("pinyin", "nǐ"), "nǐ");
  assert.equal(readingIn("zhuyin", "xyz"), "xyz");
});

test("Kangxi radicals and Unihan radical-stroke values", () => {
  assert.equal(KANGXI_RADICALS.length, 214);
  assert.equal(KANGXI_RADICALS[0], "一");
  assert.equal(KANGXI_RADICALS[60], "心");
  assert.equal(KANGXI_RADICALS[213], "龠");
  assert.deepEqual(parseRadical("61.9"), { radical: "心", number: 61, simplified: false, extra: 9 });
  assert.deepEqual(parseRadical("120'.3"), { radical: "糸", number: 120, simplified: true, extra: 3 });
  assert.equal(parseRadical(""), null);
  assert.equal(parseRadical("999.1"), null);
});

test("the reader: words in context, traditional read through simplified, offsets kept", () => {
  const line = (t, l = "zh-CN") => readCodePoints(t, l).map((r) => r ?? "·").join(" ");
  assert.equal(line("我們去銀行吧"), "wǒ men qù yín háng ba");
  assert.equal(line("我们去银行吧"), "wǒ men qù yín háng ba");
  assert.equal(line("他長得很高，頭髮很長"), "tā zhǎng de hěn gāo · tóu fa hěn cháng");
  assert.equal(line("睡覺了嗎？"), "shuì jiào le ma ·");
  assert.equal(line("他看著我"), "tā kàn zhe wǒ");
  assert.equal(line("乾淨"), "gān jìng");
  assert.equal(line("OK 好"), "· · · hǎo");
  // Tone sandhi is off: each character's own tone.
  assert.equal(line("不是一個"), "bù shì yī gè");
  // zh-TW takes Taiwan's readings.
  assert.equal(line("星期一", "zh-TW"), "xīng qí yī");
  assert.equal(line("星期一", "zh-CN"), "xīng qī yī");
  // UTF-16 offsets for the gloss layout: a character beyond the BMP takes two.
  const off = readOffsets("𠮷你", "zh-CN");
  assert.equal(off.length, 3);
  assert.equal(off[2], "nǐ");
  assert.equal(off[1], null);
  assert.deepEqual(charReadings("行", "zh-CN").slice(0, 2), ["xíng", "háng"]);
  assert.equal(charReadings("期", "zh-TW")[0], "qí");
  assert.equal(simplified("愛"), "爱");
  assert.equal(simplified("你"), "你");
});

test("strokeFile: one Han character's file in the package, nothing else", () => {
  const f = strokeFile("/hanzi-data/%E6%84%9B.json");
  assert.equal(path.basename(f), "愛.json");
  assert.match(f, /node_modules[\\/]hanzi-writer-data[\\/]/);
  assert.equal(strokeFile("/hanzi-data/愛.json?x=1") != null, true);
  for (const bad of ["/hanzi-data/../package.json", "/hanzi-data/%2e%2e%2fpackage.json", "/hanzi-data/ab.json", "/hanzi-data/愛愛.json", "/hanzi-data/%E0%A4%A.json", "/other/愛.json", undefined]) {
    assert.equal(strokeFile(bad), null, String(bad));
  }
});
