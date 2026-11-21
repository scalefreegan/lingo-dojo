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
