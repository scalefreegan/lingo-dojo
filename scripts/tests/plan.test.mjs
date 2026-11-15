// The session's time budget (scripts/plan.mjs): reading `overrides.minutes`
// and splitting the minutes across the session's parts.
//   node --test scripts/tests/plan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MINUTES, MINUTE_CHOICES, budgetSplit, formatMinutes, plannedRow, readMinutes } from "../plan.mjs";

const adultPlan = [
  { id: "intro", title: "Introduction", kind: "intro" },
  { id: "warmup:a", title: "Phrases", kind: "warmup" },
  { id: "warmup:b", title: "Greetings", kind: "warmup" },
  { id: "scene", title: "The market", kind: "scene" },
  ...[1, 2, 3, 4].map((i) => ({ id: `beat:${i}`, title: `Beat ${i}`, kind: "beat" })),
  { id: "debrief:top", title: "Top three", kind: "debrief" },
];
const sum = (rows) => rows.reduce((s, r) => s + r.minutes, 0);

test("readMinutes: absent is no limit; a number in range is the budget; anything else is invalid", () => {
  assert.deepEqual(readMinutes(undefined), { minutes: null, invalid: false });
  assert.deepEqual(readMinutes(null), { minutes: null, invalid: false });
  assert.deepEqual(readMinutes("  "), { minutes: null, invalid: false });
  assert.deepEqual(readMinutes(10), { minutes: 10, invalid: false });
  assert.deepEqual(readMinutes(7.5), { minutes: 7.5, invalid: false });
  assert.deepEqual(readMinutes(MAX_MINUTES), { minutes: MAX_MINUTES, invalid: false });
  for (const bad of ["10", 0, -5, MAX_MINUTES + 1, Number.NaN, Infinity, true, [10], { m: 10 }]) {
    assert.deepEqual(readMinutes(bad), { minutes: null, invalid: true }, JSON.stringify(bad));
  }
});

test("the picker's choices are in range", () => {
  assert.deepEqual(MINUTE_CHOICES, { adult: [5, 10, 15, 20, 30], kids: [3, 5, 10] });
  for (const m of [...MINUTE_CHOICES.adult, ...MINUTE_CHOICES.kids]) assert.equal(readMinutes(m).minutes, m);
});

test("budgetSplit: one row per part, beats folded into the scene, always adding up to the budget", () => {
  for (const total of [3, 5, 7.5, 10, 15, 20, 30, 240]) {
    const rows = budgetSplit(adultPlan, total);
    assert.deepEqual(rows.map((r) => r.id), ["intro", "warmup:a", "warmup:b", "scene", "debrief:top"]);
    assert.equal(sum(rows), total, `total ${total}`);
    for (const r of rows) assert.equal(r.minutes * 2, Math.round(r.minutes * 2), "half minutes");
  }
  const ten = budgetSplit(adultPlan, 10);
  assert.deepEqual(ten.map((r) => r.minutes), [1, 1, 1, 5.5, 1.5]);
  assert.equal(ten[3].beats, 4);
  assert.equal(ten[3].play, 3, "about two minutes a beat");
});

test("budgetSplit: a 5-minute session plays one or two beats; a long one plays them all", () => {
  const five = budgetSplit(adultPlan, 5).find((r) => r.kind === "scene");
  assert.ok(five.play >= 1 && five.play <= 2, `played ${five.play}`);
  assert.equal(budgetSplit(adultPlan, 30).find((r) => r.kind === "scene").play, 4);
});

test("budgetSplit: a short budget leaves a warm-up at 0 (skip it) rather than overrunning", () => {
  const rows = budgetSplit(adultPlan, 3);
  assert.equal(sum(rows), 3);
  assert.ok(rows.some((r) => r.minutes === 0));
});

test("budgetSplit: a group the session doesn't have gives its share to the scene", () => {
  const rows = budgetSplit([{ id: "scene", title: "S", kind: "scene" }], 10);
  assert.deepEqual(rows.map((r) => [r.id, r.minutes, r.play]), [["scene", 10, 0]]);
  const noWarmup = budgetSplit(adultPlan.filter((p) => p.kind !== "warmup"), 10);
  assert.equal(noWarmup.find((r) => r.kind === "scene").minutes, 7.5);
  assert.deepEqual(budgetSplit([], 10), []);
});

test("budgetSplit: kids games played during the story are the story's time; the opener and ending are parts", () => {
  const kids = [
    { id: "intro", title: "Introduction", kind: "intro" },
    { id: "games:echo", title: "Echo", kind: "games" },
    { id: "scene", title: "Farm", kind: "scene" },
    { id: "games:spy", title: "I spy", kind: "games" },
    { id: "beat:1", title: "Cows", kind: "beat" },
    { id: "ending:bye", title: "Goodnight", kind: "ending" },
  ];
  const rows = budgetSplit(kids, 5);
  assert.deepEqual(rows.map((r) => [r.id, r.group]), [["intro", "intro"], ["games:echo", "before"], ["scene", "scene"], ["ending:bye", "after"]]);
  assert.deepEqual(rows[2].games, ["I spy"]);
  assert.equal(sum(rows), 5);
});

test("budgetSplit is deterministic", () => {
  assert.deepEqual(budgetSplit(adultPlan, 15), budgetSplit(adultPlan, 15));
});

test("plannedRow: where the plan would be after so many minutes", () => {
  const rows = budgetSplit(adultPlan, 10); // 1, 1, 1, 5.5, 1.5
  assert.equal(plannedRow(rows, 0).id, "intro");
  assert.equal(plannedRow(rows, 1.2).id, "warmup:a");
  assert.equal(plannedRow(rows, 4).id, "scene");
  assert.equal(plannedRow(rows, 9).id, "debrief:top");
  assert.equal(plannedRow(rows, 50).id, "debrief:top");
  assert.equal(plannedRow([], 1), null);
});

test("formatMinutes: halves as ½", () => {
  assert.deepEqual([0, 0.5, 1, 1.5, 12].map(formatMinutes), ["0", "½", "1", "1½", "12"]);
});
