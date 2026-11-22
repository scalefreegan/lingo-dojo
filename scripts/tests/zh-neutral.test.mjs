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
  for (const [w, r] of [["朋友", "péng you"], ["告诉", "gào su"], ["包子", "bāo zi"], ["时候", "shí hou"], ["名字", "míng zi"], ["意思", "yì si"], ["先生", "xiān sheng"]]) {
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

test("a word CC-CEDICT also reads full-tone for another sense is not neutralised blind (PR #71 review)", () => {
  // The compass, "said", the handle: read as before, never dōng xi / shuō dao / bǎ shou.
  assert.equal(read("东西南北"), "dōng xī nán běi");
  assert.equal(read("东西方向的路"), "dōng xī fāng xiàng de lù");
  assert.equal(read("他说道"), "tā shuō dào");
  assert.equal(read("门把手"), "mén bǎ shǒu");
  assert.equal(read("东西部地区").split(" ").slice(0, 3).join(" "), "dōng xī bù");
  // 东西 "a thing": where the words around it say so.
  for (const [t, r] of [["买东西", "mǎi dōng xi"], ["什么东西", "shén me dōng xi"], ["这个东西", "zhè ge dōng xi"], ["好东西", "hǎo dōng xi"], ["这是我的东西", "zhè shì wǒ de dōng xi"], ["我的东西呢", "wǒ de dōng xi ne"]]) assert.equal(read(t), r, t);
  // The words that stay out of the table.
  for (const w of ["东西", "买卖", "大方", "工夫", "把手", "人家", "大爷", "公道", "说道", "上头", "多少", "生意", "妻子", "本事", "出息"]) assert.ok(!NEUTRAL_WORDS.split("|").some((e) => e.startsWith(`${w}=`)), w);
  // Same word and sense, only a variant pronunciation: neutral.
  assert.equal(read("告诉"), "gào su");
  assert.equal(read("故事"), "gù shi");
  // Never a silent wrong reading: none of these is newly marked or newly settled.
  assert.deepEqual(zh.uncertainWords("东西南北", "zh-CN", { cache: false }), []);
});

test("more compass and handle contexts, and the hints and marks the neutral tone must not disturb (PR #71 review)", () => {
  for (const [t, r] of [["东西走向", "dōng xī zǒu xiàng"], ["东西两岸", "dōng xī liǎng àn"], ["东西向", "dōng xī xiàng"], ["南北东西", "nán běi dōng xī"], ["横穿东西", "héng chuān dōng xī"], ["把手放下", "bǎ shǒu fàng xià"]]) assert.equal(read(t), r, t);
  // A hint that is only the full tone of a neutral syllable is not kept (nor laid over it).
  for (const [w, full, line] of [["朋友", "péng yǒu", "我的朋友来了"], ["告诉", "gào sù", "他告诉我"], ["时候", "shí hòu", "什么时候"], ["意思", "yì sī", "没意思"]]) {
    assert.equal(zh.hintToKeep(w, full.split(" "), [line], "zh-CN"), null, w);
    const laid = zh.withHints(line, "zh-CN", [{ term: w, reading: full }]);
    assert.deepEqual(laid, zh.readCodePoints(line, "zh-CN", { cache: false }), w);
  }
  assert.equal(zh.hintToKeep("朋友", ["péng", "yǒu"], ["我的朋友来了"], "zh-TW"), null, "zh-TW reads it full already");
  // A hint that really differs still is kept.
  assert.equal(zh.hintToKeep("还钱", ["hái", "qián"], ["还钱了"], "zh-CN") === null, false);
  // 啊 呀 瘩 stay marked in both scripts, as on main (the neutral reading is no other reading only where applyNeutral put it).
  const marked = (t, loc) => zh.uncertainWords(t, loc, { cache: false }).map((w) => w.word);
  assert.deepEqual(marked("他是誰啊", "zh-TW"), ["誰啊"]);
  assert.ok(marked("他是谁啊", "zh-CN").length > 0, "啊 is marked in zh-CN too");
  for (const [t, loc] of [["他是誰啊", "zh-TW"], ["你好呀", "zh-TW"], ["疙瘩", "zh-TW"], ["他是谁啊", "zh-CN"], ["你好呀", "zh-CN"], ["疙瘩", "zh-CN"]]) {
    const on = marked(t, loc);
    zh.useNeutralWords(false);
    try {
      assert.deepEqual(on, marked(t, loc), `${t} ${loc} is marked as without the table`);
    } finally {
      zh.useNeutralWords(true);
    }
  }
});

test("东西 after a cue is never wrong and unmarked; the neutral flag does not outlive a suggestion (PR #71 re-review)", () => {
  const marked = (t, loc = "zh-CN", opts = {}) => zh.uncertainWords(t, loc, { cache: false, ...opts });
  for (const t of ["公园的东西门都开着", "中国的东西差异很大", "这条路的东西长三公里", "城市的东西轴线", "我要东西对称", "长江的东西"]) {
    const r = read(t).split(" ");
    const at = [...t].indexOf("西");
    assert.equal(r[at], "xī", t);
    assert.ok(marked(t).some((w) => w.word.includes("东西")), `${t} is marked`);
  }
  for (const t of ["买东西", "什么东西", "我的东西呢"]) {
    assert.ok(read(t).split(" ").includes("xi"), t);
    assert.deepEqual(marked(t), [], t);
  }
  // A correcting hint for the compass is not dropped.
  assert.equal(zh.hintToKeep("东西", ["dōng", "xī"], ["公园的东西门都开着"], "zh-CN"), null, "already read so");
  // A recap's suggestion for a word that applyNeutral had made neutral keeps the mark.
  assert.deepEqual(marked("你多大岁数了？", "zh-CN", { corrections: zh.makeCorrections({ suggested: [{ word: "岁数", reading: "suì shù" }] }) }).map((w) => [w.word, w.unsure, w.suggested]), [["岁数", [4], true]]);
  // Anything else: the same marks with and without the table, a suggestion or not.
  for (const [line, word, reading] of [["你们商量一下", "商量", "shāng liáng"], ["他的功夫很好", "功夫", "gōng fū"], ["你多大岁数了？", "岁数", "suì shu"]]) {
    const sug = zh.makeCorrections({ suggested: [{ word, reading }] });
    const on = JSON.stringify(marked(line, "zh-CN", { corrections: sug }));
    zh.useNeutralWords(false);
    try {
      assert.equal(on, JSON.stringify(marked(line, "zh-CN", { corrections: sug })), word);
    } finally {
      zh.useNeutralWords(true);
    }
  }
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
