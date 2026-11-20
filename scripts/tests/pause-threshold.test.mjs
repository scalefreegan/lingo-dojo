// The recorder's pause-detector threshold (ld-5cj). node --test scripts/tests/pause-threshold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_THRESHOLD, pauseThreshold } from "../../web/shared/pause-threshold.ts";

const dbfs = (db) => 10 ** (db / 20);

test("conversation keeps the old 0.015 minimum", () => {
  assert.equal(pauseThreshold(0, "conversation"), 0.015);
  assert.equal(pauseThreshold(0.001, "conversation"), 0.015);
  assert.equal(pauseThreshold(0.01, "conversation"), 0.03);
});

test("pitch: quiet speech at -45 dBFS in a silent room arms it; the old minimum would not", () => {
  assert.ok(dbfs(-45) > pauseThreshold(0, "pitch"));
  assert.ok(dbfs(-45) < MIN_THRESHOLD.conversation);
});

test("pitch: hiss and room noise do not arm it", () => {
  for (const noise of [-60, -52, -48, -42]) {
    const floor = dbfs(noise);
    assert.ok(floor <= pauseThreshold(floor, "pitch"), `${noise} dBFS noise sits at or under its own threshold`);
  }
  // The floor, not the minimum, drives it once the room is louder than ~-58 dBFS.
  assert.ok(Math.abs(pauseThreshold(0.01, "pitch") - 0.03) < 1e-12);
});

test("pitch minimum is lower than conversation's, and above digital silence", () => {
  assert.ok(MIN_THRESHOLD.pitch > 0 && MIN_THRESHOLD.pitch < MIN_THRESHOLD.conversation);
});
