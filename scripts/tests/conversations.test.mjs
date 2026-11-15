// The pure half of saved conversations (scripts/conversations.mjs): how a
// turn's write makes the stored turns match the screen, titles and paging.
//   node --test scripts/tests/conversations.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_ID_RE, conversationTitle, itemFromRow, planTurnWrite, readPage, rowFromItem, turnKey,
} from "../conversations.mjs";

const line = (text, extra = {}) => ({ speaker: "narrator", gender: "female", text, segments: [{ lang: "target", text }], ...extra });
const M = (text, extra = {}) => ({ role: "master", lines: [line(text)], ...extra });
const L = (text) => ({ role: "learner", text });
/** Stored rows as the database returns them (idx order, columns). */
const rows = (...items) => items.map((it, idx) => ({ ...rowFromItem(it), idx }));
const reply = (text) => ({ ...M(text, { glosses: [{ term: text, meaning: "x" }], stage: "scene" }), durationMs: 1200, costUsd: 0.01 });

test("planTurnWrite: the opening turn stores the reply alone at idx 0", () => {
  const { keep, insert } = planTurnWrite({ stored: [], screen: [], message: "", master: reply("Hola") });
  assert.equal(keep, 0);
  assert.equal(insert.length, 1);
  assert.equal(insert[0].idx, 0);
  assert.equal(insert[0].role, "master");
  assert.deepEqual(insert[0].glosses, [{ term: "Hola", meaning: "x" }]);
  assert.equal(insert[0].stage, "scene");
  assert.equal(insert[0].durationMs, 1200);
  assert.equal(insert[0].costUsd, 0.01);
});

test("planTurnWrite: a normal turn keeps everything and appends the learner's words and the reply", () => {
  const stored = rows(M("Hola"), L("hola"), M("¿Qué quieres?"));
  const screen = [M("Hola"), L("hola"), M("¿Qué quieres?")];
  const { keep, insert } = planTurnWrite({ stored, screen, message: "tacos", master: reply("Claro") });
  assert.equal(keep, 3);
  assert.deepEqual(insert.map((r) => [r.idx, r.role, r.text]), [[3, "learner", "tacos"], [4, "master", null]]);
  assert.equal(insert[0].durationMs, undefined, "only the reply carries timing");
});

test("planTurnWrite: a turn that failed or was stopped leaves its message on screen, and the next turn stores it without a reply", () => {
  // Screen: the opening, "hola" (its turn failed), then "hola" again now.
  const stored = rows(M("Hola"));
  const screen = [M("Hola"), L("hola")];
  const { keep, insert } = planTurnWrite({ stored, screen, message: "hola", master: reply("¡Hola!") });
  assert.equal(keep, 1);
  assert.deepEqual(insert.map((r) => [r.idx, r.role, r.text]), [[1, "learner", "hola"], [2, "learner", "hola"], [3, "master", null]]);
});

test("planTurnWrite: a reply stored but never shown (Stop raced it) is replaced, so the store matches the screen", () => {
  const stored = rows(M("Hola"), L("tacos"), M("dropped reply"));
  const screen = [M("Hola"), L("tacos")];
  const { keep, insert } = planTurnWrite({ stored, screen, message: "¿y?", master: reply("Claro") });
  assert.equal(keep, 2, "rows from idx 2 on go");
  assert.deepEqual(insert.map((r) => [r.idx, r.role, r.text]), [[2, "learner", "¿y?"], [3, "master", null]]);
});

test("planTurnWrite: the same turn sent again replaces the first answer instead of adding a second", () => {
  const stored = rows(M("Hola"), L("tacos"), M("first answer"));
  const screen = [M("Hola")];
  const { keep, insert } = planTurnWrite({ stored, screen, message: "tacos", master: reply("second answer") });
  assert.equal(keep, 1);
  assert.deepEqual(insert.map((r) => [r.idx, r.role]), [[1, "learner"], [2, "master"]]);
  assert.equal(insert[1].lines[0].text, "second answer");
});

test("planTurnWrite: from the first disagreement on, the screen wins; whitespace alone is not a disagreement", () => {
  const stored = rows(M("Hola"), L("tacos  please"), M("x"));
  const keepSame = planTurnWrite({ stored, screen: [M(" Hola "), L("tacos please"), M("x")], message: "", master: reply("y") });
  assert.equal(keepSame.keep, 3);
  const differs = planTurnWrite({ stored, screen: [M("Hola"), L("burritos"), M("x")], message: "", master: reply("y") });
  assert.equal(differs.keep, 1);
  assert.deepEqual(differs.insert.map((r) => [r.idx, r.role, r.text]), [[1, "learner", "burritos"], [2, "master", null], [3, "master", null]]);
});

test("planTurnWrite: idx is always gap-free from keep", () => {
  for (let n = 0; n < 5; n++) {
    const items = Array.from({ length: n }, (_, i) => (i % 2 ? L(`l${i}`) : M(`m${i}`)));
    for (let cut = 0; cut <= n; cut++) {
      const { keep, insert } = planTurnWrite({ stored: rows(...items.slice(0, cut)), screen: items, message: "go", master: reply("ok") });
      assert.deepEqual(insert.map((r) => r.idx), Array.from({ length: insert.length }, (_, k) => keep + k));
      assert.equal(keep + insert.length, n + 2);
    }
  }
});

test("rows and transcript entries round-trip; empty extras are left out", () => {
  const item = M("Hola", { glosses: [{ term: "Hola", meaning: "Hi" }], choices: ["Más"], stage: "intro", castNotes: [{ slot: "character:female", age: "old", who: "Doña Carmen" }] });
  assert.deepEqual(itemFromRow(rowFromItem(item)), item);
  assert.deepEqual(itemFromRow(rowFromItem(M("x", { glosses: [], choices: [] }))), M("x"));
  assert.deepEqual(itemFromRow(rowFromItem(L("[help]"))), L("[help]"));
  assert.equal(turnKey(L(" a ")), turnKey(L("a")));
  assert.notEqual(turnKey(L("a")), turnKey(M("a")));
});

test("conversationTitle: the scene shown, else the pack's title, the scenario's, a quick scenario's first line", () => {
  assert.equal(conversationTitle({ title: " At the market ", pack: { title: "p" } }), "At the market");
  assert.equal(conversationTitle({ title: "", pack: { title: "My pack" }, scenarioTitle: "s" }), "My pack");
  assert.equal(conversationTitle({ pack: { title: "" }, scenarioTitle: "Taco stand" }), "Taco stand");
  assert.equal(conversationTitle({ pack: { title: "", quick_scenario: "Buying bread\nmore" } }), "Buying bread");
  assert.equal(conversationTitle({ pack: {} }), "Practice session");
  assert.equal(conversationTitle({ title: "x".repeat(300) }).length, 200);
});

test("readPage clamps, and a bad value is the default", () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(readPage(q(""), { size: 20, max: 100 }), { limit: 20, start: 0 });
  assert.deepEqual(readPage(q("limit=5&offset=10"), { size: 20, max: 100 }), { limit: 5, start: 10 });
  assert.deepEqual(readPage(q("limit=1000&offset=-1"), { size: 20, max: 100 }), { limit: 100, start: 0 });
  assert.deepEqual(readPage(q("limit=0&offset=x"), { size: 20, max: 100 }), { limit: 1, start: 0 });
  assert.deepEqual(readPage(q("from=7&limit=2.5"), { size: 200, max: 500, key: "from" }), { limit: 200, start: 7 });
});

test("CONVERSATION_ID_RE takes a uuid and nothing else", () => {
  assert.ok(CONVERSATION_ID_RE.test("0b5e7a52-4c1e-4d2b-9a1f-2f6c1d9e8a10"));
  assert.ok(!CONVERSATION_ID_RE.test("0b5e7a52-4c1e-4d2b-9a1f-2f6c1d9e8a1"));
  assert.ok(!CONVERSATION_ID_RE.test("1; drop table conversations"));
});
