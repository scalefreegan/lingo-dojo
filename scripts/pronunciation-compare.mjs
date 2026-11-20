// Compare mode (ld-ne0.9; docs/VOICE.md §Compare mode): the pure half of
// what the server measures for the picture of a take against the model.
//
//  - `takeFrames`: one recording as the compare picture draws it, frame by
//    frame (10 ms): its pitch in semitones about the speaker's own
//    centre (so a low voice and a high one land on the same axis) and its
//    loudness in dB under its loudest frame. Made for the learner's take
//    by the score route (and sent back with the marks, never kept) and
//    for the model's clip by the model route (kept: it isn't personal).
//  - `modelRecord`: what is cached about one model clip, from the engine's
//    result on it: its frames and its syllables, each marked `real` when
//    the clip could be segmented there with confidence (else the page
//    draws the textbook shape for that syllable, and says so).
//
// The rules that compare the two (alignment, tips) are web/shared/
// compare.ts: they run in the page, on what these two replies carry.
//
// Pure ESM with no server imports, like scripts/pronunciation-app.mjs.

/** Loudness floor, dB under the loudest frame: quieter is drawn as silence. */
export const LEVEL_FLOOR_DB = -48;
/** A take's pitch is kept this far around its syllables' spans (ms); the
 *  rest of the recording (the room before and after the words) is drawn
 *  as loudness only: a pitch read from a breath or a knock there would
 *  look like a measurement. */
const SPAN_PAD_MS = 20;
/** The most frames one reply carries: 30 seconds at 10 ms. */
export const MAX_FRAMES = 3_001;

const hzToSt = (hz) => 12 * Math.log2(hz);
const round1 = (v) => Math.round(v * 10) / 10;

function median(values) {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * A recording's frames for the picture: `{ frameMs, pitch, level }`.
 * `track` is a trackPitch result (its `f0`, finished for drawing, and its
 * `rms`). `spans` are the syllables' `{ startMs, endMs }` (nulls allowed):
 * pitch is kept only inside them (± 20 ms). With no usable span, the whole
 * recording counts. Pitch: semitones about the speaker's centre, one
 * decimal, null when unvoiced. Level: whole dB under the loudest frame,
 * floored at LEVEL_FLOOR_DB.
 *
 * The centre is the median of the syllables' own median pitches, one value
 * per voiced syllable, so it doesn't depend on how long each syllable was
 * held: a median of every frame would sit inside whichever syllable lasted
 * longest, and a learner holding 好 in 好吃 a little longer than the model
 * would look higher than the model on 好 with the same pitches. One
 * syllable: its own median. No usable span: the median of every frame.
 */
export function speakerCentre(f0, hopMs, spans) {
  const st = (i) => (f0[i] > 0 ? hzToSt(f0[i]) : null);
  if (!spans.length) {
    const all = [];
    for (let i = 0; i < f0.length; i++) if (st(i) !== null) all.push(st(i));
    return median(all);
  }
  const perSyllable = [];
  for (const s of spans) {
    const own = [];
    for (let i = Math.max(0, Math.ceil(s.startMs / hopMs)); i * hopMs < s.endMs && i < f0.length; i++) if (st(i) !== null) own.push(st(i));
    if (own.length) perSyllable.push(median(own));
  }
  return median(perSyllable);
}

export function takeFrames(track, spans = []) {
  const hopMs = Number(track?.hopMs) || 10;
  const f0 = track?.f0 ?? [];
  const rms = track?.rms ?? [];
  const n = Math.min(f0.length, MAX_FRAMES);
  const usable = (Array.isArray(spans) ? spans : []).filter((s) => s && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs);
  const inside = (i) => !usable.length || usable.some((s) => i * hopMs >= s.startMs - SPAN_PAD_MS && i * hopMs <= s.endMs + SPAN_PAD_MS);
  const centre = speakerCentre(Array.prototype.slice.call(f0, 0, n), hopMs, usable);
  const pitch = [];
  let loudest = 0;
  for (let i = 0; i < n; i++) loudest = Math.max(loudest, rms[i] || 0);
  const level = [];
  for (let i = 0; i < n; i++) {
    pitch.push(Number.isFinite(centre) && f0[i] > 0 && inside(i) ? round1(hzToSt(f0[i]) - centre) : null);
    const r = rms[i] || 0;
    level.push(loudest > 0 && r > 0 ? Math.max(LEVEL_FLOOR_DB, Math.round(20 * Math.log10(r / loudest))) : LEVEL_FLOOR_DB);
  }
  return { frameMs: hopMs, pitch, level };
}

/** Whether a scored model syllable can be drawn from the clip itself: a
 *  span the engine could time, and a tone it heard as the expected one
 *  ("ok"), or a neutral syllable (never judged) with voice in it. An
 *  "off" (the voice said another reading) or any "unsure" falls back to
 *  the textbook shape. */
export function modelSyllableReal(s, frames) {
  if (!s || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.endMs <= s.startMs) return false;
  if (s.verdict === "ok") return true;
  if (s.verdict === "unsure" && s.reason === "neutral" && frames) {
    const from = Math.floor(s.startMs / frames.frameMs);
    const to = Math.ceil(s.endMs / frames.frameMs);
    let v = 0;
    for (let i = from; i < to && i < frames.pitch.length; i++) if (frames.pitch[i] !== null) v++;
    return v >= 6;
  }
  return false;
}

/** Bumped when what a cached model record means changes: an old one is
 *  then not served. Where it holds Azure's spans it is read again on them,
 *  with no new call (priorAzureSpans, reusedRecord); otherwise the clip gets
 *  one fresh Azure call under the new version's own ledger
 *  (scripts/model-analysis.mjs). 3: the scorer's noise guards (ld-ne0.7)
 *  can change a model syllable's verdict, and so its `saidTone`. */
export const MODEL_RECORD_VERSION = 3;

/**
 * The spans an older version's record holds from Azure, if they can be
 * read again: `{ v, spans, real }` (the version, each syllable's span on
 * the clip's own times, and whether that syllable was drawn from the clip
 * then), or null. Only a record Azure timed ("azure", "used"), for the
 * same characters (`chars`, the clip's now), each span inside the clip and
 * in order. Not a whole record: what the scorer says on those spans is
 * what changed.
 */
export function priorAzureSpans(r, chars) {
  if (!r || !Number.isInteger(r.v) || r.v < 1 || r.v >= MODEL_RECORD_VERSION || r.engine !== "azure" || r.azure !== "used") return null;
  if (!Number.isFinite(r.durationMs) || !Array.isArray(r.syllables) || !r.syllables.length || r.syllables.length !== chars.length) return null;
  const spans = [];
  for (const [i, s] of r.syllables.entries()) {
    if (!s || s.char !== chars[i] || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) return null;
    if (s.startMs < 0 || s.endMs <= s.startMs || s.startMs >= r.durationMs || (i && s.startMs < spans[i - 1].startMs)) return null;
    spans.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return { v: r.v, spans, real: r.syllables.map((s) => s.real === true) };
}

/** Spans on a clip's own times moved onto the padded clip's (padSamples):
 *  what the scorer is given when it reads an older record's spans again. */
export function padSpans(spans, ms = MODEL_PAD_MS) {
  return spans.map((s) => ({ startMs: s.startMs + ms, endMs: s.endMs + ms }));
}

/**
 * A record made on an older record's Azure spans (priorAzureSpans): timed
 * by Azure still ("azure", "used"; no call was made for it) and marked
 * `spansFrom`, the version the spans came from. A syllable is drawn from
 * the clip only where this reading says so AND the old record did: the old
 * one doesn't say why it didn't, and Azure's own objections (a word it
 * heard left out, or said badly) are not in it otherwise.
 */
export function reusedRecord(record, prior) {
  return {
    ...record,
    engine: "azure",
    azure: "used",
    spansFrom: prior.v,
    syllables: record.syllables.map((s, i) => {
      if (s.real && prior.real[i]) return s;
      const { saidTone: _drawnOnly, ...rest } = s;
      return { ...rest, real: false };
    }),
  };
}

/** Silence put around a model clip before it is analysed (ms). A voice's
 *  clip starts with its first sound: the scorer would call that syllable
 *  "clipped" (a recording loud in its first 20 ms began mid-word), and a
 *  lone short character (大 from macOS `say` is about 230 ms) is under the
 *  scorer's 250 ms minimum. The record is shifted back afterwards
 *  (`unpadRecord`), so its times are the clip's own, as the page plays it. */
export const MODEL_PAD_MS = 250;

/** `samples` with `ms` of silence before and after. */
export function padSamples(samples, sampleRate, ms = MODEL_PAD_MS) {
  const pad = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(samples.length + 2 * pad);
  out.set(samples, pad);
  return out;
}

/** A record made on a padded clip, on the clip's own times: spans moved
 *  back by the pad, the pad's frames dropped, the length the clip's. */
export function unpadRecord(record, ms = MODEL_PAD_MS) {
  const step = record.frames.frameMs;
  const drop = Math.round(ms / step);
  const keep = Math.max(0, Math.round((record.durationMs - 2 * ms) / step) + 1);
  const shift = (v) => (v === null ? null : Math.max(0, v - ms));
  return {
    ...record,
    durationMs: Math.max(0, Math.round(record.durationMs - 2 * ms)),
    frames: { frameMs: step, pitch: record.frames.pitch.slice(drop, drop + keep), level: record.frames.level.slice(drop, drop + keep) },
    syllables: record.syllables.map((x) => ({ ...x, startMs: shift(x.startMs), endMs: shift(x.endMs) })),
  };
}

/**
 * What is kept about one model clip: the engine that timed it ("azure" or
 * "local"), its length, its frames, and per syllable the reading, the
 * span and `real`. `azure` says what happened with Azure for this clip:
 * "used" (it answered), "spent" (a call was made and failed, or one was
 * made before: never again for this clip) or "skipped" (no call was made:
 * no keys, a malformed region, the per-minute cap, busy). A skipped record
 * refused by the cap or a busy slot carries `retryAt` (model-analysis.mjs:
 * not tried again before then). One read again on an older record's Azure
 * spans carries `spansFrom` (reusedRecord).
 */
export function modelRecord({ result, frames, syllables, durationMs, azure }) {
  return {
    v: MODEL_RECORD_VERSION,
    engine: result?.provider === "azure" ? "azure" : "local",
    azure,
    durationMs: Math.round(durationMs),
    frames,
    syllables: syllables.map((x, i) => {
      const s = result?.syllables?.[i];
      const real = modelSyllableReal(s, frames);
      return {
        char: x.char,
        pinyin: x.pinyin,
        expectedTone: x.expectedTone,
        startMs: s && Number.isFinite(s.startMs) ? Math.round(s.startMs) : null,
        endMs: s && Number.isFinite(s.endMs) ? Math.round(s.endMs) : null,
        real,
        // The tone heard, on an "ok": where several tones count, compare
        // mode reads a learner's curve against the model's only when both
        // said the same one.
        ...(s?.verdict === "ok" && Number.isInteger(s.heardTone) ? { saidTone: s.heardTone } : {}),
      };
    }),
  };
}

/** Whether a parsed JSON value is a model record this version wrote. */
export function isModelRecord(r) {
  return (
    !!r && r.v === MODEL_RECORD_VERSION && (r.engine === "azure" || r.engine === "local") && ["used", "spent", "skipped"].includes(r.azure) &&
    Number.isFinite(r.durationMs) && !!r.frames && Array.isArray(r.frames.pitch) && Array.isArray(r.frames.level) && Array.isArray(r.syllables) &&
    (r.retryAt === undefined || Number.isFinite(r.retryAt)) &&
    (r.spansFrom === undefined || (Number.isInteger(r.spansFrom) && r.spansFrom >= 1 && r.spansFrom < r.v && r.engine === "azure"))
  );
}
