// Uncertain readings (ld-4i2, docs/VOICE.md §Uncertain readings): which
// words the reader marks (web/src/script/zh.ts uncertainWords), and how
// often, on session-style text in both scripts.
//   node --test scripts/tests/reading-marks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_LINES } from "./zh-session-corpus.mjs";

const zh = await import("../../web/src/script/zh.ts");
const zh_standard = await import("../../web/src/script/zh-standard.ts");
const OpenCC = await import("../../web/node_modules/opencc-js/dist/esm/cn2t.js");
const toTw = (OpenCC.default ?? OpenCC).Converter({ from: "cn", to: "tw" });

const seg = new Intl.Segmenter("zh", { granularity: "word" });
const isHan = (c) => /\p{Script=Han}/u.test(c);
const marked = (text, locale = "zh-CN") => zh.uncertainWords(text, locale, { cache: false }).map((w) => w.word);

/** Words per 100 marked over `lines` (a word: a segmenter word with a Chinese character). */
function rate(lines, locale) {
  let words = 0;
  let marks = 0;
  for (const t of lines) {
    words += [...seg.segment(t)].filter((s) => [...s.segment].some(isHan)).length;
    marks += zh.uncertainWords(t, locale, { cache: false }).length;
  }
  return { words, marks, per100: (100 * marks) / words };
}

test("the rate: on session-style text at most 2 words in 100 are marked, in either script (with every character marked that has two ordinary readings, it was 9)", () => {
  const cn = rate(SESSION_LINES, "zh-CN");
  const tw = rate(SESSION_LINES.map(toTw), "zh-TW");
  assert.ok(cn.words > 900 && tw.words > 900, "the corpus is a real sample");
  for (const [name, r] of [["zh-CN", cn], ["zh-TW", tw]]) {
    assert.ok(r.per100 <= 2, `${name}: ${r.marks} marks in ${r.words} words (${r.per100.toFixed(2)} per 100)`);
    assert.ok(r.marks > 0, `${name}: the corpus has uncertain words`);
  }
});

test("what is marked: a word no dictionary word settled, with a character of two ordinary readings; a single character joins its neighbour", () => {
  // 得 dé / děi, 倒 dǎo / dào, 宿 sù / xiǔ, 长 cháng / zhǎng: the reader's
  // first is the default, and nothing in its dictionary says otherwise.
  assert.deepEqual(marked("你得去银行"), ["得去"]);
  assert.deepEqual(marked("他在倒车"), ["倒车"]);
  assert.deepEqual(marked("住一宿"), ["一宿"]);
  assert.deepEqual(marked("他长着大眼睛"), ["长着"]);
  assert.deepEqual(marked("我的头发有点干。"), ["有点干"], "no word after it: the one before");
  assert.deepEqual(marked("他量很大"), ["他量"], "a function word after it (很): the one before");
  assert.deepEqual(marked("房间在五楼，第五行的那个门。"), ["第五行"]);
  // The reader's own mistakes are among them (得 after a verb is de).
  assert.deepEqual(marked("你问得很好"), ["问得"]);
  // Both scripts.
  assert.deepEqual(marked("你得去銀行", "zh-TW"), ["得去"]);
  assert.deepEqual(marked("他長著大眼睛", "zh-TW"), ["長著"]);
  const [w] = zh.uncertainWords("你得去银行", "zh-CN", { cache: false });
  assert.deepEqual([w.start, w.end, w.reading, w.unsure, w.suggested], [1, 3, ["dé", "qù"], [1], false]);
  assert.deepEqual(zh.unsureOffsets("𠮷你得去", "zh-CN", { cache: false }).map((o) => [o.start, o.end]), [[3, 5]], "UTF-16 offsets");
});

test("what is not marked: dictionary words, the particles and the characters context settles, a neutral tone, a character alone", () => {
  for (const t of ["他在银行工作", "第五行写错了", "我们一行人", "你抽空来", "我觉得很好", "他们是好朋友"]) assert.deepEqual(marked(t), [], t);
  // CONTEXT_SETTLED: 吗 (má only in 干吗), 着 (zhe after a verb), 要 (yāo
  // in 要求), 给 (jǐ in 供给), 少, 分, 几, 地.
  for (const t of ["你好吗", "他看着我", "我要一杯咖啡", "给我一个", "多少钱", "五分钟", "几天", "地上有水"]) assert.deepEqual(marked(t), [], t);
  for (const ch of "吗着要给少分几地") assert.ok(zh.CONTEXT_SETTLED.includes(ch), ch);
  // 还 huán is under 5% of 还's use: not an ordinary reading, so 还书 is
  // not marked (the learner can still correct it from the card).
  assert.deepEqual(marked("我去图书馆还书"), []);
  // One character with no Chinese neighbour: nothing to correct as a word.
  assert.deepEqual(marked("长！"), []);
  // Not Chinese at all.
  assert.deepEqual(marked("hola"), []);
});

/* ------------------------------ corrections ------------------------------ */

const read = (text, locale, corrections) => zh.readCodePoints(text, locale, { cache: false, corrections }).filter(Boolean).join(" ");
const set = (lists) => zh.makeCorrections(lists);

test("ranks: the learner's own > the shared list > the library's dictionary > the prior; a recap suggestion only over the last two", () => {
  // 银行 is a dictionary word (háng); a made-up shared entry outranks it,
  // and the learner's own outranks that.
  assert.equal(read("他在银行工作", "zh-CN", null), "tā zài yín háng gōng zuò");
  const shared = { word: "银行", reading: "yín xíng" };
  assert.equal(read("他在银行工作", "zh-CN", set({ shared: [shared] })), "tā zài yín xíng gōng zuò");
  assert.equal(read("他在银行工作", "zh-CN", set({ shared: [shared], mine: [{ word: "銀行", reading: "yín háng" }] })), "tā zài yín háng gōng zuò", "mine, keyed across scripts");
  // A suggestion: over the prior (得 dé), not over a person's.
  assert.equal(read("你得去", "zh-CN", set({ suggested: [{ word: "得去", reading: "děi qù" }] })), "nǐ děi qù");
  assert.equal(read("你得去", "zh-CN", set({ suggested: [{ word: "得去", reading: "děi qù" }], shared: [{ word: "得去", reading: "dé qù" }] })), "nǐ dé qù");
  // A suggested word stays marked (and says so); a person's is not marked.
  assert.deepEqual(zh.uncertainWords("你得去", "zh-CN", { corrections: set({ suggested: [{ word: "得去", reading: "děi qù" }] }) }).map((w) => [w.word, w.reading.join(" "), w.suggested]), [["得去", "děi qù", true]]);
  assert.deepEqual(zh.uncertainWords("你得去", "zh-CN", { corrections: set({ mine: [{ word: "得去", reading: "dé qù" }] }) }), [], "confirmed by hand: no mark");
  assert.deepEqual(zh.uncertainWords("你得去", "zh-CN", { corrections: set({ shared: [{ word: "得去", reading: "děi qù" }] }) }), []);
  // The browser's own set (setCorrections) is what a plain read uses.
  zh.setCorrections(set({ mine: [{ word: "得去", reading: "děi qù" }, { word: "银行", reading: "yín xíng" }] }));
  try {
    assert.equal(zh.readCodePoints("你得去", "zh-CN").join(" "), "nǐ děi qù");
    assert.deepEqual(marked("你得去"), [], "settled by the set");
    // What a hint is judged against is the reader's own, whoever's set is in use.
    assert.deepEqual(zh.validateHint("银行", "yín xíng", "zh-CN"), { ok: false, why: "settled" });
  } finally {
    zh.setCorrections(null);
  }
  assert.equal(zh.readCodePoints("你得去", "zh-CN").join(" "), "nǐ dé qù", "cleared: the cache was emptied");
});

test("whole words only: between the segmenter's word boundaries, never cutting a dictionary word, in sentences and both scripts", () => {
  const c = set({ shared: [{ word: "还书", reading: "huán shū" }, { word: "一行", reading: "yī háng" }, { word: "得去", reading: "děi qù" }] });
  assert.equal(read("我去图书馆还书", "zh-CN", c), "wǒ qù tú shū guǎn huán shū");
  assert.equal(read("我去圖書館還書", "zh-TW", c), "wǒ qù tú shū guǎn huán shū", "a simplified entry reads traditional text");
  assert.equal(read("你还书了吗", "zh-CN", c), "nǐ huán shū le ma");
  // 一行 inside 一行人 (行人 is a dictionary word) and 第一行 (第一 is a word): untouched.
  assert.equal(read("我们一行人", "zh-CN", c), read("我们一行人", "zh-CN", null));
  assert.equal(read("第一行有错", "zh-CN", c), "dì yī háng yǒu cuò");
  // 得去 not inside 舍得去 / 来得去: the segmenter's word there is longer or the cut falls inside one.
  for (const t of ["我舍不得去", "他记得去年的事"]) assert.equal(read(t, "zh-CN", c), read(t, "zh-CN", null), t);
  // A shared "tw" entry: a zh-TW text only.
  const tw = set({ shared: [{ word: "垃圾", reading: "lè sè", scope: "tw" }] });
  assert.equal(read("倒垃圾", "zh-CN", tw), read("倒垃圾", "zh-CN", null));
  // A malformed entry is skipped (one character, a count that doesn't match, not a syllable).
  const bad = set({ mine: [{ word: "得", reading: "děi" }, { word: "得去", reading: "děi" }, { word: "银行", reading: "yin2 hang2" }] });
  assert.equal(bad.mine.size, 0);
});

test("validateCorrection: two to eight Chinese characters, one real reading each; correctionScope; wordAt", () => {
  assert.deepEqual(zh.validateCorrection("得去", "děi qù", "zh-CN"), { ok: true, word: "得去", reading: ["děi", "qù"] });
  assert.deepEqual(zh.validateCorrection("還書", ["huán", "shū"], "zh-TW"), { ok: true, word: "還書", reading: ["huán", "shū"] });
  assert.equal(zh.validateCorrection("得", "děi", "zh-CN").why, "shape", "one character alone");
  assert.equal(zh.validateCorrection("得去!", "děi qù", "zh-CN").why, "shape");
  assert.equal(zh.validateCorrection("得去", "děi", "zh-CN").why, "count");
  assert.equal(zh.validateCorrection("得去", "dǎi qù", "zh-CN").why, "unknown", "a sound 得 doesn't have");
  assert.equal(zh.validateCorrection("得去", "dei3 qu4", "zh-CN").why, "unknown", "tone marks only");
  assert.equal(zh.validateCorrection(42, "x", "zh-CN").why, "shape");
  // A rare reading a person may choose (a hint may not): 还 huán.
  assert.equal(zh.validateCorrection("还书", "huán shū", "zh-CN").ok, true);
  assert.equal(zh.correctionScope("垃圾", ["lè", "sè"], "zh-TW"), "all", "not one of TAIWAN_READINGS' characters");
  assert.equal(zh.correctionScope("星期", ["xīng", "qí"], "zh-TW"), "tw");
  assert.equal(zh.correctionScope("星期", ["xīng", "qí"], "zh-CN"), "all");
  assert.equal(zh.correctionKey("還書"), "还书");
  // The card's word: the marked one around a character, else the segmenter's.
  assert.deepEqual(zh.wordAt("你得去银行", "zh-CN", 1), { word: "得去", reading: ["dé", "qù"], start: 1, unsure: true, suggested: false });
  assert.equal(zh.wordAt("他在银行工作", "zh-CN", 3).word, "银行");
  assert.equal(zh.wordAt("他在银行工作", "zh-CN", 3).unsure, false);
  assert.equal(zh.wordAt("好！", "zh-CN", 0), null);
});

test("common words read as CC-CEDICT reads them are not marked (PR #67 review), in a segmenter word or across its split; the real catches stay", () => {
  // The library's dictionary leaves out every word read by default; the
  // common-word list (zh-words.ts) settles them where the reader agrees.
  for (const [t, loc] of [["再见", "zh-CN"], ["再見", "zh-TW"], ["你好再見", "zh-TW"], ["当然可以", "zh-CN"], ["當然可以", "zh-TW"], ["我的教练", "zh-CN"], ["没关系", "zh-CN"]]) assert.deepEqual(marked(t, loc), [], t);
  assert.deepEqual(marked("你得去银行"), ["得去"]);
  assert.deepEqual(marked("我得走了"), ["得走了"]);
  assert.deepEqual(marked("她长着大眼睛"), ["长着"]);
  // The session corpus: down from 1.80 / 1.63 per 100.
  assert.ok(rate(SESSION_LINES, "zh-CN").per100 < 1.5);
  assert.ok(rate(SESSION_LINES.map(toTw), "zh-TW").per100 < 1.5);
});

test("还 giving back is huán (PR #67 review); a correction starts after a pronoun ICU joined to it, never across a real word", () => {
  const at = (t, k, loc = "zh-CN") => zh.readCodePoints(t, loc, { cache: false })[k];
  assert.equal(at("我还钱", 1), "huán");
  assert.equal(at("我要还钱", 2), "huán");
  assert.equal(at("你还书了吗", 1), "huán");
  assert.equal(at("我還你錢", 1, "zh-TW"), "huán");
  // 还 still: untouched.
  for (const [t, k] of [["我还有钱", 1], ["我还给你做饭", 1], ["他还在", 1], ["还是你", 0]]) assert.equal(at(t, k), "hái", t);
  // ICU segments 我还|书: a correction of 还书 applies there all the same.
  assert.deepEqual([...seg.segment("我还书")].map((s) => s.segment), ["我还", "书"]);
  const fix = zh.makeCorrections({ mine: [{ word: "还书", reading: "hái shū" }] });
  assert.equal(zh.readCodePoints("我还书", "zh-CN", { cache: false, corrections: fix })[1], "hái");
  // Only after a pronoun: 第五|行 and 公安局长|时间 stay closed.
  const wuxing = zh.makeCorrections({ mine: [{ word: "五行", reading: "wǔ xíng" }] });
  assert.equal(zh.readCodePoints("第五行写错了", "zh-CN", { cache: false, corrections: wuxing })[2], "háng");
  assert.equal(zh.readCodePoints("第五行写错了", "zh-CN", { cache: false })[2], "háng");
  assert.equal(zh.readCodePoints("公安局长时间加班", "zh-CN", { cache: false })[3], "cháng");
});

test("还 before 钱 / 书 / 你 is huán only where the phrase ends; elsewhere hái and marked, until a person settles it (PR #67 second review)", () => {
  const at = (t, k, loc = "zh-CN") => zh.readCodePoints(t, loc, { cache: false })[k];
  // Ends: the text's end, punctuation, a particle, 给, 的时候, a number.
  for (const [t, k, loc] of [["我还钱", 1], ["我要还钱", 2], ["你还书了吗", 1], ["我还书。", 1], ["我还你钱", 1], ["还钱三百", 0], ["你还书的时候", 1], ["我還書。", 1, "zh-TW"], ["還錢", 0, "zh-TW"]]) {
    assert.equal(at(t, k, loc), "huán", t);
    assert.deepEqual(marked(t, loc ?? "zh-CN"), [], t);
  }
  // Can't tell: hái, and the 还 word marked (never ICU's 我还).
  for (const [t, k, word] of [["他还书包里放了一本书", 1, "还书包"], ["我还钱不够", 1, "还钱"], ["他去还书店", 2, "还书店"], ["我还钱包", 1, "还钱包"]]) {
    assert.equal(at(t, k), "hái", t);
    assert.deepEqual(marked(t), [word], t);
  }
  // Never 还给, nor 还 before anything else.
  for (const [t, k] of [["我还给你做饭", 1], ["我还有钱", 1], ["他还在", 1]]) {
    assert.equal(at(t, k), "hái", t);
    assert.deepEqual(marked(t), [], t);
  }
  // A person's reading settles a doubtful one: the mark goes.
  const fix = zh.makeCorrections({ mine: [{ word: "还钱", reading: "hái qián" }] });
  assert.deepEqual(zh.uncertainWords("我还钱不够", "zh-CN", { cache: false, corrections: fix }), []);
});

const line = (t, loc = "zh-CN") => zh.readCodePoints(t, loc, { cache: false }).filter(Boolean).join(" ");

test("every common word reads as CC-CEDICT reads it and is never marked (PR #67): the reduplicated and kids' words, names, in both scripts", () => {
  // CC-CEDICT's reading, a doubled character read alike (狗狗 [gou3 gou1]
  // is gǒu gǒu) with its neutral tone where CC-CEDICT gives one; 喳喳,
  // 懒洋洋 and 宏碁 (WORD_SKIP: the reader's reading) settled too.
  const words = {
    狗狗: "gǒu gǒu", 宝宝: "bǎo bao", 妈妈: "mā ma", 爸爸: "bà ba", 哥哥: "gē ge", 姐姐: "jiě jie", 弟弟: "dì di", 妹妹: "mèi mei",
    爷爷: "yé ye", 奶奶: "nǎi nai", 谢谢: "xiè xie", 星星: "xīng xing", 看看: "kàn kan", 刚刚: "gāng gang", 天天: "tiān tiān",
    慢慢: "màn màn", 常常: "cháng cháng", 一点点: "yī diǎn diǎn", 猫猫: "māo māo", 想想: "xiǎng xiǎng", 试试: "shì shì",
    喳喳: "zhā zhā", 懒洋洋: "lǎn yáng yáng", 宏碁: "hóng qí", 长沙: "cháng shā", 华盛顿: "huá shèng dùn", 基督教: "jī dū jiào",
  };
  for (const [w, r] of Object.entries(words)) {
    for (const [t, loc] of [[w, "zh-CN"], [toTw(w), "zh-TW"]]) {
      assert.equal(line(t, loc), r, `${t} ${loc}`);
      assert.deepEqual(marked(t, loc), [], `${t} ${loc}`);
    }
  }
  // In sentences, the same.
  assert.equal(line("我家的狗狗很可爱"), "wǒ jiā de gǒu gǒu hěn kě ài");
  assert.equal(line("谢谢妈妈"), "xiè xie mā ma");
  assert.equal(line("你看看天上的星星"), "nǐ kàn kan tiān shàng de xīng xing");
  for (const t of ["我家的狗狗很可爱", "谢谢妈妈", "我刚刚到", "去长沙玩"]) assert.deepEqual(marked(t), [], t);
});

test("the common words leave the reader's call where CC-CEDICT reads a word two ways, or a rule settled it otherwise (PR #67)", () => {
  // 明朝: Míng cháo (the dynasty) / míng zhāo (tomorrow morning).
  assert.equal(line("明朝"), "míng cháo");
  assert.deepEqual(marked("明朝"), ["明朝"]);
  assert.deepEqual(marked("正当"), ["正当"]);
  // A reading the reader's rules chose stays (不当 is a word, but in
  // 我不当老师 当 is dāng; 还给 in 我还给你做饭 is hái).
  assert.equal(line("我不当老师"), "wǒ bù dāng lǎo shī");
  assert.equal(line("我还给你做饭"), "wǒ hái gěi nǐ zuò fàn");
  // A simplified character for two traditional ones: 散髮 (hair) is no 散發 sàn fā.
  assert.equal(line("蓬頭散髮", "zh-TW"), "péng tóu sàn fǎ");
  assert.equal(line("散發", "zh-TW"), "sàn fā");
});

test("gen-zh-words: CC-CEDICT's readings of the top words, doubles read alike, neutral-only variants together, two readings apart", async () => {
  const { cedictWords, evenDoubles } = await import("../gen-zh-words.mjs");
  const { cedictEntries } = await import("../gen-zh-freq.mjs");
  assert.deepEqual(evenDoubles(["狗", "狗"], ["gǒu", "gōu"]), ["gǒu", "gǒu"]);
  assert.deepEqual(evenDoubles(["妈", "妈"], ["mā", "ma"]), ["mā", "ma"]);
  const text = [
    "狗狗 狗狗 [gou3 gou1] /doggy/",
    "東西 东西 [dong1 xi1] /east and west/",
    "東西 东西 [dong1 xi5] /thing/",
    "明朝 明朝 [Ming2 chao2] /Ming Dynasty/",
    "明朝 明朝 [ming2 zhao1] /tomorrow morning/",
    "長沙 长沙 [Chang2 sha1] /see 長沙市|长沙市[Chang2 sha1 Shi4]/",
    "稀有 稀有 [xi1 you3] /rare/",
  ].join("\n");
  const freq = new Map([["狗狗", 5], ["东西", 9], ["明朝", 4], ["长沙", 3], ["稀有", 1], ["的", 10]]);
  const { words, two } = cedictWords(cedictEntries(text), freq, 5);
  const got = Object.fromEntries(words.map((w) => [w.word, w.readings.map((r) => r.join(" "))]));
  // 稀有 is past the top 5; 的 is one character.
  assert.deepEqual(got, { 东西: ["dōng xī", "dōng xi"], 狗狗: ["gǒu gǒu"], 长沙: ["cháng shā"] });
  assert.deepEqual(two.map((t) => t.word), ["明朝"]);
});

test("words CC-CEDICT reads two ways take the learner's standard reading (zh-standard.ts: HSK 3.0, else a stated judgement), zh-TW only where Taiwan agrees (PR #67)", () => {
  const { STANDARD_READINGS } = zh_standard;
  assert.ok(STANDARD_READINGS.length >= 30);
  for (const s of STANDARD_READINGS) {
    assert.ok(/^HSK 3\.0 level|^judgement: /.test(s.note), s.word);
    const first = s.reading.split("/")[0];
    // Alone, in a sentence: the standard reading (or another standard one), settled.
    for (const t of [s.word, `${s.word}，我知道。`]) {
      const got = zh.readCodePoints(t, "zh-CN", { cache: false }).filter(Boolean).join(" ");
      assert.ok(s.reading.split("/").some((r) => got.includes(r)), `${t}: ${got}, want ${first}`);
    }
    assert.deepEqual(marked(s.word), [], s.word);
  }
  // The reader alone read these otherwise.
  assert.equal(line("当天"), "dàng tiān");
  assert.equal(line("恶心"), "ě xin");
  assert.equal(line("琢磨"), "zuó mo");
  // zh-TW keeps Taiwan's reading where it differs.
  assert.equal(line("當天", "zh-TW"), "dāng tiān");
  assert.equal(line("琢磨", "zh-TW"), "zhuó mó");
  // A longer word the segmenter splits keeps its own reading.
  assert.equal(line("好事者"), "hào shì zhě");
  assert.equal(line("便宜行事"), "biàn yi xíng shì");
  // 盡量 (jìn) is not 儘量 (jǐn): the traditional spelling decides.
  assert.equal(line("儘量"), "jǐn liàng");
  assert.equal(line("盡量"), "jìn liàng");
  // Listed both ways, or the other sense as common: still the reader's, marked.
  assert.deepEqual(marked("正当"), ["正当"]);
  assert.deepEqual(marked("所长"), ["所长"]);
});
