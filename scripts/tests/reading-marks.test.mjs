// Uncertain readings (ld-4i2, docs/VOICE.md §Uncertain readings): which
// words the reader marks (web/src/script/zh.ts uncertainWords), and how
// often, on session-style text in both scripts.
//   node --test scripts/tests/reading-marks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_LINES } from "./zh-session-corpus.mjs";

const zh = await import("../../web/src/script/zh.ts");
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
  assert.deepEqual(marked("停车场很窄"), ["停车场"], "a function word after it (很): the one before");
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
