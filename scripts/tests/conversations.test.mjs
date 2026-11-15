// The pure half of saved conversations (scripts/conversations.mjs): how a
// turn's write makes the stored turns match the screen, titles and paging.
//   node --test scripts/tests/conversations.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_ID_RE, MAX_START, conversationTitle, itemFromRow, planTurnWrite, readPage, rowFromItem, turnKey,
} from "../conversations.mjs";
import { replayLine } from "../voice.mjs";

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
  const { keep, insert, covered } = planTurnWrite({ stored, screen, message: "¿y?", master: reply("Claro") });
  assert.equal(covered, true);
  assert.equal(keep, 2, "only that reply goes");
  assert.deepEqual(insert.map((r) => [r.idx, r.role, r.text]), [[2, "learner", "¿y?"], [3, "master", null]]);
  // The screen may show something else where that reply was: still only it goes.
  const other = planTurnWrite({ stored, screen: [M("Hola"), L("tacos"), M("shown instead")], message: "", master: reply("Claro") });
  assert.equal(other.keep, 2);
  assert.deepEqual(other.insert.map((r) => [r.idx, r.fromClient]), [[2, true], [3, false]]);
});

test("planTurnWrite: a history that doesn't cover what is stored deletes and rewrites nothing; the turn is appended", () => {
  const stored = rows(M("Hola"), L("tacos"), M("Claro"), L("¿y?"), M("Ya"));
  // An empty history (a client that sent none) leaves all five alone.
  const none = planTurnWrite({ stored, screen: [], message: "hola", master: reply("¡Hola!") });
  assert.equal(none.covered, false);
  assert.equal(none.keep, 5);
  assert.deepEqual(none.insert.map((r) => [r.idx, r.role, r.text, r.fromClient]), [[5, "learner", "hola", false], [6, "master", null, false]]);
  // A shorter one, ending two or more rows early: the same.
  assert.equal(planTurnWrite({ stored, screen: [M("Hola"), L("tacos")], message: "x", master: reply("y") }).keep, 5);
  // The same turn sent twice from one screen: the first answer stays.
  const twice = planTurnWrite({ stored: rows(M("Hola"), L("tacos"), M("first answer")), screen: [M("Hola")], message: "tacos", master: reply("second answer") });
  assert.equal(twice.keep, 3);
  assert.deepEqual(twice.insert.map((r) => [r.idx, r.role]), [[3, "learner"], [4, "master"]]);
  // A history that differs before the final reply: nothing of it is written.
  const forged = planTurnWrite({ stored, screen: [M("Hola"), L("burritos"), M("I never said this")], message: "", master: reply("y") });
  assert.equal(forged.covered, false);
  assert.equal(forged.keep, 5);
  assert.deepEqual(forged.insert.map((r) => [r.idx, r.role]), [[5, "master"]]);
});

test("planTurnWrite: whitespace alone is not a disagreement, and an agreeing row is kept, never rewritten", () => {
  const stored = rows(M("Hola"), L("tacos  please"), M("x"));
  const same = planTurnWrite({ stored, screen: [M(" Hola "), L("tacos please"), M("x")], message: "", master: reply("y") });
  assert.equal(same.keep, 3);
  assert.deepEqual(same.insert.map((r) => r.idx), [3]);
});

test("planTurnWrite: a stored line with a \"|\" matches its own replay (which turns it into a space), so it is kept", () => {
  const said = M("Uno | dos\ntres");
  const stored = rows(said);
  // What the turn route makes of the browser's copy (cleanHistory).
  const replayed = { role: "master", lines: said.lines.map((l) => ({ ...l, text: replayLine(l.text) })) };
  assert.equal(replayed.lines[0].text.includes("|"), false);
  assert.equal(turnKey(replayed), turnKey(stored[0]));
  const { keep, insert } = planTurnWrite({ stored, screen: [replayed], message: "sí", master: reply("bien") });
  assert.equal(keep, 1, "the stored row, pipe and all, stays");
  assert.deepEqual(insert.map((r) => r.idx), [1, 2]);
  // Past the turn route's length cap, the same.
  const long = rows(M("a".repeat(5000)));
  assert.equal(planTurnWrite({ stored: long, screen: [{ role: "master", lines: [line(replayLine("a".repeat(5000)))] }], message: "", master: reply("b") }).keep, 1);
});

test("planTurnWrite: master rows taken from the history are fromClient; the server's reply and learner rows are not", () => {
  const stored = rows(M("Hola"));
  // Saving resumed after unsaved turns: the screen holds two the store lacks.
  const { insert } = planTurnWrite({ stored, screen: [M("Hola"), L("tacos"), M("Claro")], message: "gracias", master: reply("De nada") });
  assert.deepEqual(insert.map((r) => [r.idx, r.role, r.fromClient]), [[1, "learner", false], [2, "master", true], [3, "learner", false], [4, "master", false]]);
  assert.equal(insert[1].durationMs, undefined, "a rewritten reply has no timing of its own");
  assert.equal(insert[3].durationMs, 1200);
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
  // Huge starts are clamped to what Postgres takes, never passed through.
  for (const v of ["100000000000000000000", "9223372036854775808", "3000000000", "1e300"]) {
    assert.deepEqual(readPage(q(`offset=${v}`), { size: 20, max: 100 }), { limit: 20, start: MAX_START }, v);
  }
  assert.equal(MAX_START, 2147483647);
});

test("CONVERSATION_ID_RE takes a uuid and nothing else", () => {
  assert.ok(CONVERSATION_ID_RE.test("0b5e7a52-4c1e-4d2b-9a1f-2f6c1d9e8a10"));
  assert.ok(!CONVERSATION_ID_RE.test("0b5e7a52-4c1e-4d2b-9a1f-2f6c1d9e8a1"));
  assert.ok(!CONVERSATION_ID_RE.test("1; drop table conversations"));
});
