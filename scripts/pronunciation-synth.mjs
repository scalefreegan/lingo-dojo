// Generated audio for the pronunciation engine's tests and proof: a voice
// that says tones (speak), and the surroundings of a real push-to-talk
// recording put around any clip (surround, NOISE_CONDITIONS). Pure: no
// files, no network. Everything is seeded, so a run repeats exactly.
//
// Shared because the same disturbances must be measured two ways: on the
// proof's cached synthesized clips (scripts/pronunciation-proof.mjs, "With
// lead-in noise") and, in small, on every `npm test`.

import { speakerRange, trackPitch, withTone } from "./pronunciation.mjs";

export const RATE = 16_000;

// The voice the tests listen to. Deliberately not the classifier's own
// templates: each tone is a curve in time with its own formula (Chao level
// against x, 0 at the start of the syllable and 1 at its end), not the five
// levels the classifier matches against; the pitch drifts down across the
// utterance as real sentences do; every glottal period is jittered; and
// the range a test hands the scorer is the nominal one, not what the drift
// and the jitter actually produce.
export const CURVES = {
  1: (x) => 4.7 - 0.25 * x, // high, sagging a little
  2: (x) => 2.9 - 0.9 * x + 3 * x * x, // a small dip first, then up to the top
  3: (x) => 2.7 - 6.8 * x + 7 * x * x, // down to the floor before the middle, most of the way back
  4: (x) => 4.9 - 3.9 * x ** 1.4, // top to bottom, slowly at first
  low: (x) => 2.3 - 1.2 * Math.sqrt(x), // the half third: low and sinking
};

/** A voice saying `shapes` one after another (keys of CURVES, or a curve of
 *  its own): a buzz of six harmonics whose pitch follows each curve between
 *  `lowHz` and `lowHz` + `spanSt` semitones, `ms` each, `gapMs` of silence
 *  between. `declineSt` is the drift down across the utterance, `jitter`
 *  the period-to-period wobble, `weak` drops the fundamental (a telephone,
 *  a small speaker), `noise` adds white noise at that amplitude. `ms` may
 *  be one length per syllable, `gaps` the silences one by one (before the
 *  first, between, after the last) and `amps` a loudness per syllable. */
export function speak(shapes, { lowHz = 110, spanSt = 10, ms = 260, gapMs = 70, gaps = null, amps = null, declineSt = 0.6, jitter = 0.004, weak = false, noise = 0, seed = 11, creakOnset = 0, ownRange = false } = {}) {
  const lenOf = (k) => Math.round((RATE * (Array.isArray(ms) ? ms[k] : ms)) / 1000);
  const gapOf = (k) => Math.round((RATE * (gaps ? gaps[k] : gapMs)) / 1000);
  let total = gapOf(shapes.length);
  for (let k = 0; k < shapes.length; k++) total += gapOf(k) + lenOf(k);
  const out = new Float32Array(total);
  const timings = [];
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  let at = gapOf(0);
  for (const [k, name] of shapes.entries()) {
    const len = lenOf(k);
    const curve = typeof name === "function" ? name : CURVES[name];
    let phase = 0;
    let wobble = 1;
    for (let i = 0; i < len; i++) {
      const level = curve(i / (len - 1));
      const drift = -declineSt * ((at + i) / out.length);
      const hz = lowHz * 2 ** ((((level - 1) / 4) * spanSt + drift) / 12) * wobble;
      const before = phase;
      phase += (2 * Math.PI * hz) / RATE;
      // A new period: a new wobble.
      if (Math.floor(phase / (2 * Math.PI)) !== Math.floor(before / (2 * Math.PI))) wobble = 1 + jitter * rand();
      const env = Math.min(1, i / 240, (len - 1 - i) / 240);
      let v = 0;
      for (let h = weak ? 2 : 1; h <= 6; h++) v += Math.sin(phase * h) / h;
      out[at + i] = 0.3 * env * v * (amps ? amps[k] : 1);
    }
    // Creak over the first part of the syllable: the buzz replaced by
    // glottal pulses at irregular intervals, with no period to find.
    if (creakOnset) {
      const until = Math.round(len * creakOnset);
      for (let i = 0; i < until; i++) out[at + i] = 0;
      for (let i = 20; i < until; i += Math.round(RATE * (0.012 + 0.016 * Math.abs(rand())))) {
        for (let k = 0; k < 90 && i + k < until; k++) out[at + i + k] += 0.5 * Math.exp(-k / 18) * Math.sin(k / 6);
      }
    }
    timings.push({ startMs: (at / RATE) * 1000, endMs: ((at + len) / RATE) * 1000 });
    at += len + gapOf(k + 1);
  }
  if (noise) for (let i = 0; i < out.length; i++) out[i] += noise * rand();
  return { samples: out, timings, range: ownRange ? null : sessionRange({ lowHz, spanSt, weak }) };
}

/** What a session would know of a voice: its range measured (speakerRange)
 *  over an earlier utterance, not the numbers the generator was given. So
 *  the scorer reads every test syllable against a range that is a little
 *  narrower than the truth and not centred quite where the generator's is,
 *  as it would be in the app. */
const sessions = new Map();
export function sessionRange({ lowHz, spanSt, weak }) {
  const key = `${lowHz}/${spanSt}/${weak}`;
  if (!sessions.has(key)) {
    const earlier = speak([4, 1, 2, "low", 3, 2, 4, 1], { lowHz, spanSt, weak, declineSt: 1.5, seed: 29, ownRange: true });
    sessions.set(key, speakerRange(trackPitch(earlier.samples, RATE)));
  }
  return sessions.get(key);
}

/* ------------------------------- surroundings ------------------------------ */

/**
 * What a push-to-talk recording has around the speech, as conditions to
 * score under. Levels are dB against the clip's loudest 10 ms. Each `add`
 * is a pitched sound (a buzz of five harmonics): `where` "before" or
 * "after" the speech, `gapMs` between it and the speech, `ms` long.
 * The first clips from a real microphone had 30–50 ms pitched blips 16–25
 * dB under the speech, 260 ms or more away; the knocks and the murmur are
 * what the trim was later found to mistake for speech.
 */
export const NOISE_CONDITIONS = Object.freeze([
  { key: "clean", title: "The clips as they are (no lead-in)" },
  { key: "silence", title: "Half a second of plain silence before and after", noiseDb: null },
  { key: "room", title: "Room noise at −50 dB before, under and after", noiseDb: -50 },
  { key: "blip", title: "…and a 40 ms pitched blip at −20 dB, 300 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 300, ms: 40, db: -20 }] },
  { key: "knockBefore", title: "…and a pitched knock at −10 dB, 450 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 450, ms: 40, db: -10 }] },
  { key: "knockAfter", title: "…and a pitched knock at −10 dB, 300 ms after the speech", noiseDb: -50, add: [{ where: "after", gapMs: 300, ms: 40, db: -10 }] },
  { key: "murmur", title: "…and a voiced 120 ms murmur at −27 dB, 300 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 300, ms: 120, db: -27 }] },
]);

/** `samples` as `condition` has it: half a second added before and after,
 *  with the condition's noise and sounds. "clean" returns the samples. */
export function surround(samples, sampleRate, condition, seed = 12345) {
  if (condition.key === "clean") return samples;
  const frame = Math.round(sampleRate * 0.01);
  let peak = 0;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += samples[i + k] ** 2;
    peak = Math.max(peak, Math.sqrt(sum / frame));
  }
  const pad = Math.round(sampleRate * 0.5);
  const out = new Float32Array(pad + samples.length + pad);
  out.set(samples, pad);
  if (condition.noiseDb !== null && condition.noiseDb !== undefined) {
    let state = seed;
    const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
    // Uniform noise of that RMS.
    const level = peak * 10 ** (condition.noiseDb / 20) * Math.sqrt(3);
    for (let i = 0; i < out.length; i++) out[i] += level * rand();
  }
  for (const sound of condition.add ?? []) {
    const n = Math.round((sampleRate * sound.ms) / 1000);
    const gap = Math.round((sampleRate * sound.gapMs) / 1000);
    const at = sound.where === "before" ? pad - gap - n : pad + samples.length + gap;
    const buzz = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let h = 1; h <= 5; h++) buzz[i] += Math.sin((2 * Math.PI * (sound.hz ?? 220) * h * i) / sampleRate) / h;
      sum += buzz[i] ** 2;
    }
    const gain = (peak * 10 ** (sound.db / 20)) / Math.sqrt(sum / n);
    const fade = Math.round(sampleRate * 0.005);
    for (let i = 0; i < n && at + i < out.length; i++) if (at + i >= 0) out[at + i] += buzz[i] * gain * Math.min(1, i / fade, (n - 1 - i) / fade);
  }
  return out;
}

/* ----------------------------- generated phrases ---------------------------- */

/** Syllables with the given expected tones, as one phrase with no sandhi. */
export const phraseOf = (...tones) => tones.map((t, i) => ({ char: "字", pinyin: withTone("ma", t), baseTone: t, expectedTone: t, accept: [t], half: false, breakBefore: i === 0 }));

/**
 * Three-syllable phrases whose last syllable is the kind a trim to the
 * speech can take for noise, which the cached clips can't express: said
 * short after a beginner's pause, or said softly. `options` go to speak().
 */
export const LAST_SYLLABLE_CASES = Object.freeze([
  { key: "plain", title: "Three syllables 70 ms apart, all alike", options: {} },
  { key: "pause", title: "A 300 ms pause, then a 70 ms last syllable", options: { ms: [260, 260, 70], gaps: [70, 70, 300, 70] } },
  { key: "soft", title: "The last syllable 27 dB under the others", options: { amps: [1, 1, 10 ** (-27 / 20)] } },
]);
export const GENERATED_VOICES = Object.freeze([{ lowHz: 110, spanSt: 10 }, { lowHz: 90, spanSt: 14 }, { lowHz: 250, spanSt: 12 }]);
export const GENERATED_PHRASES = Object.freeze([[4, 1, 2], [1, 4, 2], [2, 4, 1], [4, 2, 1], [1, 2, 4], [2, 1, 4], [4, 4, 1], [1, 1, 4], [2, 2, 1], [4, 1, 3], [1, 2, 3], [2, 4, 3]]);

/**
 * One generated phrase scored under its own tones and under every
 * relabelling of one syllable, the way the proof scores a clip: adds to
 * `tally` ({ right, wrong }, each { ok, unsure, off }). `score` is called
 * with the syllables and answers scoreTones' result.
 */
export function tallyLabellings(tally, tones, score) {
  const add = (side, verdict) => tally[side][verdict]++;
  score(phraseOf(...tones)).syllables.forEach((s) => add("right", s.verdict));
  tones.forEach((said, k) => {
    for (const label of [1, 2, 3, 4]) {
      if (label === said) continue;
      const labels = tones.map((t, i) => (i === k ? label : t));
      add("wrong", score(phraseOf(...labels)).syllables[k].verdict);
    }
  });
  return tally;
}
export const emptyTally = () => ({ right: { ok: 0, unsure: 0, off: 0 }, wrong: { ok: 0, unsure: 0, off: 0 } });
