// The recorder's pause-detector threshold (ld-5cj). node --test scripts/tests/pause-threshold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_THRESHOLD, noiseFloor, pauseThreshold } from "../../web/shared/pause-threshold.ts";

const dbfs = (db) => 10 ** (db / 20);
const close = (a, b) => Math.abs(a - b) < 1e-9;

test("conversation keeps the old 0.015 minimum", () => {
  assert.equal(pauseThreshold(0, "conversation"), 0.015);
  assert.equal(pauseThreshold(0.001, "conversation"), 0.015);
  assert.ok(close(pauseThreshold(0.01, "conversation"), 0.03));
});

test("pitch: -45 dBFS speech arms it in a quiet room; the old minimum would not", () => {
  const t = pauseThreshold(noiseFloor([dbfs(-60), dbfs(-61), dbfs(-59)]), "pitch");
  assert.equal(t, MIN_THRESHOLD.pitch);
  assert.ok(dbfs(-45) > t);
  assert.ok(dbfs(-45) < MIN_THRESHOLD.conversation);
});

test("pitch: the floor sets the threshold in a louder room, about 9.5 dB above it", () => {
  const t = pauseThreshold(dbfs(-50), "pitch");
  assert.ok(close(t, 3 * dbfs(-50)));
  assert.ok(dbfs(-48) < t, "hiss 2 dB over the room does not arm it");
  assert.ok(dbfs(-45) < t, "-45 dBFS speech in a -50 dBFS room does not arm it (documented limit)");
  assert.ok(dbfs(-40) > t);
});

test("noiseFloor: speech inside the calibration window does not lift the floor", () => {
  const room = dbfs(-60);
  const speech = dbfs(-45);
  // 7 ticks of 50 ms: the learner starts talking on the third
  const levels = [room, room * 1.05, speech, speech, speech, speech, speech];
  assert.equal(noiseFloor(levels), room);
  assert.ok(speech > pauseThreshold(noiseFloor(levels), "pitch"));
  // the mean would have hidden that same speech under its own threshold
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  assert.ok(speech < pauseThreshold(mean, "pitch"));
});

test("noiseFloor: no ticks is 0, so the minimum applies", () => {
  assert.equal(noiseFloor([]), 0);
  assert.equal(pauseThreshold(noiseFloor([]), "pitch"), MIN_THRESHOLD.pitch);
});
