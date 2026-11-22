// The mainland's neutral tone (ld-azb, docs/VOICE.md §Uncertain readings):
// zh-CN shows it where the official HSK 3.0 list and CC-CEDICT both print it
// (web/src/script/zh-neutral.ts, zh.ts applyNeutral); zh-TW and a person's
// choice are untouched, and the tone check and the voice swap still work.
//   node --test scripts/tests/zh-neutral.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSyllables } from "../pronunciation-app.mjs";

const zh = await import("../../web/src/script/zh.ts");
const sp = await import("../../web/src/script/zh-speech.ts");
const { NEUTRAL_WORDS } = await import("../../web/src/script/zh-neutral.ts");

const read = (t, loc = "zh-CN", opts = {}) => zh.readCodePoints(t, loc, { cache: false, ...opts }).join(" ");

test("zh-CN shows the neutral tone of the table's words, alone and in a sentence", () => {
  const rows = NEUTRAL_WORDS.split("|").map((e) => e.split("="));
  assert.ok(rows.length > 200, `${rows.length} words`);
  for (const [w, r] of [["朋友", "péng you"], ["东西", "dōng xi"], ["告诉", "gào su"], ["包子", "bāo zi"], ["时候", "shí hou"], ["名字", "míng zi"], ["意思", "yì si"], ["先生", "xiān sheng"]]) {
    assert.equal(read(w), r, w);
    assert.equal(read(`我的${w}来了`).split(" ").slice(2, 2 + [...w].length).join(" "), r, `${w} in a sentence`);
  }
  // Every row reads as written.
  for (const [w, r] of rows) assert.equal(read(w), r, w);
  // Off, the reader's full tones come back.
  zh.useNeutralWords(false);
  try {
    assert.equal(read("朋友"), "péng yǒu");
  } finally {
    zh.useNeutralWords(true);
  }
});

test("where the two sources disagree or the list prints both, today's reading stays", () => {
  // HSK 3.0 prints 地方 dìfang and dìfāng, 精神 jīngshén and jīngshen, 大意 dàyì and dàyi.
  assert.ok(!NEUTRAL_WORDS.includes("精神=") && !NEUTRAL_WORDS.includes("大意=") && !NEUTRAL_WORDS.includes("地方="));
  assert.equal(read("精神"), "jīng shén");
  assert.equal(read("大意"), "dà yì");
  // Not in the table: an ordinary word keeps its tones.
  assert.equal(read("学习"), "xué xí");
});

test("zh-TW keeps its full tones", () => {
  assert.equal(read("朋友", "zh-TW"), "péng yǒu");
  assert.equal(read("東西", "zh-TW"), "dōng xī");
  assert.equal(read("告訴", "zh-TW"), "gào sù");
});

test("a person's choice outranks the table, and the neutral tone is not a mark", () => {
  const full = zh.makeCorrections({ mine: [{ word: "东西", reading: "dōng xī" }] });
  assert.equal(read("东西", "zh-CN", { corrections: full }), "dōng xī");
  assert.equal(read("有东西", "zh-CN", { corrections: full }), "yǒu dōng xī");
  // The segmenter makes 买东西 one word: the table word is found inside it
  // after a verb, and (a correction being a whole word's) only a correction
  // of 买东西 itself outranks it.
  assert.equal(read("买东西"), "mǎi dōng xi");
  assert.equal(read("买东西", "zh-CN", { corrections: zh.makeCorrections({ mine: [{ word: "买东西", reading: "mǎi dōng xī" }] }) }), "mǎi dōng xī");
  assert.deepEqual(zh.uncertainWords("前边有朋友", "zh-CN", { cache: false }), []);
  assert.deepEqual(zh.uncertainWords("下边", "zh-CN", { cache: false }), []);
});

test("a reading a rule or the prior chose otherwise is left alone", () => {
  // 还 giving back (a rule) and a word in a longer word are not the table's.
  assert.equal(read("我还钱").split(" ")[1], "huán");
  assert.equal(read("朋友们").split(" ")[0], "péng");
  const marked = (t) => zh.uncertainWords(t, "zh-CN", { cache: false }).map((w) => w.word);
  assert.deepEqual(marked("你得去"), ["得去"]);
});

test("the kids voice swap ignores a neutral tone, and a full-tone choice still swaps", () => {
  const neutral = zh.makeCorrections({ mine: [{ word: "东西", reading: "dōng xi" }] });
  const a = sp.spokenText("这个东西", "zh-CN", neutral);
  assert.equal(a.swaps.filter((s) => !/[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(s.reading)).length, 0, "a neutral syllable is never a stand-in");
  const full = zh.makeCorrections({ mine: [{ word: "东西", reading: "dōng xī" }] });
  const b = sp.spokenText("这个东西", "zh-CN", full);
  for (const s of b.swaps) assert.ok(/[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(s.reading), s.reading);
  assert.equal(sp.standIn("xi", "zh-CN"), null);
});

test("the tone check never judges a neutral syllable of the reader's reading", () => {
  const readings = zh.readCodePoints("朋友", "zh-CN", { cache: false });
  const { syllables, error } = scoreSyllables("朋友", readings);
  assert.equal(error, undefined);
  assert.equal(syllables.length, 2);
  assert.equal(syllables[0].expectedTone, 2);
  assert.equal(syllables[1].expectedTone, 0);
  assert.deepEqual(syllables[1].accept, [0]);
});
