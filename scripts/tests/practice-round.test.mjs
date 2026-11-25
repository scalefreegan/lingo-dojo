// A practice round kept for a reload (web/src/practiceRound.ts).
//   node --test scripts/tests/practice-round.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUND_MAX_AGE_MS, parseRound } from "../../web/src/practiceRound.ts";

const NOW = 1_800_000_000_000;
const item = (n) => ({ phraseId: `p${n}`, skill: "recognize", drill: "flashcard", version: 1, revision: 1 });
const done = { key: "p1:recognize", text: "hola", meaning: "hello", lang: "es-MX", rating: 3 };
const round = (extra = {}) => JSON.stringify({ at: NOW - 1000, items: [item(1), item(2)], index: 1, done: [done], ...extra });

test("a round goes on from its card, up to its summary", () => {
  assert.deepEqual(parseRound(round(), NOW), { items: [item(1), item(2)], index: 1, done: [done] });
  assert.equal(parseRound(round({ index: 2 }), NOW).index, 2);
});

test("an old round, and anything that isn't one, is nothing", () => {
  assert.equal(parseRound(round({ at: NOW - ROUND_MAX_AGE_MS }), NOW), null);
  for (const bad of [null, "", "{", "[]", "null", round({ at: "x" }), round({ items: [] }), round({ items: [{ phraseId: 1 }] }), round({ items: [{ ...item(1), drill: "dice" }] }), round({ index: 3 }), round({ index: -1 }), round({ index: 0.5 }), round({ done: [{}] }), round({ done: null })]) {
    assert.equal(parseRound(bad, NOW), null, String(bad).slice(0, 60));
  }
});
