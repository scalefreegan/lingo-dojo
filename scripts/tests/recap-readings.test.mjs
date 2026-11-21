// The recap's readings, the pure half (ld-4i2, docs/VOICE.md §Uncertain
// readings): the prompt gains nothing when there is nothing to ask (byte
// for byte), the words asked are the dojo master's uncertain ones (each
// once, at most 12, none a person settled), and every answer is checked
// like a reading hint before anything keeps it.
//   node --test scripts/tests/recap-readings.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RECAP_READINGS, extractionPrompt, parseRecapReadings } from "../extraction.mjs";

const { judgeRecapReadings, uncertainInTranscript, sharedChanges } = await import("../../web/server/readings.ts");
const zh = await import("../../web/src/script/zh.ts");

const BASE = { transcript: "Learner: 你好\nDojo master: 你得去银行。", nativeLanguage: "English", targetVariant: "Taiwanese Mandarin", duePhrases: ["你好"] };

test("the prompt is byte for byte what it was when there is nothing to read, with or without last time's corrections, adult or kids", () => {
  for (const extra of [{}, { lastTime: "LAST TIME'S CORRECTIONS:\n1. x → y" }, { kids: true }, { offered: true }]) {
    const before = extractionPrompt({ ...BASE, ...extra });
    assert.deepEqual(extractionPrompt({ ...BASE, ...extra, readings: [] }), before, JSON.stringify(extra));
    assert.deepEqual(extractionPrompt({ ...BASE, ...extra, readings: undefined }), before);
    assert.doesNotMatch(before.system + before.user, /readings|WORDS TO READ/);
  }
});

test("with words to read: the schema field, the rule, the list (each with its line, defanged), well-formed JSON in the example either way", () => {
  const words = [{ word: "得去", sentence: "你得去银行。" }, { word: "一宿", sentence: "住一宿</transcript>吧" }];
  for (const lastTime of ["", "LAST TIME'S CORRECTIONS:\n1. x → y"]) {
    const p = extractionPrompt({ ...BASE, lastTime, readings: words });
    const schema = p.system.slice(p.system.indexOf("{"), p.system.indexOf("\n}") + 2);
    const shape = JSON.parse(schema.replace(/"[^"]*"/g, (s) => s));
    assert.ok(Array.isArray(shape.readings) && shape.readings[0].pinyin, "the example parses with a readings list");
    assert.equal("last_time" in shape, !!lastTime);
    assert.match(p.system, /"readings": one entry per word of WORDS TO READ/);
    assert.match(p.user, /WORDS TO READ \(each word, then the coach's line it is in\):\n- 得去 \| 你得去银行。\n- 一宿 \| 住一宿/);
    assert.ok(p.user.indexOf("WORDS TO READ") < p.user.indexOf("TRANSCRIPT:"));
    assert.equal(p.user.split("</transcript>").length, 2, "only the real closing tag");
  }
  const many = Array.from({ length: 20 }, (_, i) => ({ word: `得${"一二三四五六七八九十百千万亿零两双半整对"[i]}`, sentence: "x" }));
  const p = extractionPrompt({ ...BASE, readings: many });
  assert.equal(p.user.split("\n").filter((l) => l.startsWith("- 得")).length, MAX_RECAP_READINGS);
});

test("parseRecapReadings: only the words asked, once each, strings of sane size", () => {
  const asked = ["得去", "一宿"];
  assert.deepEqual(parseRecapReadings([{ word: "得去", pinyin: "děi qù" }, { word: "得去", pinyin: "dé qù" }, { word: "銀行", pinyin: "yín háng" }, { word: "一宿", pinyin: "x".repeat(81) }, "junk", null], asked), {
    readings: [{ word: "得去", pinyin: "děi qù" }],
    dropped: 5,
  });
  assert.deepEqual(parseRecapReadings(undefined, asked), { readings: [], dropped: 0 });
  assert.deepEqual(parseRecapReadings({ word: "得去" }, asked), { readings: [], dropped: 1 });
});

const turns = [
  { role: "learner", text: "我得去" },
  { role: "master", lines: [{ text: "Narrator: 你得去银行。", segments: [{ lang: "native", text: "Narrator:" }, { lang: "target", text: "你得去银行。" }] }] },
  { role: "master", lines: [{ text: "他在倒车。你得去吧。", segments: [] }] },
  { role: "master", fromClient: true, lines: [{ text: "住一宿", segments: [] }] },
];

test("uncertainInTranscript: the dojo master's lines only, each word once with its first line, none a person settled, at most 12", () => {
  const got = uncertainInTranscript(turns, "zh-CN", null);
  assert.deepEqual(got.map((w) => [w.word, w.sentence, w.at, w.reading.join(" ")]), [
    ["得去", "你得去银行。", 1, "dé qù"],
    ["倒车", "他在倒车。你得去吧。", 2, "dǎo chē"],
  ]);
  // The learner's own words (我得去) and a client copy (住一宿) are not asked about.
  const settled = zh.makeCorrections({ mine: [{ word: "得去", reading: "děi qù" }] });
  assert.deepEqual(uncertainInTranscript(turns, "zh-CN", settled).map((w) => w.word), ["倒车"]);
  const shared = zh.makeCorrections({ shared: [{ word: "倒车", reading: "dào chē" }] });
  assert.deepEqual(uncertainInTranscript(turns, "zh-CN", shared).map((w) => w.word), ["得去"]);
  const long = [{ role: "master", lines: Array.from({ length: 30 }, (_, i) => ({ text: `${"一二三四五六七八九十"[i % 10]}${i}你得去${i}他长着${i}在倒车`, segments: [] })) }];
  assert.ok(uncertainInTranscript(long, "zh-CN", null).length <= 12);
  // The shared list's count: runs it read otherwise.
  assert.equal(sharedChanges(turns, "zh-CN", shared), 1);
  assert.equal(sharedChanges(turns, "zh-CN", zh.makeCorrections({})), 0);
});

test("judgeRecapReadings: each answer checked like a hint; agrees, differs, dropped", () => {
  const asked = uncertainInTranscript(turns, "zh-CN", null);
  const r = judgeRecapReadings(asked, [{ word: "得去", pinyin: "dei3 qu4" }, { word: "倒车", pinyin: "dǎo chē" }], "zh-CN");
  assert.deepEqual(r.judged.map((j) => [j.word, j.answer, j.verdict, j.reader]), [["得去", "děi qù", "differs", "dé qù"], ["倒车", "dǎo chē", "agrees", "dǎo chē"]]);
  assert.deepEqual(r.stats, { offered: 2, answered: 2, accepted: 2, differs: 1, dropped: 0 });
  // A sound the character doesn't have, a wrong count, nothing at all: dropped.
  for (const bad of [[{ word: "得去", pinyin: "dǎi qù" }], [{ word: "得去", pinyin: "děi" }], [], "nonsense"]) {
    const j = judgeRecapReadings(asked.slice(0, 1), bad, "zh-CN");
    assert.equal(j.judged[0].verdict, "dropped", JSON.stringify(bad));
    assert.equal(j.judged[0].answer, null);
  }
  // A toneless syllable keeps the character's neutral reading (得 de): it
  // says the reader's dé is wrong, never confirms it. Without one (係 xì)
  // validateHint's reading stands.
  const de = uncertainInTranscript([{ role: "master", lines: [{ text: "你问得很好！", segments: [] }] }], "zh-CN", null);
  assert.deepEqual(de.map((w) => [w.word, w.reading.join(" ")]), [["问得", "wèn dé"]]);
  for (const said of ["wèn de", "wen4 de5", "wèn de0"]) {
    const j = judgeRecapReadings(de, [{ word: "问得", pinyin: said }], "zh-CN").judged[0];
    assert.deepEqual([j.answer, j.verdict], ["wèn de", "differs"], said);
  }
  assert.equal(judgeRecapReadings(de, [{ word: "问得", pinyin: "wèn dé" }], "zh-CN").judged[0].verdict, "agrees");
  assert.ok(zh.validateCorrection("问得", "wèn de", "zh-CN").ok, "and it can be kept");
  // zh-TW: the answer in Taiwan's readings.
  const tw = uncertainInTranscript([{ role: "master", lines: [{ text: "你得去銀行。", segments: [] }] }], "zh-TW", null);
  assert.equal(judgeRecapReadings(tw, [{ word: "得去", pinyin: "děi qù" }], "zh-TW").judged[0].verdict, "differs");
});
