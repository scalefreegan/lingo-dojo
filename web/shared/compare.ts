// Compare mode's rules (ld-ne0.9; docs/VOICE.md §Compare mode): the
// learner's take against the model clip, syllable by syllable. Pure,
// erasable TypeScript with no imports beyond types, so the page runs it on
// the two replies it already holds (the take's marks and frames, the
// model's analysis) and `node --test` imports it directly.
//
//  - `alignTakes`: both recordings on one time axis, the learner's. With
//    `warp` the model is stretched syllable by syllable onto the learner's
//    spans (a piecewise-linear map through every syllable's start and end),
//    so different speaking speeds line up; without it the model is only
//    shifted so the first syllables start together (real lengths).
//  - `syllableShape`: what one syllable's pitch does, from its frames.
//  - `compareTips`: plain sentences about the differences, only when
//    confident, at most a few, the most useful first.
//
// Thresholds are COMPARE_RULES, in semitones about each speaker's own
// centre (pronunciation-compare.mjs takeFrames), chosen cautiously and on
// synthesized voices only: see docs/VOICE.md §Compare mode for how. The
// tone scorer and its thresholds are not touched: these rules only explain
// a verdict the scorer already gave (an "off"), or, for an "ok", a
// difference much larger than the ones they act on; an "unsure" gets none.

import type { PronunciationFrames, PronunciationModelSyllable, PronunciationSyllable } from "./wire.ts";

export const COMPARE_RULES = Object.freeze({
  // A syllable's curve is read only with this many voiced frames (10 ms),
  // covering this share of its span (the scorer's own minimum is 6).
  minFrames: 6,
  minCoverage: 0.5,
  // The edges of a span (this share at each end) are left out: consonant
  // transitions and the neighbour's pitch sit there.
  edge: 0.08,
  // An "ok" syllable gets a tip only when every gap below is this many
  // times larger (and every share this much smaller) than for an "off".
  okFactor: 1.6,
  // Tone 4: the model must fall at least `fallModelMin`; yours under
  // `fallShare` of it and `fallGap` short. "Start higher" when your start
  // sits `startGap` lower (against your own centre) than the model's.
  fallModelMin: 5,
  fallShare: 0.6,
  fallGap: 3,
  startGap: 2,
  // Tone 1: the model within `levelModelMax` of level; yours moving
  // `levelMove` from start to end (the scorer rules a first tone out at 3).
  levelModelMax: 2.5,
  levelMove: 3,
  // …and, in a phrase, sitting `lowGap` lower than the model's in the voice.
  lowGap: 3.5,
  // Tone 2: the model rising at least `riseModelMin`; yours under
  // `riseShare` of it and `riseGap` short. Late: your climb begins after
  // `lateAt` of the syllable while the model's begins before `lateModelAt`,
  // and yours does rise (`lateRiseMin`).
  riseModelMin: 4,
  riseShare: 0.5,
  riseGap: 3,
  lateAt: 0.65,
  lateModelAt: 0.45,
  lateRiseMin: 1.5,
  // Tone 3: the model dipping at least `dipModelMin` from its start; yours
  // under `dipShare` of it and `dipGap` short.
  dipModelMin: 2.5,
  dipShare: 0.5,
  dipGap: 2.5,
  // A half third (before another tone) is low, not a dip: its mean against
  // the speaker's own centre, against the model's. The model must sit at
  // least `halfModelLow` under its centre, and yours `halfGap` higher than
  // the model's. How far either moves inside the syllable is not read.
  halfModelLow: 2,
  halfGap: 3,
  // Height (a half third sitting high, a first tone sitting low) is read
  // only when the take and the model each have this many syllables with a
  // readable curve. A speaker's centre is the median of the syllables'
  // own pitches (pronunciation-compare.mjs speakerCentre): with two, it is
  // just halfway between them, so each sits half the interval above or
  // below it and a height tip couldn't tell which of the two was off (a
  // first tone said too low reads as the third tone beside it said too
  // high). From three, the median is one of the syllables themselves.
  heightMinSyllables: 3,
  // Length, as a share of the whole take against the model's share (so
  // speaking slower overall is not "too long"); a lone syllable by its
  // length alone. Under `shortShare` or over `longShare` of the model's.
  shortShare: 0.55,
  longShare: 1.8,
  shortAlone: 0.45,
  longAlone: 2.2,
  minModelMs: 120,
  // Carried over: an "off" heard as the previous syllable's tone, starting
  // within `carryJoin` of where the previous one ended, while the model
  // moves at least `carryModelJump` between the two.
  carryJoin: 1.5,
  carryModelJump: 2.5,
  maxTips: 3,
  kidsMaxTips: 1,
});
export type CompareRules = typeof COMPARE_RULES;

/* --------------------------------- frames --------------------------------- */

/** The frames of `[startMs, endMs)`, or [] without a usable span. */
export function framesIn(frames: PronunciationFrames | null | undefined, startMs: number | null, endMs: number | null): (number | null)[] {
  if (!frames || startMs === null || endMs === null || !(endMs > startMs)) return [];
  const from = Math.max(0, Math.round(startMs / frames.frameMs));
  const to = Math.min(frames.pitch.length, Math.round(endMs / frames.frameMs));
  return frames.pitch.slice(from, Math.max(from, to));
}

/** What a syllable's pitch does (semitones about the speaker's centre). */
export interface SyllableShape {
  /** Voiced frames read, and their share of the span. */
  voiced: number;
  coverage: number;
  /** The mean of the first and last quarters; the top and bottom; where
   *  the bottom is (0 the start, 1 the end). */
  head: number;
  tail: number;
  top: number;
  bottom: number;
  bottomAt: number;
  /** How far it falls from its highest point in the first half to the
   *  end; rises from its lowest point (before the last 15%) to the end;
   *  dips from its highest point before the bottom to the bottom. */
  fall: number;
  rise: number;
  dip: number;
  /** Where the climb to the end really begins: the last point still within
   *  a quarter of the rise above the low (0 to 1; 0 with no rise). */
  climbAt: number;
  /** Its mean (how high it sits in the voice) and its spread. */
  mean: number;
  spread: number;
}

const median3 = (a: number | null, b: number | null, c: number | null): number | null => {
  if (b === null) return null;
  const v = [a, b, c].filter((x): x is number => x !== null).sort((x, y) => x - y);
  return v[v.length >> 1];
};

/** The shape of one syllable's frames, or null when too little of it is
 *  voiced to say (the same caution as the marks: then nothing is said). */
export function syllableShape(points: (number | null)[], rules: CompareRules = COMPARE_RULES): SyllableShape | null {
  const n = points.length;
  if (n < rules.minFrames) return null;
  const cut = Math.floor(n * rules.edge);
  const pts: { x: number; v: number }[] = [];
  for (let i = cut; i < n - cut; i++) {
    const v = median3(points[i - 1] ?? null, points[i], points[i + 1] ?? null);
    if (v !== null && Number.isFinite(v)) pts.push({ x: n > 1 ? i / (n - 1) : 0, v });
  }
  const coverage = pts.length / Math.max(1, n - 2 * cut);
  if (pts.length < rules.minFrames || coverage < rules.minCoverage) return null;
  const mean = (a: { v: number }[]) => a.reduce((s, p) => s + p.v, 0) / a.length;
  const first = pts.filter((p) => p.x <= 0.25);
  const last = pts.filter((p) => p.x >= 0.75);
  const head = first.length ? mean(first) : pts[0].v;
  const tail = last.length ? mean(last) : pts[pts.length - 1].v;
  let top = -Infinity;
  let bottom = Infinity;
  let bottomAt = 0;
  for (const p of pts) {
    if (p.v > top) top = p.v;
    if (p.v < bottom) {
      bottom = p.v;
      bottomAt = p.x;
    }
  }
  const early = pts.filter((p) => p.x <= 0.5);
  const peakEarly = early.length ? Math.max(...early.map((p) => p.v)) : head;
  const before = pts.filter((p) => p.x <= 0.85);
  const lowBefore = before.length ? Math.min(...before.map((p) => p.v)) : bottom;
  const rise = tail - lowBefore;
  let climbAt = 0;
  if (rise > 0) for (const p of pts) if (p.x <= 0.95 && p.v <= lowBefore + 0.25 * rise) climbAt = p.x;
  return {
    voiced: pts.length,
    coverage: round2(coverage),
    head: round2(head),
    tail: round2(tail),
    top: round2(top),
    bottom: round2(bottom),
    bottomAt: round2(bottomAt),
    fall: round2(peakEarly - tail),
    rise: round2(rise),
    dip: round2(Math.max(...pts.filter((p) => p.x <= bottomAt).map((p) => p.v)) - bottom),
    climbAt: round2(climbAt),
    mean: round2(mean(pts)),
    spread: round2(top - bottom),
  };
}

/* -------------------------------- alignment ------------------------------- */

export interface Span {
  startMs: number | null;
  endMs: number | null;
}

/** Monotonic anchor pairs [learner ms, model ms] through each syllable both
 *  takes timed; a pair that would run backwards on either side is left
 *  out (the map stays a map). */
export function warpAnchors(mine: Span[], model: Span[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < Math.min(mine.length, model.length); i++) {
    const a = mine[i];
    const b = model[i];
    if (a.startMs === null || a.endMs === null || b.startMs === null || b.endMs === null) continue;
    if (!(a.endMs > a.startMs) || !(b.endMs > b.startMs)) continue;
    for (const pair of [[a.startMs, b.startMs], [a.endMs, b.endMs]] as [number, number][]) {
      const last = out[out.length - 1];
      if (last && (pair[0] <= last[0] || pair[1] <= last[1])) continue;
      out.push(pair);
    }
  }
  return out;
}

/** The model time for learner time `t` through `anchors` (piecewise
 *  linear; slope 1 past either end; the identity with none). */
export function mapThrough(anchors: [number, number][], t: number): number {
  if (!anchors.length) return t;
  if (t <= anchors[0][0]) return anchors[0][1] + (t - anchors[0][0]);
  const last = anchors[anchors.length - 1];
  if (t >= last[0]) return last[1] + (t - last[0]);
  for (let k = 1; k < anchors.length; k++) {
    const [a0, b0] = anchors[k - 1];
    const [a1, b1] = anchors[k];
    if (t <= a1) return b0 + ((t - a0) / (a1 - a0)) * (b1 - b0);
  }
  return t;
}

/** The learner time for model time `m`: the inverse of mapThrough. */
export function mapBack(anchors: [number, number][], m: number): number {
  return mapThrough(anchors.map(([a, b]) => [b, a] as [number, number]), m);
}

/** The textbook shape of a tone on Chao's five-level scale, placed in the
 *  voice (level 3 is the speaker's centre, one level `stepSt` semitones;
 *  the scorer's own step), at `points` points. Null for the neutral tone. */
export function textbookCurve(tone: number, half: boolean, points: number, stepSt = 2.5): number[] | null {
  const levels = tone === 3 && half ? [2, 1, 1] : ({ 1: [5, 5], 2: [3, 5], 3: [2, 1, 4], 4: [5, 1] } as Record<number, number[]>)[tone];
  if (!levels || points < 2) return null;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * (levels.length - 1);
    const k = Math.min(levels.length - 2, Math.floor(x));
    out.push(round2((levels[k] + (levels[k + 1] - levels[k]) * (x - k) - 3) * stepSt));
  }
  return out;
}

export interface ModelInput {
  frames: PronunciationFrames;
  syllables: PronunciationModelSyllable[];
  durationMs: number;
}

export interface AlignedTakes {
  /** The axis: learner time (ms) from `fromMs` to `toMs`, one point per frame. */
  fromMs: number;
  toMs: number;
  stepMs: number;
  t: number[];
  mine: { pitch: (number | null)[]; level: number[] };
  /** The model on the learner's axis. `pitch` is null across a syllable
   *  whose clip couldn't be read with confidence; `textbook` holds the
   *  tone's shape there instead (and null elsewhere). Without a model at
   *  all, every syllable has its textbook shape and `level` is empty. */
  model: { pitch: (number | null)[]; level: number[]; textbook: (number | null)[] };
  /** Each syllable's band on the axis (the learner's span); `modelFromMs`
   *  and `modelToMs` are the model's span mapped onto the axis (the same
   *  as the band when warped). `real` is the model's flag. */
  bands: { i: number; fromMs: number; toMs: number; modelFromMs: number | null; modelToMs: number | null; real: boolean }[];
  warped: boolean;
}

const PAD_MS = 200;

/**
 * Both takes on the learner's time axis. `mine` is the take's marks and
 * frames, `model` the model's analysis (null: none, the textbook shapes
 * stand in). `warp` stretches the model per syllable onto the learner's
 * spans; else the model is only shifted so the first syllables start
 * together, and the axis is long enough for both.
 */
export function alignTakes({ mine, frames, model, warp = true }: { mine: PronunciationSyllable[]; frames: PronunciationFrames; model: ModelInput | null; warp?: boolean }): AlignedTakes {
  const step = frames.frameMs;
  const mineEnd = frames.pitch.length * step;
  const timed = mine.filter((s) => s.startMs !== null && s.endMs !== null && s.endMs > s.startMs);
  const firstMine = timed.length ? timed[0].startMs! : 0;
  const lastMine = timed.length ? timed[timed.length - 1].endMs! : mineEnd;
  const modelSyl = model?.syllables ?? [];
  const modelTimed = modelSyl.filter((s) => s.startMs !== null && s.endMs !== null && s.endMs! > s.startMs!);
  let anchors: [number, number][];
  if (model && warp) anchors = warpAnchors(mine, modelSyl);
  else if (model && modelTimed.length && timed.length) anchors = [[firstMine, modelTimed[0].startMs!]];
  else anchors = [];
  const warped = !!model && warp && anchors.length >= 2;
  // Without two anchors the warp has nothing to stretch: a shift.
  if (model && warp && anchors.length < 2) anchors = modelTimed.length && timed.length ? [[firstMine, modelTimed[0].startMs!]] : [];
  const toModel = (t: number) => mapThrough(anchors, t);
  const toMine = (m: number) => mapBack(anchors, m);

  let fromMs = Math.max(0, firstMine - PAD_MS);
  let toMs = Math.min(mineEnd, lastMine + PAD_MS);
  if (model && !warped && modelTimed.length) {
    // Real lengths: room for the model's last syllable too.
    toMs = Math.max(toMs, toMine(modelTimed[modelTimed.length - 1].endMs! + PAD_MS));
    fromMs = Math.max(0, Math.min(fromMs, toMine(Math.max(0, modelTimed[0].startMs! - PAD_MS))));
  }
  fromMs = Math.floor(fromMs / step) * step;
  const t: number[] = [];
  for (let x = fromMs; x <= toMs; x += step) t.push(x);

  const at = (f: PronunciationFrames, ms: number) => {
    const i = Math.round(ms / f.frameMs);
    return i >= 0 && i < f.pitch.length ? i : -1;
  };
  const minePitch = t.map((x) => {
    const i = at(frames, x);
    return i < 0 ? null : frames.pitch[i];
  });
  const mineLevel = t.map((x) => {
    const i = at(frames, x);
    return i < 0 ? -48 : frames.level[i];
  });

  const bands = mine.map((s, i) => {
    const m = modelSyl[i];
    const mFrom = m && m.startMs !== null ? (warped ? null : toMine(m.startMs)) : null;
    const mTo = m && m.endMs !== null ? (warped ? null : toMine(m.endMs)) : null;
    return {
      i,
      fromMs: s.startMs ?? NaN,
      toMs: s.endMs ?? NaN,
      modelFromMs: warped ? s.startMs : mFrom,
      modelToMs: warped ? s.endMs : mTo,
      // The model's own curve is drawn wherever the clip was read with
      // confidence, even where the learner said another reading of a card
      // character (the model says the usual one): it is still the model.
      real: !!m?.real,
    };
  });

  const modelPitch: (number | null)[] = t.map(() => null);
  const modelLevel: number[] = model ? t.map(() => -48) : [];
  const textbook: (number | null)[] = t.map(() => null);
  if (model) {
    t.forEach((x, k) => {
      const i = at(model.frames, toModel(x));
      if (i < 0) return;
      modelPitch[k] = model.frames.pitch[i];
      modelLevel[k] = model.frames.level[i];
    });
  }
  // Where the model's own curve can't be trusted (or there is no model),
  // its pitch is blanked over the band and the textbook shape drawn.
  for (const b of bands) {
    const s = mine[b.i];
    const m = modelSyl[b.i];
    const tone = m ? m.expectedTone : s.expectedTone;
    const from = b.real ? NaN : (b.modelFromMs ?? b.fromMs);
    const to = b.real ? NaN : (b.modelToMs ?? b.toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) continue;
    const idx = t.map((x, k) => (x >= from && x < to ? k : -1)).filter((k) => k >= 0);
    // The textbook shape of what the model says there (the usual reading).
    const shape = textbookCurve(tone, tone === s.expectedTone && !!s.half, idx.length);
    idx.forEach((k, j) => {
      modelPitch[k] = null;
      textbook[k] = shape ? shape[j] : null;
    });
  }
  return { fromMs, toMs, stepMs: step, t, mine: { pitch: minePitch, level: mineLevel }, model: { pitch: modelPitch, level: modelLevel, textbook }, bands, warped };
}

/* ----------------------------------- tips ---------------------------------- */

export type TipKind = "fall_small" | "level_moves" | "level_low" | "rise_small" | "rise_late" | "dip_shallow" | "half_high" | "short" | "long" | "carried" | "sound" | "tone";

export interface Tip {
  /** The syllable it is about (its index in the take). */
  syllable: number;
  kind: TipKind;
  text: string;
  /** How useful: larger first. */
  weight: number;
}

const TONE_WORD: Record<number, string> = { 1: "high level", 2: "rising", 3: "dipping", 4: "falling" };
const TONE_DO: Record<number, string> = { 1: "stay high and level", 2: "rise", 3: "dip low", 4: "fall" };
const KID_SHAPES: Record<number, string> = { 1: "stays up high, like a long beep", 2: "goes up, like asking a question", 3: "dips down low and comes back up", 4: "goes down, like a slide" };

function asFar(share: number): string {
  if (share < 0.2) return "hardly at all";
  if (share < 0.4) return "about a third as far";
  if (share < 0.6) return "about half as far";
  return "about two thirds as far";
}

interface Candidate {
  kind: TipKind;
  weight: number;
  text: string;
  kid: string;
}

export interface TipInput {
  mine: PronunciationSyllable[];
  frames: PronunciationFrames;
  model: ModelInput | null;
  kids?: boolean;
  /** How a syllable is named in a sentence: "是 (shì)", in the profile's aid. */
  name?: (i: number) => string;
  rules?: CompareRules;
}

/**
 * The tips for one take: at most `maxTips` (one for kids), one per
 * syllable, the most useful first. A syllable gets none when it is
 * "unsure"; an "ok" one only on a difference `okFactor` times larger than
 * an "off" needs; the curve rules need the model's own curve there
 * (`real`), and none of them run for the neutral tone or for a card
 * character said in another of its readings (`usual`: the model said the
 * usual one). Kids get tips only on an "off", in gentler words.
 */
export function compareTips({ mine, frames, model, kids = false, name = (i) => mine[i]?.char ?? "", rules = COMPARE_RULES }: TipInput): Tip[] {
  const shapes = mine.map((s) => syllableShape(framesIn(frames, s.startMs, s.endMs), rules));
  // The tone a syllable's curve is read against, or null for none. Where
  // one tone is accepted, the expected one. Where several are (我 before
  // 很 takes 2 or 3; 一 and 不; a card character's readings), only an "ok"
  // whose reply names the tone heard (`saidTone`), and only when the model
  // was heard saying that same tone: else the learner and the model may
  // simply have said two right tones, and comparing them would call a
  // right answer wrong.
  const curveTone = mine.map((s, i) => {
    const m = model?.syllables[i];
    if (!m || !m.real || s.usual) return null;
    if (s.accept.length <= 1) return m.expectedTone === s.expectedTone ? s.expectedTone : null;
    return s.verdict === "ok" && Number.isInteger(s.saidTone) && m.saidTone === s.saidTone ? s.saidTone! : null;
  });
  const modelShapes = mine.map((_, i) => (curveTone[i] !== null ? syllableShape(framesIn(model!.frames, model!.syllables[i].startMs, model!.syllables[i].endMs), rules) : null));
  const spanOf = (x: { startMs: number | null; endMs: number | null } | undefined) => (x && x.startMs !== null && x.endMs !== null && x.endMs > x.startMs ? x.endMs - x.startMs : null);
  const total = (list: ({ startMs: number | null; endMs: number | null } | undefined)[]) => list.reduce((a, x) => a + (spanOf(x) ?? 0), 0);
  // Lengths are compared only on spans the model was timed with confidence
  // in (`real`): a stand-in span says nothing about how long the model is.
  const allTimed = model && mine.every((s, i) => spanOf(s) !== null && spanOf(model.syllables[i]) !== null && model.syllables[i].real);
  // Enough syllables, on both sides, for a height about the centre to mean
  // something (`heightMinSyllables`).
  const modelReadable = model ? model.syllables.filter((m) => m.real && syllableShape(framesIn(model.frames, m.startMs, m.endMs), rules)).length : 0;
  const heights = shapes.filter(Boolean).length >= rules.heightMinSyllables && modelReadable >= rules.heightMinSyllables;
  const mineTotal = total(mine);
  const modelTotal = model ? total(model.syllables) : 0;
  const phrase = mine.length > 1;

  const picked: Tip[] = [];
  mine.forEach((s, i) => {
    if (s.verdict === "unsure") return;
    if (kids && s.verdict !== "off") return;
    const ok = s.verdict === "ok";
    const f = ok ? rules.okFactor : 1;
    const n = name(i);
    const L = shapes[i];
    const M = modelShapes[i];
    const tone = s.expectedTone;
    const cands: Candidate[] = [];

    // Azure says the sound itself was off (only ever on an "off").
    if (s.verdict === "off" && s.why === "sound") {
      const score = Number.isFinite(s.soundScore) ? ` (Azure scored the syllable ${s.soundScore} of 100)` : "";
      cands.push({
        kind: "sound",
        weight: 2.2,
        text: `${n}: the sound itself seemed off, not only the tone${score}. Azure scores the whole syllable, so it can't tell whether it was the consonant or the vowel: listen to the model for both.`,
        kid: `Listen to how ${n} sounds and copy it!`,
      });
    }

    // Carried over from the syllable before.
    const prev = i > 0 ? mine[i - 1] : null;
    // The tone the previous syllable was said in: its expected one where
    // only that counts, else the one its reply says was heard (an ok's
    // `saidTone`); where several count and none is named, no carried tip.
    const prevTone = !prev ? null : prev.accept.length <= 1 ? prev.expectedTone : prev.verdict === "ok" && Number.isInteger(prev.saidTone) ? prev.saidTone! : null;
    if (s.verdict === "off" && s.why !== "sound" && prev && prevTone !== null && prev.verdict !== "unsure" && prevTone !== tone && s.heardTone === prevTone && L && shapes[i - 1]) {
      const join = Math.abs(L.head - shapes[i - 1]!.tail);
      const Mp = modelShapes[i - 1];
      const modelJump = M && Mp ? Math.abs(M.head - Mp.tail) : null;
      if (join <= rules.carryJoin && (modelJump === null || modelJump >= rules.carryModelJump) && TONE_WORD[prevTone] && TONE_DO[tone]) {
        cands.push({
          kind: "carried",
          weight: 2.5,
          text: `${n} carries on the ${TONE_WORD[prevTone]} pitch of ${name(i - 1)} before it. Reset between the two: ${n} should ${TONE_DO[tone]}.`,
          kid: `Start ${n} fresh: it ${KID_SHAPES[tone]}.`,
        });
      }
    }

    // The curve against the model's own curve (`curveTone`: null when
    // there is no one tone to read it against).
    const ct = curveTone[i];
    if (L && M && ct !== null && ct >= 1 && ct <= 4) {
      const tone = ct;
      if (tone === 4 && M.fall >= rules.fallModelMin) {
        const share = Math.max(0, L.fall) / M.fall;
        const gap = M.fall - L.fall;
        if (share <= rules.fallShare / f && gap >= rules.fallGap * f) {
          const higher = phrase && M.head - L.head >= rules.startGap * f;
          cands.push({
            kind: "fall_small",
            weight: gap / (rules.fallGap * f),
            text: `${n}: the fall is too small. ${higher ? "Start higher and drop further" : "Drop further"}, as the model does: yours falls ${asFar(share)}.`,
            kid: `Make ${n} slide down further, from up high to down low!`,
          });
        }
      }
      if (tone === 1 && Math.abs(M.tail - M.head) <= rules.levelModelMax) {
        const move = L.tail - L.head;
        if (Math.abs(move) >= rules.levelMove * f) {
          cands.push({
            kind: "level_moves",
            weight: Math.abs(move) / (rules.levelMove * f),
            text: `${n} should stay level, but yours ${move > 0 ? "rises" : "drops"} through it. Hold it steady near the top of your voice, as the model does.`,
            kid: `Keep ${n} up high and flat, like a long beep!`,
          });
        }
        if (phrase && heights && M.mean - L.mean >= rules.lowGap * f) {
          cands.push({
            kind: "level_low",
            weight: (M.mean - L.mean) / (rules.lowGap * f),
            text: `${n} sits low in your voice, while the model says it near the top of its range. Start it higher.`,
            kid: `Say ${n} up high, like a long beep!`,
          });
        }
      }
      if (tone === 2 && M.rise >= rules.riseModelMin) {
        const share = Math.max(0, L.rise) / M.rise;
        const gap = M.rise - L.rise;
        if (share <= rules.riseShare / f && gap >= rules.riseGap * f) {
          cands.push({
            kind: "rise_small",
            weight: gap / (rules.riseGap * f),
            text: `${n}: the rise is too small. Let it climb further at the end, as the model does: yours rises ${asFar(share)}.`,
            kid: `Make ${n} go up higher at the end, like asking a question!`,
          });
        } else if (L.climbAt >= Math.min(0.9, rules.lateAt * (ok ? 1.15 : 1)) && M.climbAt <= rules.lateModelAt && L.rise >= rules.lateRiseMin) {
          cands.push({
            kind: "rise_late",
            weight: 1 + (L.climbAt - rules.lateAt),
            text: `${n}: the rise starts too late. Begin climbing sooner: yours stays low for most of the syllable.`,
            kid: `Make ${n} start going up sooner!`,
          });
        }
      }
      // A half third is read by how low it sits, never by how far it moves:
      // a learner low and level against a model falling into the low is right.
      const half = tone === 3 && tone === s.expectedTone && !!s.half;
      if (half && heights && -M.mean >= rules.halfModelLow) {
        const gap = L.mean - M.mean;
        if (gap >= rules.halfGap * f) {
          cands.push({
            kind: "half_high",
            weight: gap / (rules.halfGap * f),
            text: `${n} sits too high in your voice. Before another tone a third tone is just low: let your voice drop to the bottom of its range and stay there, as the model does.`,
            kid: `Say ${n} down low, like a sleepy bear!`,
          });
        }
      } else if (tone === 3 && !half && M.dip >= rules.dipModelMin) {
        const share = Math.max(0, L.dip) / M.dip;
        const gap = M.dip - L.dip;
        if (share <= rules.dipShare / f && gap >= rules.dipGap * f) {
          cands.push({
            kind: "dip_shallow",
            weight: gap / (rules.dipGap * f),
            text: `${n}: the dip doesn't go low enough. Let your voice drop to the bottom of its range before it comes back up.`,
            kid: `Let ${n} dip down really low!`,
          });
        }
      }
    }

    // Length against the model's (a share of the whole take in a phrase).
    const mineMs = spanOf(s);
    const modelMs = spanOf(model?.syllables[i]);
    // A lone syllable that was right gets none: a learner holding a single
    // character to hear it is not saying it wrong, and a voice's lone
    // character is clipped short.
    if (allTimed && mineMs !== null && modelMs !== null && modelMs >= rules.minModelMs && tone !== 0 && (phrase || !ok)) {
      const ratio = phrase ? mineMs / mineTotal / (modelMs / modelTotal) : mineMs / modelMs;
      const short = (phrase ? rules.shortShare : rules.shortAlone) / f;
      const long = (phrase ? rules.longShare : rules.longAlone) * f;
      if (ratio <= short) {
        cands.push({
          kind: "short",
          weight: short / ratio,
          text: `${n} is much shorter than the model's. Give it more time${TONE_DO[tone] ? `, so the tone has room to ${TONE_DO[tone]}` : ""}.`,
          kid: `Make ${n} a little longer, like the model!`,
        });
      } else if (ratio >= long) {
        cands.push({ kind: "long", weight: ratio / long, text: `${n} is much longer than the model's. Say it more briskly.`, kid: `Say ${n} a little quicker, like the model!` });
      }
    }

    // A confident miss with nothing more specific to say: what the tone does.
    if (s.verdict === "off" && s.why !== "sound" && !cands.length && tone >= 1 && tone <= 4) {
      const heard = s.heardTone && TONE_WORD[s.heardTone] ? `; it sounded ${TONE_WORD[s.heardTone]}` : "";
      const how: Record<number, string> = {
        1: "Hold it steady near the top of your voice.",
        2: s.heardTone === 3 ? "Start in the middle of your voice and climb, without dipping first." : "Start in the middle of your voice and climb to the top, like a question.",
        3: s.half ? "Before another tone it is just low: drop to the bottom of your voice and stay there." : s.heardTone === 2 ? "Drop to the bottom of your voice first; the rise comes only at the end." : "Drop to the bottom of your voice, then let it come back up.",
        4: "Start near the top of your voice and drop sharply, like a firm “No!”.",
      };
      cands.push({ kind: "tone", weight: 1.4, text: `${n} should be ${s.half && tone === 3 ? "low" : TONE_WORD[tone]}${heard}. ${how[tone]}`, kid: `Let's try ${n} again: it ${KID_SHAPES[tone]}.` });
    }

    if (!cands.length) return;
    const best = cands.sort((a, b) => b.weight - a.weight)[0];
    picked.push({ syllable: i, kind: best.kind, text: kids ? best.kid : best.text, weight: round2(best.weight * (ok ? 1 : 2)) });
  });
  return picked.sort((a, b) => b.weight - a.weight || a.syllable - b.syllable).slice(0, kids ? rules.kidsMaxTips : rules.maxTips);
}

/* --------------------------------- in words -------------------------------- */

/** One word or two for what a shape does, for the text equivalent of the picture. */
export function shapeWords(sh: SyllableShape | null): string {
  if (!sh) return "not read";
  if (sh.spread < 2) return "level";
  if (sh.dip >= 2 && sh.rise >= 2 && sh.bottomAt > 0.15 && sh.bottomAt < 0.85) return "dips, then rises";
  if (sh.tail - sh.head >= 2) return "rises";
  if (sh.head - sh.tail >= 2) return "falls";
  return "mostly level";
}

/** Per syllable, what the picture shows in words: your shape, the model's
 *  (or "textbook" where its curve wasn't read), and the lengths. */
export function describeTakes({ mine, frames, model }: { mine: PronunciationSyllable[]; frames: PronunciationFrames; model: ModelInput | null }): { syllable: number; mine: string; model: string; mineMs: number | null; modelMs: number | null }[] {
  return mine.map((s, i) => {
    const m = model?.syllables[i];
    const real = !!m?.real;
    const len = (x: { startMs: number | null; endMs: number | null } | undefined) => (x && x.startMs !== null && x.endMs !== null && x.endMs > x.startMs ? Math.round(x.endMs - x.startMs) : null);
    return {
      syllable: i,
      mine: shapeWords(syllableShape(framesIn(frames, s.startMs, s.endMs))),
      model: real ? shapeWords(syllableShape(framesIn(model!.frames, m!.startMs, m!.endMs))) : "textbook shape",
      mineMs: len(s),
      modelMs: len(m),
    };
  });
}

const round2 = (v: number) => Math.round(v * 100) / 100;
