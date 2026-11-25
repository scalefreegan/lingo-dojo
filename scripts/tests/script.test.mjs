import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  KANGXI_RADICALS, hanChars, isHan, isTaiwan, parseRadical, particleDe, pinyinToZhuyin, readingIn, resolveMode, scriptFor,
  readMarked, splitHan, taiwanize,
} from "../../web/src/script/script.ts";
import { charReadings, readCodePoints, readOffsets, simplified } from "../../web/src/script/zh.ts";
import { ARPHIC_LICENSE_PATH, strokeFile } from "../../web/server/hanzi.ts";
import { ARPHIC_LICENSE_URL } from "../../web/src/script/script.ts";

test("the card links the licence at the path the middleware serves it", () => {
  assert.equal(ARPHIC_LICENSE_URL, ARPHIC_LICENSE_PATH);
  // …and that path is not a character file: only the fixed match serves it.
  assert.equal(strokeFile(ARPHIC_LICENSE_PATH), null);
});

// Reading aids (web/src/script/): which locales get pinyin / zhuyin, the
// stored choice, splitting mixed text, the pinyin reader over traditional
// and simplified text, pinyin → zhuyin, and the stroke-data path guard.

test("scriptFor: Mandarin in any script or region, never Cantonese or another language", () => {
  for (const l of ["zh-CN", "zh-TW", "zh", "zh-Hant-TW", "zh-Hans", "zh_TW", "cmn-TW", "zh-SG"]) assert.equal(scriptFor(l)?.id, "zh", l);
  for (const l of ["zh-HK", "zh-MO", "zh-Hant-HK", "yue-HK", "es-MX", "ja-JP", "ko-KR", "en", "", null, undefined]) assert.equal(scriptFor(l), null, String(l));
});

test("readMarked: a sentence with a marked phrase is read once, whole, so the words beside the mark keep their context", () => {
  // What Ruby.tsx MarkedText draws: the flashcard's sentence and a filled gap.
  const read = (t) => readOffsets(t, "zh-CN");
  const cases = [
    // (了 alone is le too since the frequency prior, ld-op2; it was liǎo.)
    [["", "天黑", "了"], [[], ["tiān", "hēi"], ["le"]], "le"],
    [["他", "跑", "得很快"], [["tā"], ["pǎo"], ["de", "hěn", "kuài"]], "dé"],
    [["我", "会", "长时间等你"], [["wǒ"], ["huì"], ["zhǎng", "shí", "jiān", "děng", "nǐ"]], "cháng"],
  ];
  for (const [parts, want, apart] of cases) {
    let calls = 0;
    const out = readMarked(parts, (t) => (calls++, read(t)));
    assert.equal(calls, 1, "one read, over the whole sentence");
    assert.deepEqual(out.map((p) => p.text), parts);
    assert.deepEqual(out.map((p) => p.readings), want, parts.join("|"));
    // Why it matters: read apart, the first character after the mark is wrong.
    assert.equal(read(parts[2])[0], apart, `${parts[2]} read apart`);
  }
  // No reader (readings off, not Chinese, loading): the parts, no readings.
  assert.deepEqual(readMarked(["a", "b", "c"], null), [{ text: "a", readings: null }, { text: "b", readings: null }, { text: "c", readings: null }]);
  // UTF-16 offsets: a character beyond the BMP is two units, its reading at the first.
  const wide = readMarked(["𠀋", "好", ""], () => ["x", null, "hǎo"]);
  assert.deepEqual(wide.map((p) => p.readings), [["x", null], ["hǎo"], []]);
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
    "": null, abc: null, n: "˙ㄣ", "hello": null,
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
  assert.equal(line("他看著我", "zh-TW"), "tā kàn zhe wǒ");
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

// Reading correctness (review of PR #17): a wrong reading teaches a wrong
// sound, so each fix is pinned in simplified and traditional, through the
// real reader (pinyin-pro + the rules), the way a transcript line reads.
const readLine = (t, l = "zh-CN") => readCodePoints(t, l).map((r) => r ?? "·").join(" ");
const at = (t, ch, l = "zh-CN") => readCodePoints(t, l)[[...t].lastIndexOf(ch)];
const both = (simp, trad) => [[simp, "zh-CN"], [trad, "zh-TW"]];

test("地 stays dì where it starts the next word, after a doubled verb or noun too", () => {
  for (const [s, t] of [["我们看看地图", "我們看看地圖"], ["我查查地址", "我查查地址"], ["你试试地铁吧", "你試試地鐵吧"], ["妈妈地址", "媽媽地址"], ["安静地方", "安靜地方"]]) {
    for (const [text, l] of both(s, t)) assert.equal(at(text, "地", l), "dì", text);
  }
});

test("得 keeps the library's reading after a pronoun or before 到 and a noun (děi, dé)", () => {
  const sentences = [["我得很早起", "我得很早起"], ["你得多练习", "你得多練習"], ["你得有耐心", "你得有耐心"], ["我得这样做", "我得這樣做"], ["我们得更努力", "我們得更努力"], ["他得不到", "他得不到"], ["她得最高分", "她得最高分"], ["他得满分", "他得滿分"]];
  for (const [s, t] of sentences) for (const [text, l] of both(s, t)) assert.notEqual(at(text, "得", l), "de", text);
});

test("the particles still read de where they are particles", () => {
  for (const [s, t] of [["慢慢地走", "慢慢地走"], ["开心地笑", "開心地笑"], ["高高兴兴地回家", "高高興興地回家"], ["认真地学习", "認真地學習"]]) {
    for (const [text, l] of both(s, t)) assert.equal(at(text, "地", l), "de", text);
  }
  for (const [s, t] of [["他跑得很快", "他跑得很快"], ["她说得太快了", "她說得太快了"], ["写得不好", "寫得不好"], ["他长得很高", "他長得很高"]]) {
    for (const [text, l] of both(s, t)) assert.equal(at(text, "得", l), "de", text);
  }
  assert.equal(readLine("他长得很高"), "tā zhǎng de hěn gāo");
  assert.equal(readLine("跑得到"), "pǎo dé dào", "a potential complement: the library's");
});

test("erhua: 儿 / 兒 is r closing 这儿, 一点儿, 哪儿, 小孩儿, and ér in 儿子, 女儿, 儿童, 儿歌", () => {
  for (const [s, t] of [["这儿", "這兒"], ["一点儿", "一點兒"], ["哪儿", "哪兒"], ["小孩儿", "小孩兒"], ["一会儿", "一會兒"], ["好玩儿", "好玩兒"]]) {
    for (const [text, l] of both(s, t)) assert.equal(at(text, [...text].at(-1), l), "r", text);
  }
  for (const [s, t] of [["儿子", "兒子"], ["女儿", "女兒"], ["儿童", "兒童"], ["儿歌", "兒歌"], ["婴儿", "嬰兒"]]) {
    assert.equal(at(s, "儿", "zh-CN"), "ér", s);
    assert.equal(at(t, "兒", "zh-TW"), "ér", t);
  }
  assert.equal(pinyinToZhuyin("r"), "ㄦ");
  assert.equal(readingIn("zhuyin", "r"), "ㄦ");
});

test("a traditional character reads as itself, not as the simplified form it shares", () => {
  // Alone, inline and on the card: 髮 fà (Taiwan fǎ), 幹 gàn, 彆 biè, 癥 zhēng, 儘 jǐn, 臟 zàng.
  const alone = { 髮: ["fà", "fǎ"], 幹: ["gàn", "gàn"], 彆: ["biè", "biè"], 癥: ["zhēng", "zhēng"], 儘: ["jǐn", "jǐn"], 臟: ["zàng", "zàng"] };
  for (const [ch, [cn, tw]] of Object.entries(alone)) {
    assert.equal(readLine(ch, "zh-CN"), cn, `${ch} zh-CN inline`);
    assert.equal(readLine(ch, "zh-TW"), tw, `${ch} zh-TW inline`);
    assert.equal(charReadings(ch, "zh-CN")[0], cn, `${ch} zh-CN card`);
    assert.equal(charReadings(ch, "zh-TW")[0], tw, `${ch} zh-TW card`);
  }
  // In words, the word's reading still wins where it is the character's own.
  assert.equal(readLine("頭髮", "zh-CN"), "tóu fa");
  assert.equal(readLine("頭髮", "zh-TW"), "tóu fǎ");
  assert.equal(readLine("發現"), "fā xiàn");
  assert.equal(readLine("你在幹嘛"), "nǐ zài gàn ma");
  assert.equal(readLine("乾淨"), "gān jìng");
  assert.equal(readLine("睡著了", "zh-TW"), "shuì zháo le");
  // The card: 乾 has qián and leads with gān, never 幹's gàn; 著 has zhù and zhe.
  for (const l of ["zh-CN", "zh-TW"]) {
    const gan = charReadings("乾", l);
    assert.equal(gan[0], "gān", l);
    assert.ok(gan.includes("qián"), l);
    assert.ok(!gan.includes("gàn"), l);
    const zhu = charReadings("著", l);
    assert.ok(zhu.includes("zhù") && zhu.includes("zhe"), `${l} ${zhu}`);
    // The simplified forms keep their own.
    assert.equal(charReadings("发", l)[0], "fā");
    assert.equal(charReadings("干", l)[0], "gān");
  }
});

test("no reading rather than the character itself; nasal interjections and ê in zhuyin", () => {
  assert.equal(readCodePoints("㐀", "zh-CN")[0], null);
  assert.deepEqual(charReadings("㐀", "zh-CN"), []);
  assert.equal(pinyinToZhuyin("ńg"), "ㄫˊ");
  assert.equal(pinyinToZhuyin("ḿ"), "ㄇˊ");
  assert.equal(pinyinToZhuyin("ǹ"), "ㄣˋ");
  assert.equal(pinyinToZhuyin("hm"), "˙ㄏㄇ");
  assert.equal(pinyinToZhuyin("ê"), "˙ㄝ");
  assert.equal(pinyinToZhuyin("ế"), "ㄝˊ");
});
