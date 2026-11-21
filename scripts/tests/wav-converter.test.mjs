// The recorder's conversion off the main thread (web/src/wavConverter.ts,
// ld-lvk): through a Worker when one starts, on the page's own thread when
// none can or one fails, and the same WAV either way. The Worker here is a
// stand-in that runs the real Worker's job (answerWavRequest) and moves the
// transferred buffers as postMessage does (structuredClone with transfer).
//   node --test scripts/tests/wav-converter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerWavRequest } from "../../web/src/wav16k.ts";
import { makeWavConverter, wavOnThisThread } from "../../web/src/wavConverter.ts";

const sine = (hz, rate, seconds = 0.5) => {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
};

/** A stand-in Worker. `mode`: "ok" answers; "error" fires onerror instead
 *  (a module Worker that couldn't load); "refuse" answers with an error. */
function fakeWorker(mode = "ok") {
  const w = {
    posted: 0,
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      w.posted++;
      // What a real postMessage does to the sender's copy: detaches it.
      const moved = structuredClone(message, { transfer });
      setTimeout(() => {
        if (mode === "error") return w.onerror?.({ preventDefault() {} });
        const reply = mode === "refuse" ? { id: moved.id, error: "no" } : answerWavRequest(moved);
        w.onmessage?.({ data: structuredClone(reply, { transfer: "wav" in reply ? [reply.wav] : [] }) });
      }, 1);
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

const same = (a, b) => assert.deepEqual(new Uint8Array(a), new Uint8Array(b));

test("through the Worker: the same WAV as on this thread, the caller's channels untouched", async () => {
  const workers = [];
  const convert = makeWavConverter(() => {
    const w = fakeWorker();
    workers.push(w);
    return w;
  });
  const mono = sine(440, 48_000);
  const before = mono.slice();
  same(await convert([mono], 48_000), wavOnThisThread([before], 48_000));
  // The decoded AudioBuffer's own channel is copied, not transferred away.
  assert.equal(mono.length, before.length);
  assert.deepEqual(mono, before);
  const l = sine(440, 44_100);
  const r = sine(660, 44_100);
  same(await convert([l, r], 44_100), wavOnThisThread([l, r], 44_100));
  // One Worker for the page, reused.
  assert.equal(workers.length, 1);
  assert.equal(workers[0].posted, 2);
});

test("no Worker (none in this browser, or it throws on start): converted on this thread", async () => {
  const mono = sine(440, 48_000);
  same(await makeWavConverter(() => null)([mono], 48_000), wavOnThisThread([mono], 48_000));
  let tries = 0;
  const convert = makeWavConverter(() => {
    tries++;
    throw new Error("SecurityError");
  });
  same(await convert([mono], 48_000), wavOnThisThread([mono], 48_000));
  same(await convert([mono], 48_000), wavOnThisThread([mono], 48_000));
  assert.equal(tries, 1, "not tried again for every recording");
});

test("a Worker that fails to load (onerror after the post): this recording is still converted, later ones skip it", { timeout: 5000 }, async () => {
  const workers = [];
  const convert = makeWavConverter(() => {
    const w = fakeWorker("error");
    workers.push(w);
    return w;
  });
  const mono = sine(440, 48_000);
  const want = wavOnThisThread([mono], 48_000);
  // Two recordings waiting on it when it fails: both come back.
  const [a, b] = await Promise.all([convert([mono], 48_000), convert([mono], 48_000)]);
  same(a, want);
  same(b, want);
  assert.ok(workers[0].terminated);
  same(await convert([mono], 48_000), want);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].posted, 2);
});

test("a Worker that answers with an error: converted on this thread; a bad rate still throws", async () => {
  const convert = makeWavConverter(() => fakeWorker("refuse"));
  const mono = sine(440, 48_000);
  same(await convert([mono], 48_000), wavOnThisThread([mono], 48_000));
  await assert.rejects(makeWavConverter(() => fakeWorker())([mono], 0), /bad sample rate 0/);
});
