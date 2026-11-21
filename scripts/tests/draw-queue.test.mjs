// The Go tab's voice draws, one at a time per session (web/src/drawQueue.ts;
// docs/VOICE.md §Paid calls at once): a streamed reply that brings in two
// new people must not have two /cast calls out beside the line's speech
// (three calls on two paid slots), and asks made while a draw is out merge
// into one next draw per kind instead of one per change.
//   node --test scripts/tests/draw-queue.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { drawQueue, mergeBatch } from "../../web/src/drawQueue.ts";

/** A `start` whose draws end only when the test says; counts how many are out at once. */
function fakeDraws() {
  const calls = [];
  let out = 0;
  let most = 0;
  const start = (batch) => {
    out++;
    most = Math.max(most, out);
    let finish;
    const p = new Promise((r) => (finish = r)).then(() => {
      out--;
    });
    calls.push({ batch, finish });
    return p;
  };
  return { start, calls, most: () => most };
}

const ask = (slot, key, age = "old", retry = false) => ({ slots: [slot], retry, ages: { [slot]: age }, keys: { [slot]: key } });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("one draw out at a time: asks made meanwhile merge into one next draw, not one per change", async () => {
  const f = fakeDraws();
  const q = drawQueue(f.start);
  let fDone = false;
  let mDone = false;
  let kDone = false;
  // A streamed reply: CHARACTER-F old comes in, then CHARACTER-M young, then
  // SIDEKICK-F child, each its own ask while the first draw is out.
  void q.request(ask("character:female", "character:female|carmen", "old")).then(() => (fDone = true));
  void q.request(ask("character:male", "character:male|pepe", "young")).then(() => (mDone = true));
  void q.request(ask("sidekick:female", "sidekick:female|lu", "child")).then(() => (kDone = true));
  await tick();
  assert.equal(f.calls.length, 1, "the second and third asks wait");
  assert.ok(q.busy());
  f.calls[0].finish();
  await tick();
  assert.ok(fDone, "the first ask settles when its draw ends");
  assert.ok(!mDone && !kDone, "the merged asks wait for their own draw, so their lines do too");
  assert.equal(f.calls.length, 2, "the two waiting asks went out as one draw");
  assert.deepEqual(f.calls[1].batch.slots, ["character:male", "sidekick:female"]);
  assert.deepEqual(f.calls[1].batch.ages, { "character:male": "young", "sidekick:female": "child" });
  f.calls[1].finish();
  await tick();
  assert.ok(mDone && kDone);
  assert.equal(f.most(), 1, "never two draws at once");
  assert.ok(!q.busy());
});

test("first draws go before retries, and the two never merge", async () => {
  const f = fakeDraws();
  const q = drawQueue(f.start);
  void q.request(ask("narrator:female", "n|a"));
  void q.request(ask("character:male", "c|old-friend", "old", true));
  void q.request(ask("character:female", "c|new", "young"));
  await tick();
  f.calls[0].finish();
  await tick();
  assert.equal(f.calls[1].batch.retry, false);
  assert.deepEqual(f.calls[1].batch.slots, ["character:female"]);
  f.calls[1].finish();
  await tick();
  assert.equal(f.calls[2].batch.retry, true);
  assert.deepEqual(f.calls[2].batch.slots, ["character:male"]);
  f.calls[2].finish();
  await tick();
  assert.equal(f.most(), 1);
});

test("a first draw asked while a retry is out cuts the retry short (never two out), goes first, and the retry is asked again after", async () => {
  const calls = [];
  let out = 0;
  let most = 0;
  const q = drawQueue((batch, signal) => {
    out++;
    most = Math.max(most, out);
    let finish;
    // As runDraw: the /cast is aborted with the signal, and returns quietly.
    const p = new Promise((r) => {
      finish = r;
      signal.addEventListener("abort", () => r(), { once: true });
    }).then(() => {
      out--;
    });
    calls.push({ batch, signal, finish });
    return p;
  });
  let retryDone = false;
  let firstDone = false;
  void q.request(ask("character:male", "c|pepe", "old", true)).then(() => (retryDone = true));
  await tick();
  assert.equal(calls.length, 1);
  void q.request(ask("character:female", "c|carmen", "young")).then(() => (firstDone = true));
  assert.equal(calls[0].signal.aborted, true, "the retry is cut short at once, not waited out");
  await tick();
  assert.equal(calls.length, 2, "the first draw went out once the retry stopped");
  assert.equal(calls[1].batch.retry, false);
  assert.ok(!retryDone, "the cut retry isn't done: its person's retry is still owed");
  calls[1].finish();
  await tick();
  assert.ok(firstDone);
  assert.equal(calls.length, 3, "the retry went out again after the first draw");
  assert.equal(calls[2].batch.retry, true);
  assert.deepEqual(calls[2].batch.slots, ["character:male"]);
  calls[2].finish();
  await tick();
  assert.ok(retryDone);
  assert.equal(most, 1, "never two draws out at once");
});

test("a later ask for the same tag names its new person; a failed draw still lets the next go; reset settles the waiting", async () => {
  assert.deepEqual(mergeBatch(ask("character:male", "a"), ask("character:male", "b", "young")), {
    slots: ["character:male"], retry: false, ages: { "character:male": "young" }, keys: { "character:male": "b" },
  });
  const calls = [];
  const q = drawQueue((batch) => {
    calls.push(batch);
    return calls.length === 1 ? Promise.reject(new Error("timeout")) : Promise.resolve();
  });
  const first = q.request(ask("x", "x|1"));
  const second = q.request(ask("y", "y|1"));
  await first;
  await second;
  assert.equal(calls.length, 2, "a failure doesn't stall the queue");
  // Reset: what waits is dropped and its promise settles, so no line waits forever.
  let release;
  const q2 = drawQueue(() => new Promise((r) => (release = r)));
  void q2.request(ask("x", "x|1"));
  let settled = false;
  void q2.request(ask("y", "y|1")).then(() => (settled = true));
  q2.reset();
  await tick();
  assert.ok(settled);
  release();
  await tick();
  assert.ok(!q2.busy());
  assert.deepEqual(await q2.request({ slots: [], retry: false, ages: {}, keys: {} }), undefined, "nothing to draw is no draw");
});
