// The pure rules of pronunciation stage 3 (ld-ne0.4,
// scripts/pronunciation-review.mjs): a session's tones from its stored
// checks, the comparison with the last attempt, the per-tone trend with its
// minimum, and Practice speak-it's tone miss.
//   node --test scripts/tests/pronunciation-review.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPARE_MIN, MAX_FLAGGED_SHOWN, MAX_TONE_MISS, TREND_DAYS, TREND_MIN_SYLLABLES, compareTones, practiceToneMiss, readToneHold, readTrendDays, sessionTones, storedToneMiss, toneTrend, trendWindow,
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
  assert.deepEqual(vs.flagged, { now: 2, was: 4 });
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
  const out = practiceToneMiss(exact, [flag("妈")]);
  assert.deepEqual(out.outcome, { verdict: "wrong", rating: 1, note: null });
  assert.deepEqual(out.toneMiss, { rating: 3, verdict: "exact", syllables: [{ char: "妈", place: 1, pinyin: "mā", expectedTone: 1, heardTone: 4 }] });
  const close = { verdict: "close", rating: 2, note: "Check the tone mark." };
  assert.deepEqual(practiceToneMiss(close, [flag("妈")]).outcome, { verdict: "wrong", rating: 1, note: "Check the tone mark." }, "the note stays");
  assert.equal(practiceToneMiss({ verdict: "accepted", rating: 3, note: null }, [flag("妈")]).toneMiss.verdict, "accepted");
  for (const o of [{ verdict: "wrong", rating: 1, note: null }, { verdict: "self", rating: 3, note: null }]) {
    assert.deepEqual(practiceToneMiss(o, [flag("妈")]), { outcome: o, toneMiss: null });
  }
  for (const flags of [null, [], undefined]) assert.deepEqual(practiceToneMiss(exact, flags), { outcome: exact, toneMiss: null });
  const lots = practiceToneMiss(exact, ["一", "二", "三", "四", "五"].map((c, i) => flag(c, i + 1)));
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
