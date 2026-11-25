// The pure rules of pronunciation stage 3 (ld-ne0.4,
// scripts/pronunciation-review.mjs): a session's tones from its stored
// checks, the comparison with the last attempt, the per-tone trend with its
// minimum, and Practice speak-it's tone miss.
//   node --test scripts/tests/pronunciation-review.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPARE_MIN, MAX_FLAGGED_SHOWN, leadingPlaces, settleFlags, settledPlaces, MAX_SESSION_TONE_MISSES, MAX_TONE_MISS, sessionToneMisses, storedFlags, TREND_DAYS, TREND_MIN_SYLLABLES, compareTones, practiceToneMiss, readToneHold, readTrendDays, sessionTones, storedToneMiss, toneTrend, trendWindow,
} from "../pronunciation-review.mjs";

const syl = (char, expectedTone, verdict, extra = {}) => ({ char, pinyin: `${char}?`, expectedTone, verdict, startMs: 100, endMs: 300, ...extra });
const row = (id, line, syllables, clip = false) => ({ id, line, syllables, clip });

test("sessionTones: counts all, by tone (neutral listed, never in a share), flagged with line, place and clip", () => {
  const t = sessionTones([
    row("a", "你好吗？", [syl("你", 2, "ok", { heardTone: 2 }), syl("好", 3, "off", { heardTone: 2, startMs: 400, endMs: 620 }), syl("吗", 0, "unsure", { reason: "neutral" })], true),
    row("b", "谢谢", [syl("谢", 4, "ok"), syl("谢", 0, "unsure")]),
    row("c", "", []),
  ]);
  assert.deepEqual([t.turns, t.checked, t.ok, t.off, t.unsure], [2, 5, 2, 1, 2]);
  assert.deepEqual(t.judged, { ok: 2, checked: 3 }, "tones 1–4 only");
  assert.deepEqual(
    t.byTone.map((b) => [b.tone, b.checked, b.ok, b.off, b.unsure]),
    [
      [2, 1, 1, 0, 0],
      [3, 1, 0, 1, 0],
      [4, 1, 1, 0, 0],
      [0, 2, 0, 0, 2],
    ],
    "tones 1–4 then neutral, only those present",
  );
  assert.deepEqual(t.flagged, [{ checkId: "a", line: "你好吗？", place: 2, char: "好", pinyin: "好?", expectedTone: 3, heardTone: 2, startMs: 400, endMs: 620 }]);
});

test("sessionTones: no clip kept is a null id; junk syllables are skipped; nothing usable is null", () => {
  const t = sessionTones([row("x", "妈", [syl("妈", 1, "off", { heardTone: 4 }), { verdict: "ok" }, null, syl("马", 9, "ok"), syl("吗", 1, "maybe")], false)]);
  assert.equal(t.checked, 1);
  assert.equal(t.flagged[0].checkId, null);
  assert.equal(sessionTones([]), null);
  assert.equal(sessionTones([row("y", "啊", [{ char: "啊" }])]), null);
  assert.equal(sessionTones(null), null);
});

test("sessionTones: at most MAX_FLAGGED_SHOWN flagged listed; all still counted", () => {
  const many = Array.from({ length: MAX_FLAGGED_SHOWN + 5 }, (_, i) => row(`r${i}`, "妈", [syl("妈", 1, "off", { heardTone: 4 })], true));
  const t = sessionTones(many);
  assert.equal(t.flagged.length, MAX_FLAGGED_SHOWN);
  assert.equal(t.off, MAX_FLAGGED_SHOWN + 5);
});

const tones = (spec) =>
  sessionTones([
    row(
      "r",
      "",
      Object.entries(spec).flatMap(([tone, [ok, n]]) => Array.from({ length: n }, (_, i) => syl("字", Number(tone), i < ok ? "ok" : "off", { heardTone: 1 }))),
    ),
  ]);

test("compareTones: overall and per tone, a move only past 10 points, tones both have enough of", () => {
  const now = tones({ 1: [3, 4], 3: [4, 4], 4: [1, 2] });
  const was = tones({ 1: [3, 4], 3: [1, 4], 4: [2, 2] });
  const vs = compareTones(now, was);
  assert.deepEqual(vs.overall, { now: { ok: 8, checked: 10 }, was: { ok: 6, checked: 10 }, move: "up" });
  assert.deepEqual(vs.tones, [
    { tone: 1, now: { ok: 3, checked: 4 }, was: { ok: 3, checked: 4 }, move: "same" },
    { tone: 3, now: { ok: 4, checked: 4 }, was: { ok: 1, checked: 4 }, move: "up" },
  ], "tone 4 has fewer than COMPARE_MIN either side");
  // A rate over tones 1–4, not a count: 2 of 10 now against 4 of 10.
  assert.deepEqual(vs.flagged, { now: { off: 2, checked: 10 }, was: { off: 4, checked: 10 }, move: "up" });
  // Fewer flags in a shorter session that is no better: not "up".
  const short = compareTones(tones({ 1: [3, 4] }), tones({ 1: [6, 8] }));
  assert.deepEqual(short.flagged, { now: { off: 1, checked: 4 }, was: { off: 2, checked: 8 }, move: "same" });
  assert.equal(compareTones(was, now).overall.move, "down");
  // Exactly ten points is a move; nine isn't.
  assert.equal(compareTones(tones({ 1: [6, 10] }), tones({ 1: [5, 10] })).overall.move, "up");
  assert.equal(compareTones(tones({ 1: [91, 100] }), tones({ 1: [82, 100] })).overall.move, "same");
});

test("compareTones: null without enough on either side or without a session", () => {
  assert.equal(COMPARE_MIN, 3);
  assert.equal(compareTones(tones({ 1: [2, 2] }), tones({ 1: [3, 3] })), null);
  assert.equal(compareTones(tones({ 1: [3, 3] }), null), null);
  assert.equal(compareTones(null, tones({ 1: [3, 3] })), null);
});

test("toneTrend: per learner day (UTC offset, 4 a.m. rollover), tones 1–4, share only from enough syllables", () => {
  const at = (iso, spec) => ({ createdAt: new Date(iso), syllables: Object.entries(spec).flatMap(([tone, [ok, n]]) => Array.from({ length: n }, (_, i) => syl("字", Number(tone), i < ok ? "ok" : "unsure"))) });
  const rows = [
    // Mountain time (UTC−7): 02:00 UTC on the 21st is 19:00 on the 20th.
    at("2026-11-21T02:00:00Z", { 1: [8, 10], 2: [1, 2], 0: [0, 5] }),
    // 10:00 UTC on the 21st is 03:00 there: before 4 a.m., still the 20th.
    at("2026-11-21T10:00:00Z", { 3: [5, 10] }),
    at("2026-11-22T18:00:00Z", { 1: [10, 12] }),
    { createdAt: "not a date", syllables: [syl("字", 1, "ok")] },
  ];
  const points = toneTrend(rows, { utcOffsetMinutes: -420 });
  assert.deepEqual(points.map((p) => p.day), ["2026-11-20", "2026-11-22"]);
  const [d20, d22] = points;
  assert.deepEqual(d20.tones, [
    { tone: 1, ok: 8, n: 10, share: 0.8 },
    { tone: 2, ok: 1, n: 2, share: null },
    { tone: 3, ok: 5, n: 10, share: 0.5 },
    { tone: 4, ok: 0, n: 0, share: null },
  ]);
  assert.deepEqual(d20.all, { ok: 14, n: 22, share: 14 / 22 }, "neutral never in it");
  assert.deepEqual(d22.tones[0], { tone: 1, ok: 10, n: 12, share: 10 / 12 });
  assert.equal(TREND_MIN_SYLLABLES, 10);
  assert.equal(toneTrend(rows, { utcOffsetMinutes: -420, min: 20 })[0].tones[0].share, null);
  // A day with only neutral syllables has no point.
  assert.deepEqual(toneTrend([at("2026-11-21T12:00:00Z", { 0: [0, 4] })]), []);
});

test("trendWindow and readTrendDays", () => {
  const w = trendWindow(new Date("2026-11-23T02:00:00Z"), 30, -420);
  // 19:00 on the 22nd there: today is the 22nd.
  assert.deepEqual([w.from, w.to], ["2026-10-24", "2026-11-22"]);
  assert.equal(w.since.toISOString(), "2026-10-24T11:00:00.000Z", "4 a.m. there");
  assert.equal(readTrendDays("90"), 90);
  for (const bad of [undefined, "", "6", "181", "1.5", "x", 30.5]) assert.equal(readTrendDays(bad), TREND_DAYS.default, String(bad));
});

const flag = (char, place = 1) => ({ char, place, pinyin: "mā", expectedTone: 1, heardTone: 4 });

test("practiceToneMiss: right words with a flag become a miss that remembers the grade; anything else unchanged", () => {
  const exact = { verdict: "exact", rating: 3, note: null };
  const said = { answer: "妈", text: "妈" };
  const out = practiceToneMiss(exact, [flag("妈")], said);
  assert.deepEqual(out.outcome, { verdict: "wrong", rating: 1, note: null });
  assert.deepEqual(out.toneMiss, { rating: 3, verdict: "exact", syllables: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }] });
  const close = { verdict: "close", rating: 2, note: "Check the tone mark." };
  assert.deepEqual(practiceToneMiss(close, [flag("妈")], said).outcome, { verdict: "wrong", rating: 1, note: "Check the tone mark." }, "the note stays");
  assert.equal(practiceToneMiss({ verdict: "accepted", rating: 3, note: null }, [flag("妈")], { answer: "妈！", text: "妈" }).toneMiss.verdict, "accepted", "punctuation aside, the same characters");
  for (const o of [{ verdict: "wrong", rating: 1, note: null }, { verdict: "self", rating: 3, note: null }]) {
    assert.deepEqual(practiceToneMiss(o, [flag("妈")], said), { outcome: o, toneMiss: null });
  }
  for (const flags of [null, [], undefined]) assert.deepEqual(practiceToneMiss(exact, flags, said), { outcome: exact, toneMiss: null });
  const lots = practiceToneMiss(exact, ["一", "二", "三", "四", "五"].map((c, i) => flag(c, i + 1)), { answer: "一二三四五", text: "一二三四五" });
  assert.equal(lots.toneMiss.syllables.length, MAX_TONE_MISS);
});

test("storedToneMiss reads back only a well-formed record", () => {
  const good = { rating: 3, verdict: "exact", syllables: [flag("妈")] };
  assert.deepEqual(storedToneMiss(good), good);
  for (const bad of [null, undefined, "x", { ...good, rating: 5 }, { ...good, verdict: "wrong" }, { ...good, syllables: "no" }]) assert.equal(storedToneMiss(bad), null, JSON.stringify(bad));
});

test("readToneHold: both ids or neither", () => {
  const a = "0b8a4b65-6f4b-4b65-9d3e-2c1f5e4a7b10";
  const b = "1C9A4B65-6F4B-4B65-9D3E-2C1F5E4A7B11";
  assert.deepEqual(readToneHold(null, null), { hold: null });
  assert.deepEqual(readToneHold(a, b), { hold: { phraseId: a, submitId: b.toLowerCase() } });
  for (const [p, s] of [[a, null], [null, b], ["x", b], [a, "1 or 1=1"]]) assert.match(readToneHold(p, s).error, /go together/);
});

test("practiceToneMiss: only when what was said is the phrase's own characters", () => {
  const exact = { verdict: "exact", rating: 3, note: null };
  const f = [{ char: "忙", place: 2, pinyin: "máng", expectedTone: 2, heardTone: 4 }];
  // A saved alternate graded exact (帮助 for 帮忙), a synonym the grader
  // accepted, nothing said, no text: unchanged.
  for (const said of [{ answer: "帮助", text: "帮忙" }, { answer: "请帮我", text: "帮忙" }, { answer: "", text: "帮忙" }, { answer: "help", text: "" }, {}]) {
    assert.deepEqual(practiceToneMiss(exact, f, said), { outcome: exact, toneMiss: null }, JSON.stringify(said));
  }
  assert.equal(practiceToneMiss(exact, f, { answer: "帮忙。", text: "帮忙" }).outcome.rating, 1);
});

const READINGS = { 空: ["kōng", "kòng", "kǒng"], 长: ["cháng", "zhǎng"], 妈: ["mā"], 么: ["me", "mó"], 只: ["zhī", "zhǐ"], 他: ["tā"], 买: ["mǎi"], 听: ["tīng"], 尝: ["cháng"], 本: ["běn"], 事: ["shì"], 东: ["dōng"], 西: ["xī"] };
const readingsOf = (c) => READINGS[c] ?? [];
const flagAt = (char, place, pinyin, heardTone = 4) => ({ char, place, pinyin, expectedTone: { ā: 1, ī: 1, ō: 1, ē: 1, ū: 1, á: 2, í: 2, ó: 2, é: 2, ú: 2, ǎ: 3, ǐ: 3, ǒ: 3, ě: 3, ǔ: 3, à: 4, ì: 4, ò: 4, è: 4, ù: 4 }[[...pinyin].find((c) => "āīōēūáíóéúǎǐǒěǔàìòèù".includes(c))] ?? 0, heardTone });

test("leadingPlaces: the first Han character and one directly after punctuation, nothing else", () => {
  assert.deepEqual([...leadingPlaces("妈")], [1]);
  assert.deepEqual([...leadingPlaces("听听")], [1]);
  assert.deepEqual([...leadingPlaces("他只买，本事。东西")], [1, 4, 6]);
  // Only sentence punctuation starts a place: not brackets, quotes, …, / or 、.
  assert.deepEqual([...leadingPlaces("「空」 长")], [1]);
  assert.deepEqual([...leadingPlaces("妈! 他? 你; 好: 我. 八, 九")], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...leadingPlaces("ok 妈")], [1]);
  assert.deepEqual([...leadingPlaces("")], []);
});

test("settleFlags A: only a leading place fails, settled or not (听听, 尝尝, 本事, 他只买)", () => {
  for (const [text, f] of [["听听", flagAt("听", 2, "tīng")], ["尝尝", flagAt("尝", 2, "cháng")], ["本事", flagAt("事", 2, "shì", 1)], ["他只买", flagAt("只", 2, "zhī", 2)], ["东西", flagAt("西", 2, "xī")]]) {
    assert.deepEqual(settleFlags([f], { readingsOf, text, settled: new Set([f.place]) }), [], text);
  }
  // The one case that still fails: a leading character with one reading tone.
  const ma = flagAt("妈", 1, "mā");
  assert.deepEqual(settleFlags([ma], { readingsOf, text: "妈" }), [ma]);
  const ta = flagAt("他", 1, "tā");
  assert.deepEqual(settleFlags([ta], { readingsOf, text: "他只买" }), [ta]);
});

test("settleFlags B: a character with more than one reading tone, neutral included, fails nothing unless settled (只买, 空, 么)", () => {
  // 只买 is scored zhī; zhǐ before a third tone is said zhí: heard 2, no listed reading's tone.
  const zhi = flagAt("只", 1, "zhī", 2);
  assert.deepEqual(settleFlags([zhi], { readingsOf, text: "只买" }), []);
  const kong = flagAt("空", 1, "kōng", 3);
  assert.deepEqual(settleFlags([kong], { readingsOf, text: "空" }), []);
  const mo = flagAt("么", 1, "mó", 1);
  assert.deepEqual(settleFlags([mo], { readingsOf, text: "么" }), []);
  // Settled: it stands.
  assert.deepEqual(settleFlags([zhi], { readingsOf, text: "只买", settled: new Set([1]) }), [zhi]);
  assert.deepEqual(settleFlags([kong], { readingsOf, text: "空", settled: new Set([1]) }), [kong]);
});

test("settleFlags: never a tone set by sandhi or context, nor a third tone before a third (一路, 请倒茶, 我种花, 嫂嫂)", () => {
  const ro = (c) => ({ 一: ["yī"], 请: ["qǐng"], 我: ["wǒ"], 嫂: ["sǎo"], 妈: ["mā"], 他: ["tā"] })[c] ?? [];
  const f = (char, pinyin, expectedTone) => ({ char, place: 1, pinyin, expectedTone, heardTone: 1 });
  for (const [text, flag] of [["一路公交车", f("一", "yī", 2)], ["请倒茶", f("请", "qǐng", 2)], ["我种花", f("我", "wǒ", 2)], ["嫂嫂", f("嫂", "sǎo", 2)]]) {
    assert.deepEqual(settleFlags([flag], { readingsOf: ro, text, settled: new Set([1]) }), [], text);
  }
  // Expected its own third tone, the next syllable read third (a hint or
  // the reader may be wrong about either): dropped, settled or not.
  const wo = f("我", "wǒ", 3);
  assert.deepEqual(settleFlags([wo], { readingsOf: ro, text: "我好", readings: [null, "wǒ", "hǎo"], settled: new Set([1]) }), []);
  // Before another tone it stands.
  assert.deepEqual(settleFlags([wo], { readingsOf: ro, text: "我来", readings: [null, "wǒ", "lái"] }), [wo]);
  // The positive cases still fail.
  for (const [text, flag] of [["妈", f("妈", "mā", 1)], ["他", f("他", "tā", 1)]]) assert.deepEqual(settleFlags([flag], { readingsOf: ro, text }), [flag]);
});

test("settleFlags: in a zh-TW language only a settled reading fails (播放, 夕陽)", () => {
  const ro = (c) => ({ 播: ["bō"], 夕: ["xī"] })[c] ?? [];
  const bo = { char: "播", place: 1, pinyin: "bō", expectedTone: 1, heardTone: 4 };
  const xi = { char: "夕", place: 1, pinyin: "xī", expectedTone: 1, heardTone: 4 };
  assert.deepEqual(settleFlags([bo], { readingsOf: ro, text: "播放", tw: true }), []);
  assert.deepEqual(settleFlags([xi], { readingsOf: ro, text: "夕陽", tw: true }), []);
  assert.deepEqual(settleFlags([bo], { readingsOf: ro, text: "播放", tw: true, settled: new Set([1]) }), [bo]);
  assert.deepEqual(settleFlags([bo], { readingsOf: ro, text: "播放" }), [bo], "zh-CN: one reading tone fails");
});

test("settleFlags: brackets, 、 and … don't start a place, and 一 / 不 never fail (快（一）点儿, 一、两个, （听）听, 出（来）, 一…就…)", () => {
  const ro = (c) => ({ 一: ["yī"], 不: ["bù"], 听: ["tīng"], 来: ["lái"], 就: ["jiù"], 妈: ["mā"], 两: ["liǎng"], 快: ["kuài"] })[c] ?? [];
  const f = (char, place, pinyin, expectedTone) => ({ char, place, pinyin, expectedTone, heardTone: 3 });
  for (const [text, flag] of [
    ["快（一）点儿", f("一", 2, "yī", 1)],
    ["一、两个", f("两", 2, "liǎng", 3)],
    ["（听）听", f("听", 2, "tīng", 1)],
    ["出（来）", f("来", 2, "lái", 2)],
    ["一…就…", f("就", 2, "jiù", 4)],
  ]) assert.deepEqual(settleFlags([flag], { readingsOf: ro, text, settled: new Set([flag.place]) }), [], text);
  // 一 and 不 first, settled or not.
  for (const flag of [f("一", 1, "yī", 1), f("不", 1, "bù", 4)]) assert.deepEqual(settleFlags([flag], { readingsOf: ro, text: flag.char + "好", settled: new Set([1]) }), [], flag.char);
  // 妈 after ， still can.
  const ma = f("妈", 2, "mā", 1);
  assert.deepEqual(settleFlags([ma], { readingsOf: ro, text: "好，妈" }), [ma]);
});

test("settledPlaces: an entry in the text giving that place the syllable it was scored as", () => {
  const scored = new Map([[2, "kōng"], [4, "cháng"]]);
  const text = "有空，很长";
  // The learner's 有空 yǒu kōng settles place 2; 很长 read hěn zhǎng doesn't
  // settle 长 scored cháng (the score was against a reading they were told
  // is wrong).
  const entries = [{ word: "有空", key: "有空", reading: "yǒu kōng" }, { word: "很长", key: "很长", reading: "hěn zhǎng" }];
  assert.deepEqual([...settledPlaces(text, entries, scored)], [2]);
  // A traditional spelling matched by its key; a malformed entry ignored.
  assert.deepEqual([...settledPlaces("時間長", [{ word: "時間長", key: "时间长", reading: "shí jiān cháng" }, { word: "时", key: "时", reading: "" }], new Map([[3, "cháng"]]))], [3]);
  assert.deepEqual([...settledPlaces(text, [], scored)], []);
});

/* ------------------------- a session's tone misses (ld-ne0.18) ------------------------- */

const toneFlag = (place, char = "妈", pinyin = "mā") => ({ char, place, pinyin, expectedTone: 1, heardTone: 4 });
const bankOf = (...texts) => texts.map((text) => ({ norm: text, text }));
const missed = (lines, phrases, opts) => sessionToneMisses(lines, phrases, opts).map((m) => [m.text, m.syllables.map((s) => s.place)]);

test("storedFlags: places from the stored row, only when the line is what was scored", () => {
  const syl = (char, verdict) => ({ char, pinyin: "mā", expectedTone: 1, verdict, ...(verdict === "off" ? { heardTone: 4 } : {}), startMs: 0, endMs: 1 });
  const row = { line: "妈，妈！", syllables: [syl("妈", "off"), syl("妈", "ok")] };
  assert.deepEqual(storedFlags(row), { line: "妈，妈！", flags: [toneFlag(1)], ok: [2] });
  assert.equal(storedFlags({ ...row, line: "妈" }), null, "another text");
  assert.equal(storedFlags({ ...row, line: "妈他" }), null, "another character");
  assert.equal(storedFlags({ line: "妈", syllables: [{ char: "妈", verdict: "off" }] }), null, "an unusable row");
  assert.equal(storedFlags({ line: "", syllables: [] }), null);
});

test("sessionToneMisses: the phrase the flag starts, the longest, as words of its own", () => {
  const line = (text, places) => [{ line: text, flags: places.map((p) => toneFlag(p)), ok: [] }];
  assert.deepEqual(missed(line("妈", [1]), bankOf("妈")), [["妈", [1]]]);
  // The longest phrase that starts there, and only it.
  assert.deepEqual(missed(line("妈妈很忙", [1]), bankOf("妈妈", "妈妈很忙", "妈")), [["妈妈很忙", [1]]]);
  assert.deepEqual(missed(line("妈妈很忙", [1]), bankOf("妈妈")), [["妈妈", [1]]], "ends where a word ends");
  // One the recap kept only where no older one fits.
  assert.deepEqual(missed(line("妈妈很忙", [1]), [...bankOf("妈妈"), { norm: "妈妈很忙", text: "妈妈很忙", late: true }]), [["妈妈", [1]]]);
  assert.deepEqual(missed(line("妈妈很忙", [1]), [{ norm: "妈妈很忙", text: "妈妈很忙", late: true }]), [["妈妈很忙", [1]]]);
  // Inside a word, or one character of a longer clause: not that phrase.
  assert.deepEqual(missed(line("他们来了", [1]), bankOf("他")), []);
  assert.deepEqual(missed(line("妈很忙", [1]), bankOf("妈")), []);
  assert.deepEqual(missed(line("妈，我来了", [1]), bankOf("妈")), [["妈", [1]]], "the whole clause");
  // Not at the start of the line or a clause: never (听听 and the like).
  assert.deepEqual(missed(line("我妈妈", [2]), bankOf("妈妈")), []);
  assert.deepEqual(missed(line("我来了，妈妈", [4]), bankOf("妈妈")), [["妈妈", [1]]]);
  // A flag past the phrase's leading places, or past the phrase: not its.
  assert.deepEqual(missed(line("妈妈", [2]), bankOf("妈妈")), []);
  assert.deepEqual(missed(line("妈妈，他来", [3]), bankOf("妈妈")), []);
  // A phrase of two clauses holds both places, but a sentence mark it
  // hasn't got stops it.
  assert.deepEqual(missed(line("妈妈，他来", [3]), bankOf("妈妈，他来")), [["妈妈，他来", [3]]]);
  assert.deepEqual(missed(line("好。吃", [1]), bankOf("好吃")), []);
  // Not Mandarin alone, no norm, no flag: nothing.
  assert.deepEqual(missed(line("妈", [1]), [{ norm: "妈 ok", text: "妈 ok" }, { norm: null, text: "妈" }]), []);
  assert.deepEqual(missed(line("妈", []), bankOf("妈")), []);
  assert.deepEqual(sessionToneMisses(undefined, undefined), []);
});

test("sessionToneMisses: what was said last decides; not sure changes nothing; at most one miss a phrase, and a cap", () => {
  const off = { line: "妈", flags: [toneFlag(1)], ok: [] };
  const ok = { line: "妈！", flags: [], ok: [1] };
  const unsure = { line: "妈", flags: [], ok: [] };
  assert.deepEqual(missed([off, ok], bankOf("妈")), [], "fixed after being coached");
  assert.deepEqual(missed([ok, off], bankOf("妈")), [["妈", [1]]]);
  assert.deepEqual(missed([off, unsure], bankOf("妈")), [["妈", [1]]]);
  assert.deepEqual(missed([off, off, off], bankOf("妈")), [["妈", [1]]], "one review, however often");
  assert.deepEqual(missed([{ line: "妈，妈", flags: [toneFlag(1)], ok: [2] }], bankOf("妈")), [], "within one line too");
  assert.deepEqual(missed([{ line: "妈，妈", flags: [toneFlag(2)], ok: [1] }], bankOf("妈")), [["妈", [1]]]);
  // Another phrase that starts with the same character clears nothing.
  assert.deepEqual(missed([off, { line: "妈妈", flags: [], ok: [1, 2] }], bankOf("妈", "妈妈")), [["妈", [1]]]);
  const many = [..."天地玄黄宇宙洪荒日月盈昃"].map((c) => ({ line: c, flags: [toneFlag(1, c)], ok: [] }));
  assert.equal(sessionToneMisses(many, bankOf(...many.map((l) => l.line))).length, MAX_SESSION_TONE_MISSES);
});
