// scripts/fsrs.mjs: card state, scheduling, rating maps, mastery bands.
//   node --test scripts/tests/fsrs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILLS, newCard, review, isDue, toRow, fromRow, ratingForVerdict, ratingForSessionEvent,
  masteryBand, phraseMastery, SESSION_EVENT_KINDS,
} from "../fsrs.mjs";

const T0 = new Date("2026-03-01T09:00:00Z");
const DAY = 86_400_000;
const days = (n) => new Date(T0.getTime() + n * DAY);

/** A card graduated to review with a long interval: a few Good reviews, each at its due time. */
function matureCard(goods = 6) {
  let c = newCard(T0);
  let t = T0;
  for (let i = 0; i < goods; i++) {
    c = review(c, 3, t).card;
    t = new Date(c.due);
  }
  return { card: c, at: t };
}

test("SKILLS are the three cards of a phrase", () => {
  assert.deepEqual(SKILLS, ["recognize", "listen", "produce"]);
});

test("newCard: exactly the ts-fsrs Card fields, JSON-safe, due now", () => {
  const c = newCard(T0);
  assert.deepEqual(Object.keys(c).sort(), [
    "difficulty", "due", "lapses", "last_review", "learning_steps", "reps", "scheduled_days", "stability", "state",
  ]);
  assert.equal(c.due, T0.toISOString());
  assert.equal(c.last_review, null);
  assert.equal(c.reps, 0);
  assert.equal(c.state, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  assert.ok(isDue(c, T0));
});

test("review: returns a new card and a log, without mutating the input", () => {
  const c = newCard(T0);
  const snapshot = structuredClone(c);
  const { card, log } = review(c, 3, T0);
  assert.deepEqual(c, snapshot);
  assert.equal(card.reps, 1);
  assert.equal(card.last_review, T0.toISOString());
  assert.equal(log.rating, 3);
  assert.equal(log.review, T0.toISOString());
  assert.deepEqual(JSON.parse(JSON.stringify({ card, log })), { card, log });
});

test("review: rejects ratings outside 1-4", () => {
  for (const bad of [0, 5, 2.5, "3", null, undefined]) {
    assert.throws(() => review(newCard(T0), bad, T0), RangeError);
  }
});

test("review is deterministic: same card, rating and time give the same result", () => {
  const a = review(newCard(T0), 3, T0);
  const b = review(newCard(T0), 3, T0);
  assert.deepEqual(a, b);
});

test("scheduling sanity: Good is due later than Hard, Easy later than Good (new card)", () => {
  const due = (r) => new Date(review(newCard(T0), r, T0).card.due).getTime();
  assert.ok(due(3) > due(2), "good after hard");
  assert.ok(due(4) > due(3), "easy after good");
  assert.ok(due(2) >= due(1), "hard not before again");
});

test("scheduling sanity: Good is later than Hard on a review-state card too", () => {
  const { card, at } = matureCard(4);
  const due = (r) => new Date(review(card, r, at).card.due).getTime();
  assert.ok(due(3) > due(2));
  assert.ok(due(4) > due(3));
});

test("Again after a long stability shortens it and counts a lapse", () => {
  const { card, at } = matureCard(7);
  assert.ok(card.stability > 10, `stability grew (${card.stability})`);
  const lapsed = review(card, 1, at).card;
  assert.ok(lapsed.stability < card.stability / 2, `${lapsed.stability} vs ${card.stability}`);
  assert.equal(lapsed.lapses, card.lapses + 1);
  assert.ok(new Date(lapsed.due).getTime() < at.getTime() + DAY, "relearning is due within a day");
});

test("out-of-schedule reviews work: early and very late", () => {
  const { card, at } = matureCard(4);
  const due = new Date(card.due);
  // An hour before due, and a year after.
  const early = review(card, 3, new Date(due.getTime() - 3_600_000));
  const late = review(card, 3, new Date(due.getTime() + 365 * DAY));
  for (const r of [early, late]) {
    assert.equal(r.card.reps, card.reps + 1);
    assert.ok(new Date(r.card.due).getTime() > new Date(r.card.last_review).getTime());
  }
  // Remembering after a long gap is stronger evidence than a prompt repeat.
  assert.ok(late.card.stability > early.card.stability);
  assert.ok(isDue(card, at));
  assert.ok(!isDue(card, new Date(due.getTime() - 1)));
});

test("isDue: boundary is inclusive", () => {
  const c = review(newCard(T0), 3, T0).card;
  assert.ok(isDue(c, new Date(c.due)));
  assert.ok(!isDue(c, new Date(new Date(c.due).getTime() - 1)));
});

test("toRow / fromRow: round trip, including pg-style Date columns and extra columns", () => {
  const c = review(newCard(T0), 3, T0).card;
  const row = toRow(c);
  assert.ok(row.due instanceof Date);
  assert.ok(row.last_review instanceof Date);
  assert.deepEqual(fromRow({ ...row, id: "x", phrase_id: "y", skill: "produce" }), c);
  assert.deepEqual(fromRow(JSON.parse(JSON.stringify(row))), c);
  // A never-reviewed card keeps last_review null both ways.
  const n = newCard(T0);
  assert.equal(toRow(n).last_review, null);
  assert.deepEqual(fromRow(toRow(n)), n);
  // numeric columns come back from pg as strings sometimes
  assert.equal(fromRow({ ...row, stability: String(row.stability) }).stability, c.stability);
  // a round-tripped card reviews the same as the original
  assert.deepEqual(review(fromRow(toRow(c)), 3, days(5)), review(c, 3, days(5)));
});

test("ratingForVerdict: the Grading table", () => {
  assert.equal(ratingForVerdict("exact"), 3);
  assert.equal(ratingForVerdict("close"), 2);
  assert.equal(ratingForVerdict("accepted"), 3);
  assert.equal(ratingForVerdict("accepted", "good"), 3);
  assert.equal(ratingForVerdict("accepted", "hard"), 2);
  assert.equal(ratingForVerdict("accepted", "HARD"), 2);
  assert.equal(ratingForVerdict("wrong"), 1);
  assert.equal(ratingForVerdict("miss"), 1);
  assert.equal(ratingForVerdict("self"), null);
  assert.equal(ratingForVerdict("banana"), null);
});

test("ratingForSessionEvent: the event table, and null for unknown kinds", () => {
  assert.deepEqual(ratingForSessionEvent("produced"), { skill: "produce", rating: 3 });
  assert.deepEqual(ratingForSessionEvent("produced_with_help"), { skill: "produce", rating: 2 });
  assert.deepEqual(ratingForSessionEvent("corrected"), { skill: "produce", rating: 1 });
  assert.deepEqual(ratingForSessionEvent("understood"), { skill: "listen", rating: 3 });
  assert.deepEqual(ratingForSessionEvent("confused"), { skill: "listen", rating: 1 });
  for (const k of ["nope", "", undefined, null, "toString", "__proto__", "constructor"]) {
    assert.equal(ratingForSessionEvent(k), null, String(k));
  }
  assert.equal(SESSION_EVENT_KINDS.length, 5);
  // the returned object is a copy: a caller cannot corrupt the table
  ratingForSessionEvent("produced").rating = 1;
  assert.equal(ratingForSessionEvent("produced").rating, 3);
});

test("masteryBand: New, then the 3-day and 21-day boundaries", () => {
  assert.equal(masteryBand(newCard(T0)), "New");
  const reviewed = review(newCard(T0), 3, T0).card;
  const at = (stability) => ({ ...reviewed, stability });
  assert.equal(masteryBand(at(0.5)), "Learning");
  assert.equal(masteryBand(at(2.999)), "Learning");
  assert.equal(masteryBand(at(3)), "Familiar");
  assert.equal(masteryBand(at(20.999)), "Familiar");
  assert.equal(masteryBand(at(21)), "Mastered");
  assert.equal(masteryBand(at(400)), "Mastered");
});

test("masteryBand: a first Again review is Learning, not New", () => {
  assert.equal(masteryBand(review(newCard(T0), 1, T0).card), "Learning");
});

test("masteryBand follows real scheduling: repeated Good climbs out of Learning", () => {
  const { card } = matureCard(6);
  assert.notEqual(masteryBand(card), "New");
  assert.notEqual(masteryBand(card), "Learning");
});

test("phraseMastery: weakest existing card wins; none is New", () => {
  const reviewed = review(newCard(T0), 3, T0).card;
  const mastered = { ...reviewed, stability: 40 };
  const familiar = { ...reviewed, stability: 10 };
  const learning = { ...reviewed, stability: 1 };
  assert.equal(phraseMastery([]), "New");
  assert.equal(phraseMastery(undefined), "New");
  assert.equal(phraseMastery([mastered]), "Mastered");
  assert.equal(phraseMastery([mastered, familiar]), "Familiar");
  assert.equal(phraseMastery([mastered, familiar, learning]), "Learning");
  assert.equal(phraseMastery([mastered, newCard(T0)]), "New");
});
