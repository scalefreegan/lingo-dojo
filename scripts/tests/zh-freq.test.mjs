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
import { cedictEntries, decodeCBpack, marked, ranksFrom, readingMass, tokenShares } from "../gen-zh-freq.mjs";
import { numbered } from "../pinyin-sweep.mjs";
import * as table from "../../web/src/script/zh-freq.ts";
import { READING_FIXES, ambiguousChars, charReadings, currentPrior, parsePrior, readCodePoints, readDetail, setPrior } from "../../web/src/script/zh.ts";
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
  assert.ok(p.ranks.size > 800 && p.words.size > 500 && p.anywhere.size > 100 && p.fallback.size > 20);
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
  // 种植 and 心脏 are whole-run only: 这种植物, 不小心脏了 would misread.
  assert.equal(shipped.anywhere.has("种植"), false);
  assert.equal(line("这种植物很好看"), "zhè zhǒng zhí wù hěn hǎo kàn");
  // A block word across the entry's edge vetoes it: 局 + 长期, not 局长 + 期.
  assert.ok([...shipped.block.get(">长=zhǎng")].includes("长期"));
  assert.equal(line("中情局长期以来"), "zhōng qíng jú cháng qī yǐ lái");
  assert.equal(line("中情局長期以來", "zh-TW"), "zhōng qíng jú cháng qí yǐ lái");
  // Without the veto the entry would fire there (so the test bites).
  setPrior({ ...shipped, block: new Map() });
  try {
    assert.equal(line("中情局长期以来").split(" ")[3], "zhǎng");
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
  // Every anywhere word reads as corrected beside each common word.
  const common = [..."我你他不很有是在和的了也都"];
  for (const [w, r] of shipped.anywhere) {
    const n = r.length;
    for (const x of common) {
      assert.equal(readCodePoints(x + w, "zh-CN", { cache: false }).slice(1).join(" "), r.join(" "), x + w);
      assert.equal(readCodePoints(w + x, "zh-CN", { cache: false }).slice(0, n).join(" "), r.join(" "), w + x);
    }
  }
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
