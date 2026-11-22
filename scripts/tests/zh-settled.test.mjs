// Settled words (ld-l1d, docs/VOICE.md §Uncertain readings): HSK 3.0 words
// beyond the common words that the reader reads right are no longer marked
// (zh.ts applySettled, web/src/script/zh-settled.ts); no reading changes,
// and a person's choice, the recap, a doubt and the other tables still win.
//   node --test scripts/tests/zh-settled.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_LINES } from "./zh-session-corpus.mjs";
import { EVERYDAY_SENTENCES } from "./zh-everyday.mjs";

const zh = await import("../../web/src/script/zh.ts");
const { SETTLED_WORDS, SETTLED_CN } = await import("../../web/src/script/zh-settled.ts");
const { COMMON_WORDS } = await import("../../web/src/script/zh-words.ts");
const { STANDARD_READINGS, UNSETTLED_WORDS } = await import("../../web/src/script/zh-standard.ts");

const marked = (t, loc = "zh-CN", corrections = null) => zh.uncertainWords(t, loc, { cache: false, corrections }).map((w) => w.word);
const read = (t, loc = "zh-CN", corrections = null) => zh.readCodePoints(t, loc, { cache: false, corrections }).filter(Boolean).join(" ");
/** `fn` with the table off, then back on. */
function without(fn) {
  zh.useSettledWords(false);
  try {
    return fn();
  } finally {
    zh.useSettledWords(true);
  }
}
const rows = (s) => s.split("|").filter(Boolean).map((e) => e.split("~")[0].split("="));

test("the bead's words are read as before and no longer marked, alone and in a sentence, in both scripts", () => {
  const cases = [
    ["干杯", "gān bēi"], ["我们干杯吧", "wǒ men gān bēi ba"], ["这首歌难听死了", "zhè shǒu gē nán tīng sǐ le"],
    ["他每天长跑", "tā měi tiān cháng pǎo"], ["公园里的柏树很高", "gōng yuán lǐ de bǎi shù hěn gāo"],
  ];
  for (const [t, r] of cases) {
    assert.equal(read(t), r, t);
    assert.deepEqual(marked(t), [], t);
    assert.equal(without(() => read(t)), r, `${t}: the same reading without the table`);
    assert.notDeepEqual(without(() => marked(t)), [], `${t}: marked without the table`);
  }
  for (const t of ["乾杯", "難聽", "長跑", "我們乾杯吧"]) assert.deepEqual(marked(t, "zh-TW"), [], t);
});

test("zh-TW only where its reading is the same: 柏樹 (Taiwan bó), 不由得 and 挑剔 (full tones there) stay marked", () => {
  assert.deepEqual(marked("柏树"), []);
  assert.deepEqual(marked("柏樹", "zh-TW"), ["柏樹"]);
  for (const t of ["不由得", "挑剔"]) {
    assert.deepEqual(marked(t), [], t);
    assert.deepEqual(marked(t, "zh-TW"), [t], t);
  }
  const cn = rows(SETTLED_CN).map(([w]) => w);
  assert.deepEqual(new Set(cn), new Set(["不由得", "柏树", "挑剔"]));
});

test("no reading moves: session lines and the everyday sentences read the same with the table on and off, in both scripts", () => {
  const lines = [...SESSION_LINES, ...EVERYDAY_SENTENCES.map(([t]) => t), ...rows(SETTLED_WORDS).map(([w]) => `我觉得${w}。`)];
  for (const loc of ["zh-CN", "zh-TW"]) {
    for (const t of lines) assert.equal(read(t, loc), without(() => read(t, loc)), t);
  }
  // And it only takes marks away.
  for (const t of lines) {
    const off = without(() => marked(t));
    for (const w of marked(t)) assert.ok(off.includes(w), `${t}: ${w} marked only with the table`);
  }
});

test("a person's choice, the shared list and the recap's suggestion outrank it", () => {
  const mine = zh.makeCorrections({ mine: [{ word: "长跑", reading: "zhǎng pǎo" }] });
  assert.equal(read("他每天长跑", "zh-CN", mine), "tā měi tiān zhǎng pǎo");
  assert.deepEqual(marked("他每天长跑", "zh-CN", mine), []);
  const shared = zh.makeCorrections({ shared: [{ word: "干杯", reading: "gàn bēi" }] });
  assert.equal(read("我们干杯吧", "zh-CN", shared), "wǒ men gàn bēi ba");
  // A recap's suggestion is read and stays marked: never settled under it.
  const suggested = zh.makeCorrections({ suggested: [{ word: "干杯", reading: "gàn bēi" }] });
  assert.equal(read("我们干杯吧", "zh-CN", suggested), "wǒ men gàn bēi ba");
  const [w] = zh.uncertainWords("我们干杯吧", "zh-CN", { cache: false, corrections: suggested });
  assert.deepEqual([w.word, w.suggested], ["干杯", true]);
});

test("the neutral table goes first: 不由得 is settled only with its neutral tone put in", () => {
  assert.equal(read("不由得"), "bù yóu de");
  zh.useNeutralWords(false);
  try {
    assert.equal(read("不由得"), "bù yóu dé");
    assert.deepEqual(marked("不由得"), ["不由得"], "a full tone the table doesn't have is no match");
  } finally {
    zh.useNeutralWords(true);
  }
  // A hint of the full tone is still not kept over the neutral one (hintToKeep, ld-azb).
  assert.equal(zh.hintToKeep("不由得", ["bù", "yóu", "dé"], [], "zh-CN"), null);
});

test("what stays marked: a sentence that may parse the word otherwise, a verb with 着, words read two ways", () => {
  for (const t of ["你得手洗衣服", "你得力挺他", "他管教数学", "他挨着打", "挨着", "倒车", "为人", "一晃"]) assert.notDeepEqual(marked(t), [], t);
});

test("the table: words no other table decides, one reading each, sorted, nothing but the word and its reading", () => {
  const common = new Set(COMMON_WORDS.split("|").map((e) => e.split("=")[0]));
  const standard = new Set(STANDARD_READINGS.map((s) => s.word));
  const all = [...rows(SETTLED_WORDS), ...rows(SETTLED_CN)];
  assert.ok(all.length > 100 && all.length < 200, `${all.length} words`);
  for (const [w, r] of all) {
    assert.ok(!common.has(w) && !standard.has(w) && !UNSETTLED_WORDS.includes(w), w);
    assert.equal(r.split(" ").length, [...w].length, w);
    assert.ok(!r.includes("/"), `${w}: one reading`);
    assert.ok(!/[着著还]$/.test(w) && !w.includes("还"), w);
  }
  for (const s of [SETTLED_WORDS, SETTLED_CN]) {
    const keys = s.split("|");
    assert.deepEqual(keys, [...keys].sort());
  }
});
