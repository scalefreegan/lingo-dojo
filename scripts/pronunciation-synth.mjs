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
 * is a sound `ms` long put `where` ("before" or "after"), `gapMs` away
 * from the clip's edge or, with `from: "speech"`, from where the speech
 * itself starts and ends (a negative gap overlaps it). Its `kind`: a
 * pitched buzz of five harmonics (the default), a "cough" (a noise burst
 * over a falling buzz) or a "child" (three syllables of a 300–380 Hz
 * voice). `hum` runs under the whole recording, `echo` is a room's
 * reflections, `cutMs` starts the clip that far into its first sound and
 * `padMs` is the lead-in and tail (half a second unless given).
 *
 * The first clips from a real microphone had 30–50 ms pitched blips 16–25
 * dB under the speech, 260 ms or more away; the knocks and the murmur are
 * what the trim was later found to mistake for speech; the rest are the
 * fifth review's (bead ld-ne0.7).
 */
export const NOISE_CONDITIONS = Object.freeze([
  { key: "clean", title: "The clips as they are" },
  { key: "silence", title: "Half a second of plain silence before and after", noiseDb: null },
  { key: "room", title: "Room noise at −50 dB before, under and after", noiseDb: -50 },
  { key: "blip", title: "…and a 40 ms pitched blip at −20 dB, 300 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 300, ms: 40, db: -20 }] },
  { key: "knockBefore", title: "…and a pitched knock at −10 dB, 450 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 450, ms: 40, db: -10 }] },
  { key: "knockAfter", title: "…and a pitched knock at −10 dB, 300 ms after the speech", noiseDb: -50, add: [{ where: "after", gapMs: 300, ms: 40, db: -10 }] },
  { key: "murmur", title: "…and a voiced 120 ms murmur at −27 dB, 300 ms before the speech", noiseDb: -50, add: [{ where: "before", gapMs: 300, ms: 120, db: -27 }] },
  { key: "nearKnockBefore", title: "…and a knock at −10 dB ending 100 ms before the first sound", noiseDb: -50, add: [{ where: "before", from: "speech", gapMs: 100, ms: 40, db: -10 }] },
  { key: "nearKnockAfter", title: "…and a knock at −10 dB 100 ms after the last sound", noiseDb: -50, add: [{ where: "after", from: "speech", gapMs: 100, ms: 40, db: -10 }] },
  { key: "knockOnset", title: "…and a knock at −10 dB over the first 20 ms of the speech", noiseDb: -50, add: [{ where: "before", from: "speech", gapMs: -20, ms: 40, db: -10 }] },
  { key: "coughBefore", title: "…and a cough 6 dB louder than the speech, 300 ms before it", noiseDb: -50, add: [{ where: "before", from: "speech", gapMs: 300, ms: 150, db: 6, kind: "cough" }] },
  { key: "coughAfter", title: "…and a cough 6 dB louder than the speech, 300 ms after it", noiseDb: -50, add: [{ where: "after", from: "speech", gapMs: 300, ms: 150, db: 6, kind: "cough" }] },
  { key: "secondVoice", title: "…and a child's voice at −10 dB in the lead-in, ending 300 ms before the speech", noiseDb: -50, padMs: 1300, add: [{ where: "before", from: "speech", gapMs: 300, db: -10, kind: "child" }] },
  { key: "hum100", title: "…and a 100 Hz hum at −20 dB throughout", noiseDb: -50, hum: { hz: 100, db: -20 } },
  { key: "hum60", title: "…and a 60 Hz hum at −20 dB throughout", noiseDb: -50, hum: { hz: 60, db: -20 } },
  { key: "midword", title: "Room noise, and the recording starts 60 ms into the first sound (no lead-in)", noiseDb: -50, cutMs: 60 },
  { key: "echo", title: "…in a room with echo (reflections for 600 ms, decaying over 150 ms)", noiseDb: -50, echo: { tauMs: 150, gain: 0.5 } },
]);

const makeRand = (seed) => {
  let state = seed;
  return () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
};

/** The loudest 10 ms of `samples`, as an RMS. */
function peak10(samples, sampleRate) {
  const frame = Math.round(sampleRate * 0.01);
  let peak = 0;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += samples[i + k] ** 2;
    peak = Math.max(peak, Math.sqrt(sum / frame));
  }
  return peak;
}

/** Where the sound is: the first and last 10 ms over a tenth of `peak`
 *  (sample indexes). */
function soundSpan(samples, sampleRate, peak) {
  const frame = Math.round(sampleRate * 0.01);
  let a = -1;
  let b = -1;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += samples[i + k] ** 2;
    if (Math.sqrt(sum / frame) > peak * 0.1) {
      if (a < 0) a = i;
      b = i + frame;
    }
  }
  return a < 0 ? [0, samples.length] : [a, b];
}

/** A buzz of `harmonics` at `hz` (gliding `glide` semitones over its
 *  length), `ms` long, at RMS `rms`, faded 5 ms at each end. */
function buzzOf(sampleRate, ms, hz, rms, { harmonics = 5, glide = 0 } = {}) {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  let sum = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    if (glide) phase += (2 * Math.PI * hz * 2 ** ((glide * i) / n / 12)) / sampleRate;
    else phase = (2 * Math.PI * hz * i) / sampleRate;
    for (let h = 1; h <= harmonics; h++) out[i] += Math.sin(phase * h) / h;
    sum += out[i] ** 2;
  }
  const gain = rms / Math.sqrt(sum / n);
  const fade = Math.round(sampleRate * 0.005);
  for (let i = 0; i < n; i++) out[i] *= gain * Math.min(1, i / fade, (n - 1 - i) / fade);
  return out;
}

/** A burst of noise shaped like half a sine, at RMS `rms`. */
function burstOf(sampleRate, ms, rms, seed) {
  const rand = makeRand(seed);
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = rand() * Math.sin((Math.PI * i) / n);
    sum += out[i] ** 2;
  }
  const gain = rms / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function soundOf(sound, sampleRate, rms, seed) {
  if (sound.kind === "cough") {
    // Half noise, over a voiced buzz at 180 Hz that sinks.
    const out = burstOf(sampleRate, sound.ms, rms, seed + 7);
    const voiced = buzzOf(sampleRate, sound.ms, 180, rms, { glide: -3 });
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * out[i] + voiced[i];
    return out;
  }
  if (sound.kind === "child") {
    const parts = [[320, 5], [380, -8], [300, 4]].map(([hz, glide]) => buzzOf(sampleRate, 220, hz, rms, { harmonics: 6, glide }));
    const gap = Math.round(sampleRate * 0.06);
    const out = new Float32Array(parts.reduce((sum, part) => sum + part.length + gap, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length + gap;
    }
    return out;
  }
  if (sound.kind === "noise") return burstOf(sampleRate, sound.ms, rms, seed + 7);
  return buzzOf(sampleRate, sound.ms, sound.hz ?? 220, rms);
}

const mixIn = (out, at, sound) => {
  for (let i = 0; i < sound.length; i++) if (at + i >= 0 && at + i < out.length) out[at + i] += sound[i];
};

/** `samples` as `condition` has it: `{ samples, shiftMs }`, where
 *  `shiftMs` is how much later a moment of the clip now is (the lead-in,
 *  less what `cutMs` took off the front): what timings of the clean clip
 *  must be moved by. "clean" returns the samples. */
export function disturb(samples, sampleRate, condition, seed = 12345) {
  if (condition.key === "clean") return { samples, shiftMs: 0 };
  const ms = (v) => Math.round((sampleRate * v) / 1000);
  const peak = peak10(samples, sampleRate);
  const level = (db) => peak * 10 ** (db / 20);
  const cut = condition.cutMs ? soundSpan(samples, sampleRate, peak)[0] + ms(condition.cutMs) : 0;
  const src = cut ? samples.subarray(cut) : samples;
  const pad = ms(condition.padMs ?? 500);
  // A recording that starts mid-word has no lead-in: its first sample is
  // the cut.
  const lead = cut ? 0 : pad;
  const out = new Float32Array(lead + src.length + pad);
  out.set(src, lead);
  const speech = soundSpan(out, sampleRate, peak);
  if (condition.noiseDb !== null && condition.noiseDb !== undefined) {
    const rand = makeRand(seed);
    // Uniform noise of that RMS.
    const noise = level(condition.noiseDb) * Math.sqrt(3);
    for (let i = 0; i < out.length; i++) out[i] += noise * rand();
  }
  for (const sound of condition.add ?? []) {
    const sig = soundOf(sound, sampleRate, level(sound.db), seed);
    const [from, to] = sound.from === "speech" ? speech : [lead, lead + src.length];
    mixIn(out, sound.where === "before" ? from - ms(sound.gapMs) - sig.length : to + ms(sound.gapMs), sig);
  }
  if (condition.hum) {
    // Mains hum: the fundamental and two harmonics.
    const a = (level(condition.hum.db) * Math.SQRT2) / 1.15;
    const w = (2 * Math.PI * condition.hum.hz) / sampleRate;
    for (let i = 0; i < out.length; i++) out[i] += a * (Math.sin(w * i) + 0.5 * Math.sin(2 * w * i) + 0.25 * Math.sin(3 * w * i));
  }
  if (condition.echo) {
    // A room: 120 reflections 20 to 600 ms late, each softer with its delay.
    const rand = makeRand(seed + 3);
    const dry = Float32Array.from(out);
    for (let t = 0; t < 120; t++) {
      const delay = 20 + Math.abs(rand()) * 580;
      const gain = condition.echo.gain * Math.exp(-delay / condition.echo.tauMs) * (rand() > 0 ? 1 : -1);
      const d = ms(delay);
      for (let i = 0; i + d < out.length; i++) out[i + d] += gain * dry[i];
    }
  }
  return { samples: out, shiftMs: ((lead - cut) / sampleRate) * 1000 };
}

/** disturb()'s samples alone. */
export const surround = (samples, sampleRate, condition, seed = 12345) => disturb(samples, sampleRate, condition, seed).samples;

/* ----------------------------- generated phrases ---------------------------- */

/** Syllables with the given expected tones, as one phrase with no sandhi. */
export const phraseOf = (...tones) => tones.map((t, i) => ({ char: "字", pinyin: withTone("ma", t), baseTone: t, expectedTone: t, accept: [t], half: false, breakBefore: i === 0 }));

/**
 * Three-syllable phrases the cached clips can't express, generated: a
 * last syllable a trim to the speech can take for noise (said short after
 * a beginner's pause, or softly), a sound between the syllables, and a
 * first syllable a 40 ms creak gap breaks in two. `options` go to
 * speak(); `between` is a sound put in the middle of each gap (`own`: at
 * the speaker's own pitch); `split` says the first syllable in two halves;
 * `base` names the case whose verdicts this one is compared with.
 */
export const GENERATED_CASES = Object.freeze([
  { key: "plain", title: "Three syllables 70 ms apart, all alike", options: {} },
  { key: "pause", base: "plain", title: "A 300 ms pause, then a 70 ms last syllable", options: { ms: [260, 260, 70], gaps: [70, 70, 300, 70] } },
  { key: "soft", base: "plain", title: "The last syllable 27 dB under the others", options: { amps: [1, 1, 10 ** (-27 / 20)] } },
  { key: "gap150", title: "Three syllables 150 ms apart", options: { gaps: [70, 150, 150, 70] } },
  { key: "click", base: "gap150", title: "…and a 40 ms pitched click at −10 dB in each gap", options: { gaps: [70, 150, 150, 70] }, between: { ms: 40, db: -10 } },
  { key: "uh", base: "gap150", title: "…and a voiced 60 ms \"uh\" at −20 dB in each gap", options: { gaps: [70, 150, 150, 70] }, between: { ms: 60, db: -20, own: true } },
  { key: "breath", base: "gap150", title: "…and a 100 ms breath at −20 dB in each gap", options: { gaps: [70, 150, 150, 70] }, between: { ms: 100, db: -20, kind: "noise" } },
  { key: "split", title: "The first syllable broken in two by a 40 ms creak gap", split: true, options: { ms: [130, 130, 260, 260], gaps: [70, 40, 70, 70, 70] } },
  { key: "pauseSplit", base: "split", title: "…and a 300 ms pause, then a 70 ms last syllable", split: true, options: { ms: [130, 130, 260, 70], gaps: [70, 40, 70, 300, 70] } },
]);
export const LAST_SYLLABLE_CASES = Object.freeze(GENERATED_CASES.slice(0, 3));
export const GENERATED_VOICES = Object.freeze([{ lowHz: 110, spanSt: 10 }, { lowHz: 90, spanSt: 14 }, { lowHz: 250, spanSt: 12 }]);
export const GENERATED_PHRASES = Object.freeze([[4, 1, 2], [1, 4, 2], [2, 4, 1], [4, 2, 1], [1, 2, 4], [2, 1, 4], [4, 4, 1], [1, 1, 4], [2, 2, 1], [4, 1, 3], [1, 2, 3], [2, 4, 3]]);

const ROOM = NOISE_CONDITIONS.find((c) => c.key === "room");

/** `tones` said by `voice` as `kase` has it, in room noise with half a
 *  second before and after: `{ samples, timings, range }`, the timings one
 *  per syllable, where it really is in `samples`. */
export function sayCase(kase, tones, voice, k = 0) {
  const half = (tone, second) => (x) => CURVES[tone](second ? 0.5 + x / 2 : x / 2);
  const shapes = kase.split ? [half(tones[0], false), half(tones[0], true), ...tones.slice(1)] : tones;
  const said = speak(shapes, { ...voice, ...kase.options, seed: 11 + k });
  const spans = kase.split ? [{ startMs: said.timings[0].startMs, endMs: said.timings[1].endMs }, ...said.timings.slice(2)] : said.timings;
  let samples = said.samples;
  if (kase.between) {
    samples = Float32Array.from(samples);
    const rms = peak10(said.samples, RATE) * 10 ** (kase.between.db / 20);
    for (let i = 0; i + 1 < spans.length; i++) {
      const sig = soundOf({ ...kase.between, hz: kase.between.own ? voice.lowHz * 1.3 : 220 }, RATE, rms, 7 + i);
      mixIn(samples, Math.round((RATE * (spans[i].endMs + spans[i + 1].startMs)) / 2000 - sig.length / 2), sig);
    }
  }
  const d = disturb(samples, RATE, ROOM, 500 + k);
  return { samples: d.samples, timings: spans.map((t) => ({ startMs: t.startMs + d.shiftMs, endMs: t.endMs + d.shiftMs })), range: said.range };
}

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

/* -------------------------------- wrong spans ------------------------------- */

const movedBy = (d) => (spans, totalMs) => [spans.map((t) => ({ startMs: Math.max(0, t.startMs + d), endMs: Math.min(totalMs, t.endMs + d) }))];
const boundaryBy = (d) => (spans) => {
  const out = [];
  for (let b = 0; b + 1 < spans.length; b++) {
    const t = spans.map((x) => ({ ...x }));
    t[b].endMs += d;
    t[b + 1].startMs += d;
    if (t[b].endMs - t[b].startMs >= 45 && t[b + 1].endMs - t[b + 1].startMs >= 45) out.push(t);
  }
  return out;
};

// One span redrawn to end where its neighbour has `leftMs` left (for a
// neighbour shorter than that, the boundary moves the other way).
const swallowNext = (leftMs) => (spans) => {
  const out = [];
  for (let b = 0; b + 1 < spans.length; b++) {
    const next = spans[b + 1];
    out.push(spans.map((x, k) => (k === b ? { startMs: x.startMs, endMs: next.endMs - leftMs } : k === b + 1 ? { startMs: x.endMs - leftMs, endMs: x.endMs } : { ...x })));
  }
  return out;
};
const swallowPrev = (leftMs) => (spans) => {
  const out = [];
  for (let b = 0; b + 1 < spans.length; b++) {
    const prev = spans[b];
    out.push(spans.map((x, k) => (k === b ? { startMs: x.startMs, endMs: x.startMs + leftMs } : k === b + 1 ? { startMs: prev.startMs + leftMs, endMs: x.endMs } : { ...x })));
  }
  return out;
};

/**
 * Ways a recogniser's syllable spans can be wrong while still looking
 * like spans (in order, plausible lengths: timingsProblem passes them),
 * for measuring what the scorer then says. `variants(spans, totalMs)`
 * answers the wrong versions of one clip's spans: one for a shift of the
 * whole set, one per boundary for the rest (none for a single syllable).
 */
export const SPAN_ERRORS = Object.freeze([
  ...[-150, -100, -50, 50, 100, 150].map((d) => ({ key: `shift${d}`, title: `All spans ${Math.abs(d)} ms ${d < 0 ? "early" : "late"}`, variants: movedBy(d) })),
  ...[-100, -50, 50, 100].map((d) => ({ key: `boundary${d}`, title: `One boundary ${Math.abs(d)} ms ${d < 0 ? "early" : "late"}`, variants: boundaryBy(d) })),
  { key: "swallowNext", title: "One span takes all of the next syllable but its last 60 ms", variants: swallowNext(60) },
  { key: "swallowPrev", title: "One span takes all of the syllable before but its first 60 ms", variants: swallowPrev(60) },
  // Off the design: TIMING_RULES' sliver bar is 100 ms, so a neighbour
  // left with more than that is not a "sliver" and has to be caught some
  // other way, or isn't.
  { key: "swallowNext110", title: "…the next syllable but its last 110 ms", variants: swallowNext(110) },
  { key: "swallowNext130", title: "…the next syllable but its last 130 ms", variants: swallowNext(130) },
  { key: "swallowPrev160", title: "…the syllable before but its first 160 ms", variants: swallowPrev(160) },
]);

/* ---------------------------------- flips ---------------------------------- */

/** The same labellings as tallyLabellings, kept per syllable: sets
 *  `into[id|label|syllable]` to `{ side, verdict }` so a disturbed clip
 *  can be compared with the clean one syllable by syllable. Totals hide
 *  flips: one verdict lost and another gained look like nothing. */
export function verdictsOf(into, id, tones, score) {
  score(phraseOf(...tones)).syllables.forEach((s, j) => into.set(`${id}|right|${j}`, { side: "right", verdict: s.verdict }));
  tones.forEach((said, k) => {
    for (const label of [1, 2, 3, 4]) {
      if (label === said) continue;
      const labels = tones.map((t, i) => (i === k ? label : t));
      into.set(`${id}|${label}@${k}|${k}`, { side: "wrong", verdict: score(phraseOf(...labels)).syllables[k].verdict });
    }
  });
  return into;
}

/**
 * What a disturbance did, syllable by syllable: `now` against `base`
 * (maps of `{ side, verdict }` under the same keys; a key `base` lacks is
 * skipped). `falseOff` and `wrongOk` are the two things that must not
 * grow: a correctly said syllable now flagged that wasn't, a wrong tone
 * now passed as ok that wasn't. `lost` is the price that may be paid: a
 * right "ok" or a caught wrong tone that is no longer one.
 */
export function flips(base, now) {
  const out = { right: 0, wrong: 0, caught: 0, falseAlarms: 0, passed: 0, falseOff: 0, wrongOk: 0, lost: 0, keys: { falseOff: [], wrongOk: [] } };
  for (const [key, x] of now) {
    const b = base.get(key);
    if (!b) continue;
    out[x.side]++;
    if (x.side === "wrong") {
      if (x.verdict === "off") out.caught++;
      if (x.verdict === "ok") out.passed++;
      if (x.verdict === "ok" && b.verdict !== "ok") {
        out.wrongOk++;
        out.keys.wrongOk.push(key);
      }
      if (b.verdict === "off" && x.verdict !== "off") out.lost++;
    } else {
      if (x.verdict === "off") out.falseAlarms++;
      if (x.verdict === "off" && b.verdict !== "off") {
        out.falseOff++;
        out.keys.falseOff.push(key);
      }
      if (b.verdict === "ok" && x.verdict !== "ok") out.lost++;
    }
  }
  return out;
}
