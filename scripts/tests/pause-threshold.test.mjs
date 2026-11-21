// The recorder's pause detector: its threshold (ld-5cj) and the floor that
// follows a steady room (ld-efi). node --test scripts/tests/pause-threshold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATE_MS, MIN_THRESHOLD, TICK_MS, createPauseDetector, noiseFloor, pauseThreshold } from "../../web/shared/pause-threshold.ts";

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

// ---- The detector over synthetic level sequences (ld-efi) ----
// One value per 50 ms tick, in dBFS, as the recorder measures them. A
// seeded jitter stands in for a real room; none of this is a real
// microphone (docs/VOICE.md §The recorder: that check is owed).

/** A small seeded PRNG, so every run sees the same "room". */
const rng = (seed) => () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);

/** Run levels (dBFS) through a detector; the first auto-stop and when. */
function run(levelsDb, opts) {
  const d = createPauseDetector({ processing: "pitch", silenceMs: 1500, maxMs: 20_000, idleMs: 10_000, ...opts });
  for (let i = 0; i < levelsDb.length; i++) {
    const at = i * TICK_MS;
    const why = d.tick(dbfs(levelsDb[i]), at);
    if (why) return { why, at, spoke: d.spoke };
  }
  return { why: null, at: levelsDb.length * TICK_MS, spoke: d.spoke };
}

/** Main's detector before ld-efi, for comparison: calibration's threshold,
 *  never moved (silenceMs 1500, idle 10 s, as `run`). */
function fixedRun(levelsDb, processing, maxMs) {
  const fixed = pauseThreshold(noiseFloor(levelsDb.slice(0, ticks(CALIBRATE_MS)).map(dbfs)), processing);
  let loud = 0;
  let spoke = false;
  let last = 0;
  for (let i = ticks(CALIBRATE_MS); i < levelsDb.length; i++) {
    const at = i * TICK_MS;
    if (dbfs(levelsDb[i]) > fixed) {
      loud += TICK_MS;
      last = at;
      if (loud >= 200) spoke = true;
    } else loud = Math.max(0, loud - TICK_MS / 2);
    if (at >= maxMs) return "max";
    if (spoke && at - last >= 1500) return "pause";
    if (!spoke && at >= 10_000) return "idle";
  }
  return null;
}

const ticks = (ms) => Math.round(ms / TICK_MS);
/** A steady level with ±jitter dB per tick. */
const steady = (db, ms, jitter, r) => Array.from({ length: ticks(ms) }, () => db + (r() * 2 - 1) * jitter);
/** Speech: syllables of 150–300 ms around `db` (±6 dB within one), 50–150
 *  ms dips to near the room between them, a 400 ms breath every ~2 s. */
function speech(db, ms, roomDb, r) {
  const out = [];
  let sinceBreath = 0;
  while (out.length < ticks(ms)) {
    const syl = 3 + Math.floor(r() * 4);
    for (let i = 0; i < syl; i++) out.push(db + (r() * 2 - 1) * 6);
    const breath = sinceBreath > 2000;
    const gap = breath ? 8 : 1 + Math.floor(r() * 3);
    sinceBreath = breath ? 0 : sinceBreath + (syl + gap) * TICK_MS;
    for (let i = 0; i < gap; i++) out.push(roomDb + 2 + r() * 4);
  }
  return out.slice(0, ticks(ms));
}

test("detector: a steady noise that starts after speech ends the take on a pause, not the cap", () => {
  const r = rng(1);
  // A quiet room, 3 s of speech, then a fan at -38 dBFS that never stops.
  const levels = [...steady(-60, 400, 0.5, r), ...speech(-30, 3000, -60, r), ...steady(-38, 30_000, 0.5, r)];
  const got = run(levels);
  assert.equal(got.why, "pause");
  assert.ok(got.spoke);
  // The fan starts at 3.4 s: about 11 s to follow it up, 1.5 s of quiet.
  assert.ok(got.at > 3400 + 10_000 && got.at < 3400 + 14_000, `ended at ${got.at} ms`);
});

test("detector: a steady noise from just after calibration, no speech, still ends before the cap", () => {
  const r = rng(2);
  const got = run([...steady(-62, 400, 0.5, r), ...steady(-40, 30_000, 1, r)]);
  assert.equal(got.why, "pause");
  assert.ok(got.at < 20_000, `ended at ${got.at} ms`);
});

test("detector: a louder room's floor follows too (-50 dBFS room, -35 dBFS fan)", () => {
  const r = rng(3);
  const levels = [...steady(-50, 400, 0.5, r), ...speech(-25, 2000, -50, r), ...steady(-35, 30_000, 0.5, r)];
  assert.equal(run(levels, { maxMs: 30_000 }).why, "pause");
});

test("detector: quiet speech (-45 dBFS) with normal pauses is never cut off, 15 s of it", () => {
  for (const seed of [4, 5, 6, 7, 8]) {
    const r = rng(seed);
    const levels = [...steady(-60, 400, 0.5, r), ...speech(-45, 15_000, -60, r), ...steady(-60, 5000, 0.5, r)];
    const got = run(levels, { maxMs: 60_000 });
    assert.equal(got.why, "pause", `seed ${seed}`);
    // Not before the speech ends (0.4 + 15 s).
    assert.ok(got.at >= 400 + 15_000, `seed ${seed}: cut at ${got.at} ms`);
  }
});

test("detector: one vowel held 3 s perfectly steady at -45 dBFS is not cut", () => {
  const r = rng(9);
  const levels = [...steady(-60, 400, 0.5, r), ...steady(-45, 3000, 0.3, r), ...steady(-60, 3000, 0.5, r)];
  const got = run(levels);
  assert.equal(got.why, "pause");
  assert.ok(got.at >= 400 + 3000 + 1500 - TICK_MS, `cut at ${got.at} ms`);
});

test("detector: connected quiet speech whose dips never reach the room (a live room) is not followed up", () => {
  // Syllables at -45 ±3 dBFS, the gaps between them only down to about
  // -50 (reverb), never the -60 room: no quiet tick resets the floor, so
  // only the steadiness gate keeps it from climbing under the voice.
  const r = rng(12);
  const talk = [];
  while (talk.length < ticks(12_000)) {
    for (let i = 0; i < 4; i++) talk.push(-45 + (r() * 2 - 1) * 3);
    talk.push(-50 + r(), -50 + r());
  }
  const levels = [...steady(-60, 400, 0.5, r), ...talk, ...steady(-60, 4000, 0.5, r)];
  const got = run(levels, { maxMs: 60_000 });
  assert.equal(got.why, "pause");
  assert.ok(got.at >= 400 + 12_000, `cut at ${got.at} ms`);
});

test("detector: when the noise stops, the floor comes back down within 300 ms, to the calibration floor and no lower", () => {
  const r = rng(13);
  const d = createPauseDetector({ processing: "pitch", silenceMs: null, maxMs: 60_000, idleMs: 60_000 });
  let at = 0;
  for (const db of [...steady(-50, 400, 0.2, r), ...steady(-38, 15_000, 0.5, r)]) d.tick(dbfs(db), (at += TICK_MS));
  assert.ok(d.threshold > dbfs(-38), "followed the fan up");
  for (let i = 0; i < 6; i++) d.tick(dbfs(-70), (at += TICK_MS));
  // Calibration heard about -50: the threshold is 3x that again, not 3x -70.
  assert.ok(d.threshold > 3 * dbfs(-50.5) && d.threshold < 3 * dbfs(-49.5), `threshold ${d.threshold}`);
});

test("detector: a fluctuating room (a café) never pulls the threshold under calibration's", () => {
  // -45 ±6 dBFS around a pitch take, speech at -30: the take still ends
  // on the pause after it, as on main. Following the quietest single tick
  // down left -39 dBFS bumps over the threshold for the rest of the take.
  // Whenever the fixed threshold (main's detector: calibration's, never
  // moved) ends the take on the pause, this one does too.
  let fixedPauses = 0;
  for (let seed = 100; seed < 160; seed++) {
    const r = rng(seed);
    const room = (ms) => steady(-45, ms, 6, r);
    const levels = [...room(400), ...speech(-30, 3000, -45, r), ...room(20_000)];
    if (fixedRun(levels, "pitch", 30_000) !== "pause") continue;
    fixedPauses++;
    const got = run(levels, { maxMs: 30_000 });
    assert.equal(got.why, "pause", `seed ${seed}: ${got.why} at ${got.at}`);
  }
  assert.ok(fixedPauses >= 20, `only ${fixedPauses} seeds to compare`);
});

test("detector: one dropped (0 or NaN) tick does not collapse the floor", () => {
  for (const bad of [0, Number.NaN]) {
    const r = rng(19);
    const d = createPauseDetector({ processing: "pitch", silenceMs: 1500, maxMs: 20_000, idleMs: 10_000 });
    let at = 0;
    for (const db of steady(-40, 400, 0.5, r)) d.tick(dbfs(db), (at += TICK_MS));
    const before = d.threshold;
    d.tick(bad, (at += TICK_MS));
    for (let i = 0; i < 6; i++) d.tick(dbfs(-40), (at += TICK_MS));
    assert.ok(d.threshold >= before, `${bad}: ${d.threshold} < ${before}`);
  }
});

test("detector: dropped (0) reads under a steady fan don't hold its climb back", () => {
  const r = rng(21);
  const fan = steady(-38, 30_000, 0.5, r).map((db, i) => (i % 15 === 7 ? -Infinity : db));
  const got = run([...steady(-60, 400, 0.5, r), ...speech(-30, 3000, -60, r), ...fan]);
  assert.equal(got.why, "pause");
});

test("detector: a conversation take keeps the fixed threshold (a long steady note, a steady fan)", () => {
  const r = rng(20);
  // A -30 dBFS drawn-out note for 12 s: never cut.
  const note = run([...steady(-60, 400, 0.5, r), ...steady(-30, 12_000, 0.5, r), ...steady(-60, 3000, 0.5, r)], { processing: "conversation", maxMs: 60_000 });
  assert.equal(note.why, "pause");
  assert.ok(note.at >= 400 + 12_000, `cut at ${note.at} ms`);
  // A steady fan over speech: as on main, only the cap ends it.
  const fan = run([...steady(-60, 400, 0.5, r), ...speech(-20, 3000, -60, r), ...steady(-30, 30_000, 0.5, r)], { processing: "conversation", maxMs: 25_000 });
  assert.equal(fan.why, "max");
});

test("detector: speech that starts inside calibration still arms it and ends on the pause", () => {
  const r = rng(10);
  // Two ticks of room, then the learner is already talking (PR #40).
  const levels = [...steady(-60, 100, 0.5, r), ...speech(-45, 4000, -60, r), ...steady(-60, 4000, 0.5, r)];
  const got = run(levels);
  assert.equal(got.why, "pause");
  assert.ok(got.spoke);
  assert.ok(got.at >= 4100, `cut at ${got.at} ms`);
});

test("detector: the idle and max caps, and no auto-stop with silenceMs null", () => {
  const r = rng(11);
  assert.deepEqual(run(steady(-60, 12_000, 0.5, r)), { why: "idle", at: 10_000, spoke: false });
  assert.equal(run(steady(-60, 12_000, 0.5, r), { silenceMs: null }).why, null);
  assert.equal(run(speech(-30, 25_000, -60, r), { silenceMs: null }).why, "max");
});
