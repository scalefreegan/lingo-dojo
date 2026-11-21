// The Mandarin reader's frequency prior (ld-op2): web/src/script/zh-freq.ts
// (built by scripts/gen-zh-freq.mjs) and how zh.ts applies it. No
// dictionary here: the builder's pure pieces on small fixtures, and the
// committed table through the reader, each claim also checked with the
// prior taken away (setPrior(null)) so it fails without it.
//   node --test scripts/tests/zh-freq.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { FALLBACK_SHARE, UNIHAN_READINGS_SHA256, UNIHAN_URL, UNIHAN_ZIP_SHA256, WORDFREQ_SHA256, WORDFREQ_URL, cedictEntries, checkSha256, decodeCBpack, frequencyTiers, marked, ranksFrom, readingMass, tokenShares } from "../gen-zh-freq.mjs";
import { EVERYDAY_SENTENCES, EVERYDAY_WORDS } from "./zh-everyday.mjs";
import { commonChars } from "../../web/src/script/sounds.ts";
import { mergedWith } from "../../web/src/script/t2s.ts";
import { numbered } from "../pinyin-sweep.mjs";
import * as table from "../../web/src/script/zh-freq.ts";
import { READING_FIXES, ambiguousChars, charReadings, currentPrior, parsePrior, readCodePoints, readDetail, setPrior, simplified } from "../../web/src/script/zh.ts";
import { isPinyin, pinyinToZhuyin } from "../../web/src/script/script.ts";

const shipped = parsePrior(table);
after(() => setPrior(shipped));
const line = (t, l = "zh-CN") => readCodePoints(t, l, { cache: false }).map((r) => r ?? "·").join(" ");
/** `fn` with no prior at all, then the shipped one back. */
const without = (fn) => {
  setPrior(null);
  try {
    return fn();
  } finally {
    setPrior(shipped);
  }
};

test("the builder: tone marks, wordfreq's file, CC-CEDICT's lines", () => {
  for (const n of ["ping2", "liang4", "lü4", "de5", "r5", "guo3", "xue2", "liu2", "gui4", "ng2", "ê4", "nü3", "zhuang1", "hou4"]) assert.equal(numbered(marked(n)), n, n);
  assert.deepEqual(["liang4", "hou4", "liu2", "gui4", "de5"].map(marked), ["liàng", "hòu", "liú", "guì", "de"]);
  assert.equal(marked("xx5"), null, "CC-CEDICT's 'no reading'");
  assert.equal(marked("C"), null);
  // A cBpack: a header, then the words of each centibel.
  const str = (s) => Buffer.concat([Buffer.from([0xa0 + Buffer.byteLength(s)]), Buffer.from(s)]);
  const header = Buffer.concat([Buffer.from([0x82]), str("format"), str("cB"), str("version"), Buffer.from([1])]);
  const buf = Buffer.concat([Buffer.from([0x93]), header, Buffer.from([0x91]), str("的"), Buffer.from([0x90])]);
  assert.deepEqual([...decodeCBpack(buf)], [["的", 1]]);
  assert.throws(() => decodeCBpack(Buffer.from([0x91, 0x80])), /cBpack/);
  const entries = cedictEntries(["# x", "蘋果 苹果 [ping2 guo3] /apple/", "佛 佛 [Fo2] /Buddha/", "佛 佛 [fu2] /used in 仿佛[fang3 fu2]/", "3C 3C [san1 C] /x/", "裡 里 [li3] /variant of 裏|里[li3]/"].join("\n"));
  assert.deepEqual(entries.map((e) => [e.trad, e.proper, e.bound, e.variant]), [["蘋果", false, false, false], ["佛", true, false, false], ["佛", false, true, false], ["裡", false, false, true]]);
});

test("the builder: a character's readings by the frequency of the words that use them", () => {
  const entries = cedictEntries(
    [
      "量 量 [liang4] /quantity/", "量 量 [liang2] /to measure/", "數量 数量 [shu4 liang4] /amount/", "質量 质量 [zhi4 liang4] /quality/", "測量 测量 [ce4 liang2] /to survey/",
      "孩子 孩子 [hai2 zi5] /child/", "子 子 [zi3] /son/", "子 子 [zi5] /(noun suffix)/", "俞 俞 [Yu2] /surname Yu/", "俞 俞 [yu2] /yes/", "俞 俞 [shu4] /variant sense/",
      "佛 佛 [Fo2] /Buddha/", "佛 佛 [fu2] /used in 仿佛[fang3 fu2]/", "仿佛 仿佛 [fang3 fu2] /as if/", "佛教 佛教 [Fo2 jiao4] /Buddhism/",
    ].join("\n"),
  );
  const freq = new Map([["量", 1e-4], ["数量", 5e-5], ["质量", 9e-5], ["测量", 1e-5], ["孩子", 3e-4], ["子", 1e-4], ["仿佛", 5e-5], ["佛", 2e-5], ["俞", 1e-6]]);
  const pinlu = new Map([["量", [["liang4", 1265], ["liang2", 208]]], ["子", [["zi3", 500], ["zi5", 100]]]]);
  const mandarin = new Map([["量", ["liang4"]], ["佛", ["fu2"]]]);
  const masses = readingMass(entries, freq, pinlu, mandarin);
  // 量: liàng by far; the neutral zi of 孩子 counts for zǐ.
  assert.ok(masses.mass.get("量").get("liang4") > 5 * masses.mass.get("量").get("liang2"));
  assert.ok(masses.mass.get("子").get("zi3") > 3e-4);
  // The reader's own reading today stays first unless the evidence is
  // strong: 量 liáng gives way (twice the mass, kMandarin, a word by itself).
  const lone = new Map([["量", "liang2"], ["佛", "fo2"], ["子", "zi3"]]);
  const { ranks, rare } = ranksFrom(masses, lone, mandarin, pinlu);
  assert.deepEqual(ranks.get("量"), ["liàng", "liáng"]);
  // 佛 stays fó: fú has the mass and Unihan, but is only "used in 仿佛".
  assert.equal(ranks.get("佛")[0], "fó");
  assert.equal(ranks.get("子")[0], "zǐ");
  // A reading only a name has is known, as a rare one.
  assert.ok(!rare.get("佛")?.includes("fó"));
  // One reading in use: not a character the prior ranks.
  assert.equal(ranks.has("孩"), false);
  // A one-character word's count splits by kHanyuPinlu with the longer
  // words' share taken out: 脏 is zàng in 心脏 (most of its count) and
  // zāng as a word.
  const g = cedictEntries("髒 脏 [zang1] /dirty/\n臟 脏 [zang4] /organ/").map((e) => ({ ...e, trads: [e.trad] }));
  const shares = tokenShares(g, new Map([["脏", [["zang4", 70], ["zang1", 30]]]]), new Map(), new Map([["脏", new Map([["zang4", 6e-5]])]]), 4e-5);
  assert.ok(shares[0] > shares[1], `zāng ${shares[0]} zàng ${shares[1]}`);
});

test("the table: small, well formed, every reading a syllable the app can show", () => {
  const src = fs.readFileSync(new URL("../../web/src/script/zh-freq.ts", import.meta.url));
  assert.ok(zlib.gzipSync(src, { level: 9 }).length < 40_000, "the table stays under 40 KB gzipped");
  assert.match(src.toString(), /CC BY-SA 4\.0/);
  assert.ok(fs.existsSync(new URL("../../web/src/script/ZH-FREQ-LICENSE.txt", import.meta.url)));
  const p = shipped;
  assert.ok(p.ranks.size > 800 && p.words.size > 500 && p.anywhere.size > 100 && p.fallback.size > 10);
  const all = [...p.ranks.values(), ...p.rare.values(), ...p.words.values(), ...p.anywhere.values(), ...[...p.fallback.values()].map((r) => [r])].flat();
  for (const r of new Set(all)) {
    assert.ok(isPinyin(r), r);
    assert.ok(pinyinToZhuyin(r), `${r} in zhuyin`);
  }
  for (const [w, r] of [...p.words, ...p.anywhere]) assert.equal([...w].length, r.length, w);
  for (const [k, list] of p.block) {
    assert.match(k, /^[<>]\p{Script=Han}+=\S+( \S+)*$/u, k);
    for (const w of list) assert.ok([...w].length >= 2, `${k}: ${w}`);
  }
  // An anywhere word is simplified text and no correction twice over.
  for (const w of p.anywhere.keys()) assert.ok(!(w in READING_FIXES) && !p.words.has(w), w);
});

test("a character alone takes its most frequent reading, in the line and on the card", () => {
  // 蘋 (the bug, ld-37t), then the ones the library's first reading had wrong.
  const cases = [["蘋", "zh-TW", "píng"], ["了", "zh-CN", "le"], ["量", "zh-CN", "liàng"], ["只", "zh-CN", "zhǐ"], ["誰", "zh-TW", "shéi"]];
  for (const [ch, locale, want] of cases) {
    assert.equal(line(ch, locale), want, ch);
    assert.equal(line(`A: ${ch}!`, locale), `· · · ${want} ·`, `${ch} between other text`);
    assert.equal(charReadings(ch, locale)[0], want, `${ch} card`);
  }
  // Without the prior: the library's first.
  assert.deepEqual(without(() => ["了", "量", "只"].map((c) => line(c))), ["liǎo", "liáng", "zhī"]);
  assert.equal(without(() => charReadings("量", "zh-CN")[0]), "liáng");
  // The evidence has to be strong: 长 alone stays cháng (long), 行 xíng, 佛 fó, 干 gān.
  assert.deepEqual(["长", "行", "佛", "干", "重", "还", "觉", "乐", "发"].map((c) => line(c)), ["cháng", "xíng", "fó", "gān", "zhòng", "hái", "jué", "lè", "fā"]);
  // A traditional character that shares its simplified form keeps its own (髮 is not 发's fā).
  assert.equal(line("髮", "zh-CN"), "fà");
  assert.equal(line("髮", "zh-TW"), "fǎ");
  // The card: the rest by frequency, the word's reading still first when opened from one.
  assert.deepEqual(charReadings("行", "zh-CN").slice(0, 2), ["xíng", "háng"]);
  assert.equal(charReadings("量", "zh-CN", "liáng")[0], "liáng");
});

test("inside a word no dictionary settles, the fallback reads the character", () => {
  // 妳 (Taiwan's 你 for a woman): the library has nǎi.
  assert.equal(line("妳好嗎", "zh-TW"), "nǐ hǎo ma");
  assert.equal(without(() => line("妳好嗎", "zh-TW")), "nǎi hǎo ma");
  assert.equal(line("他是誰啊", "zh-TW").split(" ")[2], "shéi");
  assert.equal(shipped.fallback.get("妳"), "nǐ");
  // 地 得 兒 著 了 keep their own rules: never a fallback.
  for (const c of "一不地得兒儿著着了") assert.equal(shipped.fallback.has(c), false, c);
});

test("a reading a dictionary word settles is never overridden by the prior", () => {
  // A prior that would read 乐 lào and 行 héng wherever it may, and 量 liáng alone.
  const p = parsePrior({ ...table, RANKS: "乐lào,lè,yuè|行héng,xíng,háng|量liáng,liàng", FALLBACK: "乐lào|行héng|长cháng", WORDS: "", ANYWHERE: "", BLOCK: "" });
  setPrior(p);
  try {
    assert.equal(currentPrior(), p);
    // The library's words stand: 音乐 yuè, 银行 háng, 长大 zhǎng, 数量 liàng.
    assert.equal(line("我喜欢音乐"), "wǒ xǐ huan yīn yuè");
    assert.equal(line("我去银行"), "wǒ qù yín háng");
    assert.equal(line("他长大了"), "tā zhǎng dà le");
    assert.equal(line("数量很多"), "shù liàng hěn duō");
    assert.deepEqual(readDetail("我去银行", "zh-CN", { cache: false }).settled, [false, false, true, true]);
    // Where no word settles, that prior does read it (so the test bites).
    assert.equal(line("快乐"), "kuài lào");
    assert.equal(line("乐"), "lào");
    assert.equal(line("很行"), "hěn héng");
    // The app's own corrections and rules stand too.
    assert.equal(line("我睡不着"), "wǒ shuì bù zháo");
    assert.equal(line("跑得很快"), "pǎo de hěn kuài");
    assert.equal(line("長得很高", "zh-TW"), "zhǎng de hěn gāo");
  } finally {
    setPrior(shipped);
  }
  assert.equal(line("快乐"), "kuài lè");
});

test("common words the library misreads: whole runs, and inside a sentence where it is safe", () => {
  // Whole runs (a bank phrase, a gloss, a card): the table's reading.
  const whole = { 种植: "zhòng zhí", 心脏: "xīn zàng", 朝鲜: "cháo xiǎn", 向量: "xiàng liàng", 局长: "jú zhǎng", 排行榜: "pái háng bǎng" };
  for (const [w, r] of Object.entries(whole)) {
    assert.equal(line(w), r, w);
    assert.equal(line(`「${w}」 means`), `· ${r} · · · · · · ·`, `${w} between other text`);
    assert.notEqual(without(() => line(w)), r, `${w} was wrong without the prior`);
  }
  assert.equal(line("種植", "zh-TW"), "zhòng zhí");
  assert.equal(line("局長", "zh-TW"), "jú zhǎng");
  // Inside a sentence: the audited ones only.
  assert.equal(line("局长来了"), "jú zhǎng lái le");
  assert.equal(line("局長來了", "zh-TW"), "jú zhǎng lái le");
  assert.equal(line("排行榜第一"), "pái háng bǎng dì yī");
  assert.equal(line("他是船长"), "tā shì chuán zhǎng");
  assert.equal(without(() => line("局长来了")), "jú cháng lái le");
  // 种植 and 心脏 too, between word boundaries: not 这种 + 植物.
  assert.equal(line("农民种植水稻"), "nóng mín zhòng zhí shuǐ dào");
  assert.equal(line("我的心脏很好"), "wǒ de xīn zàng hěn hǎo");
  assert.equal(line("这种植物很好看"), "zhè zhǒng zhí wù hěn hǎo kàn");
  // 局 + 长期, not 局长 + 期: the word boundary and the block list both say so.
  assert.ok([...shipped.block.get(">长=zhǎng")].includes("长期"));
  assert.equal(line("中情局长期以来"), "zhōng qíng jú cháng qī yǐ lái");
  assert.equal(line("中情局長期以來", "zh-TW"), "zhōng qíng jú cháng qí yǐ lái");
  // A block word across the entry's edge vetoes it where the segmenter
  // doesn't: 视为 + 了 gives way to 视 + 为了. Without the veto the entry
  // fires there (so the test bites).
  assert.ok([...shipped.block.get(">为=wéi")].includes("为了"));
  assert.equal(line("他们视为了"), "tā men shì wèi le");
  setPrior({ ...shipped, block: new Map() });
  try {
    assert.equal(line("他们视为了"), "tā men shì wéi le");
  } finally {
    setPrior(shipped);
  }
  // Never through a word of the library's dictionary: 银行 + 行长.
  assert.equal(line("银行行长"), "yín háng háng zhǎng");
});

test("no table word fires across a word boundary (PR #62's cases, and frames)", () => {
  const cases = [
    ["牛奶和面包", 2, "hé"], ["我不当老师", 2, "dāng"], ["我有为你准备", 2, "wèi"], ["他不倒是", 2, "dǎo"], ["这种植物", 1, "zhǒng"], ["弄虚作假日益", 3, "jiǎ"],
    ["感受难以言表", 2, "nán"], ["汽油炸弹", 2, "zhà"], ["发生爆炸鸡飞狗跳", 3, "zhà"], ["华北斗争", 2, "dòu"], ["说明了", 2, "le"], ["再等待会儿", 2, "dài"],
    ["他穿着一件衣服", 2, "zhe"], ["很美的", 2, "de"], ["我还给你做饭", 1, "hái"],
  ];
  for (const [text, at, want] of cases) assert.equal(readCodePoints(text, "zh-CN", { cache: false })[at], want, text);
  // Every anywhere word takes effect beside most common words; where it
  // doesn't (a word boundary or a block word says the characters belong
  // elsewhere), the text reads exactly as it would without the entry.
  const common = [..."我你他不很有是在和的了也都"];
  for (const [w, r] of shipped.anywhere) {
    const n = r.length;
    let applied = 0;
    for (const x of common) {
      for (const [text, at] of [[x + w, 1], [w + x, 0]]) {
        const got = readCodePoints(text, "zh-CN", { cache: false }).slice(at, at + n).join(" ");
        if (got === r.join(" ")) applied++;
      }
    }
    assert.ok(applied >= 0.75 * 2 * common.length, `${w}: beside ${applied} of ${2 * common.length}`);
  }
});

test("a prior entry never replaces a reading the library's dictionary settled, unless it is marked a correction (PR #63 review)", () => {
  // 银行 is the library's word (háng). An entry against it is ignored; the
  // same entry marked "!" (CC-CEDICT reads that exact word otherwise) is not.
  const withWords = (WORDS, ANYWHERE = "") => parsePrior({ RANKS: "", FALLBACK: "", WORDS, ANYWHERE, BLOCK: "" });
  try {
    setPrior(withWords("银行=yín xíng"));
    assert.equal(line("银行"), "yín háng");
    setPrior(withWords("银行=!yín xíng"));
    assert.equal(line("银行"), "yín xíng");
    assert.ok(currentPrior().fixes.has("银行"));
    setPrior(withWords("", "银行=yín xíng"));
    assert.equal(line("我去银行了"), "wǒ qù yín háng le");
    setPrior(withWords("", "银行=!yín xíng"));
    assert.equal(line("我去银行了"), "wǒ qù yín xíng le");
    // A word the library doesn't have needs no mark.
    setPrior(withWords("", "局长=jú zhǎng"));
    assert.equal(line("局长来了"), "jú zhǎng lái le");
    // An anywhere word stands between word boundaries of the platform's
    // segmenter: 五行 (the five elements) is not in 第五行 (the fifth line).
    setPrior(withWords("", "五行=!wǔ xíng"));
    assert.equal(line("五行是金木水火土"), "wǔ xíng shì jīn mù shuǐ huǒ tǔ");
    assert.equal(line("第五行写错了"), "dì wǔ háng xiě cuò le");
    assert.deepEqual(readDetail("第五行写错了", "zh-CN", { cache: false }).starts.slice(0, 4), [true, false, true, true], "第五 | 行");
    // Both ends: 局长 starts on a boundary in 我们局长期缺人 and ends inside 长期.
    setPrior(withWords("", "局长=jú zhǎng"));
    assert.equal(line("我们局长来了"), "wǒ men jú zhǎng lái le");
    assert.equal(line("我们局长期缺人"), "wǒ men jú cháng qī quē rén");
  } finally {
    setPrior(shipped);
  }
  // The shipped corrections are marked, each one a word the library reads
  // otherwise from its own dictionary.
  assert.ok(shipped.fixes.size > 20 && shipped.fixes.size < 200, `${shipped.fixes.size} corrections`);
  for (const k of shipped.fixes) {
    const r = shipped.words.get(k) ?? shipped.anywhere.get(k);
    const plain = without(() => readDetail(k, "zh-CN", { cache: false }));
    assert.ok(plain.dict.some((d, n) => d && plain.readings[n] !== r[n]), k);
  }
  // And no unmarked entry changes one.
  for (const [k, r] of [...shipped.words, ...shipped.anywhere]) {
    if (shipped.fixes.has(k)) continue;
    const plain = without(() => readDetail(k, "zh-CN", { cache: false }));
    assert.ok(!plain.dict.some((d, n) => d && plain.readings[n] !== r[n]), k);
  }
  // 五行 inside 第五行 is the fifth line, and a numeral with one more
  // character is left to the reader (一行字 beside 一行人).
  assert.equal(line("第五行写错了"), "dì wǔ háng xiě cuò le");
  assert.equal(line("第一行"), "dì yī háng");
  for (const k of [...shipped.words.keys(), ...shipped.anywhere.keys()]) assert.ok(!([...k].length === 2 && "一二两兩三四五六七八九十几幾半每".includes([...k][0])), k);
});

test("the fallback is only for a default that is ultra-rare: one reading with 90% of the use, the default no word by itself (PR #63 review)", () => {
  assert.equal(FALLBACK_SHARE, 0.9);
  assert.ok(shipped.fallback.size <= 40, `${shipped.fallback.size} fallbacks`);
  // The reviewer's words, which the first table misread (CC-CEDICT lacks
  // them, so the sweep never saw them): each default is a word by itself.
  for (const c of "粘逮豁拧擰剥剝倔咀卷供夹") assert.equal(shipped.fallback.has(c), false, c);
  const words = { 粘土: "nián tǔ", 逮住: "dǎi zhù", 豁口: "huō kǒu", 拧紧: "nǐng jǐn", 拧螺丝: "nǐng luó sī", 剥皮: "bāo pí", 很倔: "hěn juè" };
  for (const [w, r] of Object.entries(words)) assert.equal(line(w), r, w);
});

test("on words and sentences that are not CC-CEDICT's headwords the prior is never worse, the fallback alone included", () => {
  const bare = (r) => r.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  const same = (a, b) => a === b || (a != null && (a === bare(a) || b === bare(b)) && bare(a) === bare(b));
  const empty = () => parsePrior({ RANKS: "", FALLBACK: "", WORDS: "", ANYWHERE: "", BLOCK: "" });
  const judge = () => ({
    words: EVERYDAY_WORDS.map(([w, r]) => {
      const want = r.split(" ");
      // Alone, and inside a sentence.
      const alone = readCodePoints(w, "zh-CN", { cache: false });
      const framed = readCodePoints(`他们${w}吗`, "zh-CN", { cache: false }).slice(2, -1);
      return [alone, framed].map((got) => got.every((g, k) => same(g, want[k])));
    }),
    sentences: EVERYDAY_SENTENCES.map(([t, at, r]) => same(readCodePoints(t, "zh-CN", { cache: false })[at], r)),
  });
  assert.ok(EVERYDAY_WORDS.length >= 150 && EVERYDAY_SENTENCES.length >= 60);
  const none = without(judge);
  setPrior({ ...empty(), fallback: shipped.fallback });
  const fallback = judge();
  setPrior(shipped);
  const full = judge();
  const worse = (now, k) => EVERYDAY_WORDS.filter((_, n) => none.words[n][k] && !now.words[n][k]).map((w) => w[0]);
  const fixed = (now, k) => EVERYDAY_WORDS.filter((_, n) => !none.words[n][k] && now.words[n][k]).map((w) => w[0]);
  for (const k of [0, 1]) {
    assert.deepEqual(worse(fallback, k), [], "the fallback alone makes no everyday word worse");
    assert.deepEqual(worse(full, k), [], "nor does the whole prior");
  }
  assert.ok(fixed(full, 0).length >= 9 && fixed(full, 1).length >= 6, `fixed ${fixed(full, 0)} / ${fixed(full, 1)}`);
  // The sentences are aimed at the ANYWHERE words, half of them with the
  // word's characters meeting across two words. The ones it makes worse
  // are named: each is a string that really can be read both ways, where
  // the segmenter took the word (小心 + 脏 as 心脏, 船 + 长 as 船长).
  const sWorse = EVERYDAY_SENTENCES.filter((_, n) => none.sentences[n] && !full.sentences[n]).map((s) => s[0]);
  const sFixed = EVERYDAY_SENTENCES.filter((_, n) => !none.sentences[n] && full.sentences[n]).map((s) => s[0]);
  assert.deepEqual(sWorse, ["衣服不小心脏了", "我想吃葡萄干嘛", "这只不过河的猫", "这条船长十米"]);
  assert.ok(sFixed.length >= 24, `${sFixed.length} fixed`);
  assert.deepEqual(EVERYDAY_SENTENCES.filter((_, n) => none.sentences[n] && !fallback.sentences[n]), []);
});

test("a traditional character and its simplified form lead with the same reading, alone and on the card (PR #63 review)", () => {
  for (const [t, s] of [["為", "为"], ["蘋", "苹"], ["還", "还"], ["長", "长"], ["樂", "乐"], ["覺", "觉"], ["發", "发"], ["誰", "谁"], ["種", "种"], ["當", "当"]]) {
    assert.equal(charReadings(t, "zh-CN")[0], charReadings(s, "zh-CN")[0], `${t} / ${s} card`);
    assert.equal(line(t), line(s), `${t} / ${s} alone`);
    assert.equal(line(t), charReadings(t, "zh-CN")[0], `${t}: the card leads with what the line shows`);
  }
  // Across the common traditional characters: wherever the simplified
  // form's first reading is one the traditional character has, it leads.
  let checked = 0;
  for (const t of commonChars(true)) {
    const s = simplified(t);
    if (s === t || "著乾".includes(t)) continue;
    const lead = shipped.ranks.get(s)?.[0];
    const own = shipped.ranks.get(t);
    if (!lead) continue;
    if (!mergedWith(t, s).length) assert.equal(own, undefined, `${t} takes ${s}'s entry`);
    else if (own?.includes(lead)) assert.equal(own[0], lead, `${t} leads like ${s}`);
    checked++;
  }
  assert.ok(checked > 200, `${checked} pairs`);
  // 髮 shares 发 with 發 and has no fā: its own.
  assert.equal(line("髮"), "fà");
  // 著 alone in a zh-TW text is the particle (Taiwan writes 著 for 着): zhe,
  // as before the prior; 乾 gān.
  assert.equal(line("著", "zh-TW"), "zhe");
  assert.equal(charReadings("著", "zh-TW")[0], "zhe");
  assert.equal(line("乾", "zh-TW"), "gān");
  assert.equal(shipped.ranks.has("著"), false);
});

test("the downloads are pinned and checked; the frequency tiers count what a learner meets", () => {
  assert.match(WORDFREQ_URL, /\/raw\/[0-9a-f]{40}\//, "wordfreq at a commit");
  assert.match(UNIHAN_URL, /\/Public\/\d+\.\d+\.\d+\//, "Unihan at a version");
  for (const h of [WORDFREQ_SHA256, UNIHAN_ZIP_SHA256, UNIHAN_READINGS_SHA256]) assert.match(h, /^[0-9a-f]{64}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-sha-"));
  const file = path.join(dir, "x");
  fs.writeFileSync(file, "abc");
  checkSha256(file, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => checkSha256(file, WORDFREQ_SHA256), /SHA-256 is ba7816bf/);
  fs.rmSync(dir, { recursive: true });
  // Three words by frequency; the second is wrong before and right after.
  const w = (trad, simp) => ({ trad, simp, readings: [["x1"]] });
  const words = [w("甲", "甲"), w("乙", "乙"), w("丙", "丙"), w("丁", "丁")];
  const freq = new Map([["甲", 0.5], ["乙", 0.3], ["丙", 0.2]]);
  const sweep = (bad) => new Map(words.map((x) => [x.trad, [!bad.includes(x.trad), true, !bad.includes(x.trad)]]));
  const { table: rows, wrong } = frequencyTiers(words, freq, sweep(["乙", "丙"]), sweep(["丙"]), [2, 3]);
  assert.equal(rows[0], "simplified zh-CN, top 2: before 1 (50.00%, 37.500% of running text); after 0 (0.00%, 0.000% of running text)");
  assert.equal(rows[1], "simplified zh-CN, top 3: before 2 (66.67%, 50.000% of running text); after 1 (33.33%, 20.000% of running text)");
  assert.deepEqual(wrong["simplified zh-CN"], ["3 丙 [x1]"]);
});

test("simplified text the table doesn't name reads exactly as before", () => {
  // Everyday sentences with no table word, no character alone and no
  // fallback character: with and without the prior, the same.
  const same = ["我想喝一杯咖啡", "你今天晚上有空吗", "这个多少钱", "我们明天去公园玩", "他跑得很快", "她高兴地笑了", "我去银行取钱", "请问洗手间在哪里", "天气越来越冷了", "我觉得这本书很有意思"];
  for (const t of same) assert.equal(line(t), without(() => line(t)), t);
  // And every position that does change is one the prior names: a whole
  // run in WORDS, an ANYWHERE word, a character alone, or a FALLBACK one.
  const mixed = ["局长说：行。", "心脏", "他是谁", "量", "我只有一个苹果，了解了吗"];
  for (const t of mixed) {
    const now = readCodePoints(t, "zh-CN", { cache: false });
    const was = without(() => readCodePoints(t, "zh-CN", { cache: false }));
    const cps = [...t];
    cps.forEach((c, k) => {
      if (now[k] === was[k]) return;
      const alone = !/\p{Script=Han}/u.test((cps[k - 1] ?? " ") + (cps[k + 1] ?? " "));
      const named = alone || shipped.fallback.has(c) || [...shipped.words.keys(), ...shipped.anywhere.keys()].some((w) => w.includes(c) && t.includes(w));
      assert.ok(named, `${t}: ${c} ${was[k]} → ${now[k]}`);
    });
  }
});

test("ambiguousChars: several readings in use and no word settled it", () => {
  const amb = (t, l = "zh-CN") => ambiguousChars(t, l, { cache: false }).map((k) => [...t][k]).join("");
  assert.equal(amb("很重"), "重");
  assert.equal(amb("我去银行"), "", "settled by the word");
  assert.equal(amb("局长来了"), "", "settled by the table's word");
  assert.equal(amb("快樂", "zh-TW"), "樂");
  assert.equal(amb("音樂", "zh-TW"), "");
  assert.equal(amb("行"), "行", "alone: read by the prior, still not settled");
  assert.equal(amb("hello 你好"), "");
});
