// When the Go tab's saved conversation may stay open (web/src/conversationLife.ts):
// what happens to a conversation whose creation answers after the session
// moved on, and waiting out a turn on its way. Node strips the TS types.
//   node --test scripts/tests/conversation-life.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationFate, turnsSettled } from "../../web/src/conversationLife.ts";

test("conversationFate: adopted only while the session is live; ended after its turn when Go was left; dropped when the session is gone", () => {
  assert.equal(conversationFate({ madeInEpoch: 3, epochNow: 3, live: true }), "adopt");
  // Left Go while the cast loaded or the create was on its way: the turn is
  // still stored in it, then it ends.
  assert.equal(conversationFate({ madeInEpoch: 3, epochNow: 3, live: false }), "end-after-turn");
  // End, Restart or Close came first: nothing will use it, live or not.
  assert.equal(conversationFate({ madeInEpoch: 3, epochNow: 4, live: true }), "drop");
  assert.equal(conversationFate({ madeInEpoch: 3, epochNow: 4, live: false }), "drop");
});

test("turnsSettled waits for the turn on its way, and for one that replaced it; never rejects", async () => {
  const inFlight = new Map();
  const order = [];
  // Nothing on its way: at once.
  await turnsSettled(inFlight, "c");
  order.push("none");
  // A failing turn, kept in the map until it settles, as VoicePanel's send() does.
  let fail;
  const first = new Promise((_, reject) => (fail = reject));
  const track = (p) => {
    inFlight.set("c", p);
    const done = () => {
      if (inFlight.get("c") === p) inFlight.delete("c");
    };
    p.then(done, done);
  };
  track(first);
  const waited = turnsSettled(inFlight, "c").then(() => order.push("settled"));
  // Its resend replaces it before it settles (the 409 path sends again).
  let answer;
  const second = new Promise((resolve) => (answer = resolve));
  track(second);
  fail(new Error("conversation_ended"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["none"], "still waiting for the resend");
  answer({ saved: true });
  await waited;
  assert.deepEqual(order, ["none", "settled"]);
  // Another conversation's turn is no reason to wait.
  track(new Promise(() => {}));
  await turnsSettled(inFlight, "other");
});
