// The recorder's conversion (web/src/wav16k.ts): decoded channels → 16 kHz
// mono 16-bit PCM WAV, with a real low-pass before the rate drops. The old
// conversion (a 48 kHz buffer played through a 16 kHz OfflineAudioContext)
// let a 10 kHz tone through at full level, folded to 6 kHz; these hold the
// replacement to its numbers.
//   node --test scripts/tests/wav16k.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { WAV_RATE, downmix, encodeWav16k, resampleTo16k } from "../../web/src/wav16k.ts";
import { parseWav } from "../pronunciation.mjs";
import { readScoreAudio } from "../pronunciation-app.mjs";

const sine = (hz, rate, seconds = 1, amp = 0.5) => {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
};
/** RMS over the middle, past the filter's run-in at either end. */
const rms = (x, rate) => {
  const skip = Math.floor(0.1 * rate);
  let t = 0;
  for (let i = skip; i < x.length - skip; i++) t += x[i] * x[i];
  return Math.sqrt(t / (x.length - 2 * skip));
};
/** Output level against input level, in dB. */
const gainDb = (hz, rate) => {
  const x = sine(hz, rate);
  return 20 * Math.log10(rms(resampleTo16k(x, rate), WAV_RATE) / rms(x, rate));
};

for (const rate of [48_000, 44_100]) {
  test(`${rate} Hz: above 8 kHz is rejected (at least 80 dB from 8.5 kHz), the band below 7 kHz kept flat`, () => {
    for (const hz of [8_500, 9_000, 10_000, 13_000, 20_000]) {
      const g = gainDb(hz, rate);
      assert.ok(g < -80, `${hz} Hz came through at ${g.toFixed(1)} dB`);
    }
    for (const hz of [100, 1_000, 4_000, 7_000]) {
      const g = gainDb(hz, rate);
      assert.ok(Math.abs(g) < 0.1, `${hz} Hz changed by ${g.toFixed(2)} dB`);
    }
  });
}

test("a sweep through 8–23 kHz leaves nothing in the band", () => {
  const rate = 48_000;
  const x = new Float32Array(rate);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (2 * Math.PI * (8_500 + (14_500 * i) / x.length)) / rate;
    x[i] = 0.5 * Math.sin(ph);
  }
  const g = 20 * Math.log10(rms(resampleTo16k(x, rate), WAV_RATE) / rms(x, rate));
  assert.ok(g < -80, `the sweep came through at ${g.toFixed(1)} dB`);
});

test("length is ceil(duration × 16 kHz); a 16 kHz input comes back as it is; a bad rate throws", () => {
  assert.equal(resampleTo16k(new Float32Array(48_000), 48_000).length, 16_000);
  assert.equal(resampleTo16k(new Float32Array(44_100), 44_100).length, 16_000);
  assert.equal(resampleTo16k(new Float32Array(44_101), 44_100).length, 16_001);
  assert.equal(resampleTo16k(new Float32Array(1), 48_000).length, 1);
  assert.equal(resampleTo16k(new Float32Array(0), 48_000).length, 1);
  const same = new Float32Array(10);
  assert.equal(resampleTo16k(same, 16_000), same);
  assert.throws(() => resampleTo16k(same, 0));
  assert.throws(() => resampleTo16k(same, Number.NaN));
});

test("a tone keeps its place in time (no delay from the filter)", () => {
  // An impulse at 0.5 s comes out centred at 0.5 s.
  const x = new Float32Array(48_000);
  x[24_000] = 1;
  const y = resampleTo16k(x, 48_000);
  let at = 0;
  for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
  assert.equal(at, 8_000);
});

test("downmix averages the channels; one channel passes through; none is empty", () => {
  const l = Float32Array.from([1, 0.5, -1]);
  const r = Float32Array.from([0, 0.5, 1]);
  assert.deepEqual(Array.from(downmix([l, r])), [0.5, 0.5, 0]);
  assert.equal(downmix([l]), l);
  assert.equal(downmix([]).length, 0);
  // Channels of unequal length: the shorter one decides.
  assert.equal(downmix([l, Float32Array.from([0, 0])]).length, 2);
});

test("encodeWav16k writes the format the server takes: 16 kHz mono 16-bit PCM, clipped, NaN as silence", () => {
  const pcm = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -3, Number.NaN]);
  const wav = new Uint8Array(encodeWav16k(pcm));
  assert.equal(wav.length, 44 + pcm.length * 2);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  const ints = Array.from({ length: pcm.length }, (_, i) => view.getInt16(44 + i * 2, true));
  assert.deepEqual(ints, [0, 16383, -16384, 32767, -32768, 32767, -32768, 0]);
  const back = parseWav(wav);
  assert.equal(back.sampleRate, 16_000);
  assert.equal(back.samples.length, pcm.length);
  // A second of it is a recording the tone check accepts.
  assert.deepEqual(readScoreAudio(new Uint8Array(encodeWav16k(new Float32Array(16_000)))), { seconds: 1 });
});
