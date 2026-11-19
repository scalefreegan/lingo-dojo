// Compare mode's pure rules (ld-ne0.9): web/shared/compare.ts (the shape
// of a syllable, the alignment of the two takes, the tips) and
// scripts/pronunciation-compare.mjs (a recording's frames, the model
// record). The frames here are built by hand, curve by curve, so each rule
// is seen to fire on the difference it names and to keep quiet otherwise;
// one end-to-end case runs the real scorer on generated voices.
//   node --test scripts/tests/compare.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPARE_RULES, alignTakes, compareTips, describeTakes, framesIn, mapBack, mapThrough, syllableShape, textbookCurve, warpAnchors } from "../../web/shared/compare.ts";
import { isModelRecord, modelRecord, modelSyllableReal, speakerCentre, takeFrames } from "../pronunciation-compare.mjs";
import { scoreReply, scoreSyllables } from "../pronunciation-app.mjs";
import { scoreTones, trackPitch } from "../pronunciation.mjs";
import { speak } from "../pronunciation-synth.mjs";

const STEP = 10;

/**
 * Frames for syllables said one after another: `parts` is a list of
 * `{ ms, curve }` (curve: x in [0,1] → semitones about the speaker's
 * middle, or null for unvoiced), with `gapMs` of silence around and
 * between. → { frames, spans }.
 */
function build(parts, { gapMs = 100, lead = 300 } = {}) {
  const pitch = [];
  const level = [];
  const spans = [];
  const push = (n, p, l) => {
    for (let i = 0; i < n; i++) {
      pitch.push(p(i, n));
      level.push(l);
    }
  };
  push(lead / STEP, () => null, -48);
  parts.forEach(({ ms, curve }, k) => {
    const start = pitch.length * STEP;
    push(ms / STEP, (i, n) => {
      const v = curve(n > 1 ? i / (n - 1) : 0);
      return v === null ? null : Math.round(v * 10) / 10;
    }, -6);
    spans.push({ startMs: start, endMs: pitch.length * STEP });
    push((k === parts.length - 1 ? lead : gapMs) / STEP, () => null, -48);
  });
  return { frames: { frameMs: STEP, pitch, level }, spans };
}

/** The learner's syllables as the score route sends them. */
function mineOf(spans, list) {
  return list.map((s, i) => ({ char: s.char ?? "字", pinyin: s.pinyin ?? "zi", expectedTone: s.tone, accept: [s.tone], verdict: s.verdict ?? "off", ...s.extra, startMs: spans[i].startMs, endMs: spans[i].endMs, heard: [], reference: null }));
}
/** The model's syllables as the model route sends them. */
function modelOf(spans, list, frames) {
  return { frames, durationMs: frames.pitch.length * STEP, syllables: list.map((s, i) => ({ char: s.char ?? "字", pinyin: s.pinyin ?? "zi", expectedTone: s.tone, startMs: spans[i].startMs, endMs: spans[i].endMs, real: s.real ?? true, ...(s.saidTone ? { saidTone: s.saidTone } : {}) })) };
}

const FALL = (x) => 4.5 - 9 * x;
const LEVEL = () => 3;
const RISE = (x) => -2 + 6 * x;
const DIP = (x) => 3 - 20 * x + 20 * x * x;

/* ---------------------------------- shape --------------------------------- */

test("a syllable's shape: fall, rise, dip and level, from its frames; too little voice says nothing", () => {
  const { frames, spans } = build([{ ms: 300, curve: FALL }, { ms: 300, curve: RISE }, { ms: 300, curve: DIP }, { ms: 300, curve: LEVEL }]);
  const [f, r, d, l] = spans.map((s) => syllableShape(framesIn(frames, s.startMs, s.endMs)));
  assert.ok(f.fall > 6 && f.rise < 0.5, JSON.stringify(f));
  assert.ok(r.rise > 4.5 && r.fall < 0, JSON.stringify(r));
  assert.ok(d.dip > 2 && d.rise > 1 && d.bottomAt > 0.35 && d.bottomAt < 0.65, JSON.stringify(d));
  assert.ok(l.spread < 0.5, JSON.stringify(l));
  // Under the minimum of voiced frames, or half the span unvoiced: nothing.
  assert.equal(syllableShape([1, 2, 3, 4, 5]), null);
  assert.equal(syllableShape(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 1 : null))), null);
  assert.deepEqual(framesIn(frames, null, 100), []);
});

/* -------------------------------- alignment ------------------------------- */

test("the warp maps each model syllable onto the learner's, monotonic, slope 1 outside", () => {
  const mine = [{ startMs: 300, endMs: 500 }, { startMs: 600, endMs: 700 }];
  const model = [{ startMs: 100, endMs: 500 }, { startMs: 550, endMs: 950 }];
  const a = warpAnchors(mine, model);
  assert.deepEqual(a, [[300, 100], [500, 500], [600, 550], [700, 950]]);
  assert.equal(mapThrough(a, 300), 100);
  assert.equal(mapThrough(a, 400), 300, "halfway through the first syllable is halfway through the model's");
  assert.equal(mapThrough(a, 650), 750);
  assert.equal(mapThrough(a, 200), 0, "before the first anchor: slope 1");
  assert.equal(mapThrough(a, 800), 1050, "after the last: slope 1");
  for (const t of [250, 333, 420, 580, 690, 900]) assert.ok(Math.abs(mapBack(a, mapThrough(a, t)) - t) < 1e-9);
  // A pair that would run backwards is left out; untimed syllables are skipped.
  assert.deepEqual(warpAnchors([{ startMs: 100, endMs: 200 }, { startMs: 150, endMs: 300 }], [{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 400 }]), [[100, 0], [200, 100], [300, 400]]);
  assert.deepEqual(warpAnchors([{ startMs: null, endMs: null }], [{ startMs: 0, endMs: 100 }]), []);
  assert.equal(mapThrough([], 123), 123);
});

test("aligned takes: the model's syllables land in the learner's bands; real lengths only shift", () => {
  const me = build([{ ms: 200, curve: FALL }, { ms: 300, curve: RISE }]);
  const mo = build([{ ms: 500, curve: FALL }, { ms: 250, curve: RISE }], { lead: 150, gapMs: 60 });
  const mine = mineOf(me.spans, [{ tone: 4, verdict: "ok" }, { tone: 2, verdict: "ok" }]);
  const model = modelOf(mo.spans, [{ tone: 4 }, { tone: 2 }], mo.frames);
  const a = alignTakes({ mine, frames: me.frames, model });
  assert.equal(a.warped, true);
  // In each learner band the model's curve has the model syllable's shape.
  for (const [k, b] of a.bands.entries()) {
    const idx = a.t.map((x, j) => (x >= b.fromMs + 20 && x < b.toMs - 20 ? j : -1)).filter((j) => j >= 0);
    const vals = idx.map((j) => a.model.pitch[j]).filter((v) => v !== null);
    assert.ok(vals.length >= idx.length - 2, `band ${k} is covered`);
    if (k === 0) assert.ok(vals[0] - vals.at(-1) > 6, "the model's fall fills the first band");
    else assert.ok(vals.at(-1) - vals[0] > 3, "the model's rise fills the second band");
  }
  assert.ok(a.fromMs <= me.spans[0].startMs && a.toMs >= me.spans[1].endMs);
  // Real lengths: shifted so the first syllables start together; the model's
  // marks sit where its own syllables are, longer than the learner's.
  const r = alignTakes({ mine, frames: me.frames, model, warp: false });
  assert.equal(r.warped, false);
  assert.equal(r.bands[0].modelFromMs, me.spans[0].startMs);
  assert.equal(r.bands[0].modelToMs - r.bands[0].modelFromMs, 500);
  assert.ok(r.toMs >= r.bands[1].modelToMs, "the axis is long enough for the model");
});

test("where the model's clip wasn't read with confidence (or there is no model) the textbook shape stands in", () => {
  const me = build([{ ms: 300, curve: FALL }, { ms: 300, curve: LEVEL }]);
  const mine = mineOf(me.spans, [{ tone: 4, verdict: "ok" }, { tone: 1, verdict: "ok" }]);
  const model = modelOf(me.spans, [{ tone: 4 }, { tone: 1, real: false }], me.frames);
  const a = alignTakes({ mine, frames: me.frames, model });
  const inBand = (b, arr) => a.t.map((x, j) => (x >= b.fromMs && x < b.toMs ? arr[j] : undefined)).filter((v) => v !== undefined);
  assert.ok(inBand(a.bands[0], a.model.pitch).every((v) => v !== null), "a real syllable keeps the model's curve");
  assert.ok(inBand(a.bands[0], a.model.textbook).every((v) => v === null));
  assert.ok(inBand(a.bands[1], a.model.pitch).every((v) => v === null), "an unread one has no model curve…");
  assert.ok(inBand(a.bands[1], a.model.textbook).every((v) => v === 5), "…but the first tone's textbook shape, high (Chao 5) and level");
  const none = alignTakes({ mine, frames: me.frames, model: null });
  assert.equal(none.model.level.length, 0);
  assert.ok(inBand(none.bands[0], none.model.textbook).every((v) => v !== null));
  assert.deepEqual(textbookCurve(4, false, 3), [5, 0, -5]);
  assert.deepEqual(textbookCurve(3, true, 3), [-2.5, -5, -5]);
  assert.equal(textbookCurve(0, false, 5), null);
});

/* ----------------------------------- tips ---------------------------------- */

/** Tips for one syllable: the learner's curve against the model's. */
function tipsFor({ mine: mineCurve, model: modelCurve, tone, verdict = "off", extra = {}, kids = false, mineMs = 300, modelMs = 300, real = true, modelSaid = undefined }) {
  const me = build([{ ms: mineMs, curve: mineCurve }]);
  const mo = build([{ ms: modelMs, curve: modelCurve }]);
  const mine = mineOf(me.spans, [{ tone, verdict, extra, char: "是", pinyin: "shì" }]);
  return compareTips({ mine, frames: me.frames, model: modelOf(mo.spans, [{ tone, real, char: "是", saidTone: modelSaid }], mo.frames), kids, name: () => "是 (shì)" });
}

test("a fall too small: on an off by the normal bar, on an ok only when it is much larger, never on an unsure", () => {
  const small = (x) => 1.5 - 3 * x; // 3 semitones against the model's 9
  const [t] = tipsFor({ mine: small, model: FALL, tone: 4, extra: { heardTone: 1, why: "tone" } });
  assert.equal(t.kind, "fall_small");
  assert.match(t.text, /^是 \(shì\): the fall is too small\. Drop further, as the model does: yours falls about a third as far\.$/);
  // ok: the same gap isn't enough…
  assert.deepEqual(tipsFor({ mine: small, model: FALL, tone: 4, verdict: "ok" }), []);
  // …a near-flat one is.
  assert.equal(tipsFor({ mine: (x) => 0.3 - 0.6 * x, model: FALL, tone: 4, verdict: "ok" })[0]?.kind, "fall_small");
  assert.deepEqual(tipsFor({ mine: (x) => 0.3 - 0.6 * x, model: FALL, tone: 4, verdict: "unsure" }), [], "unsure: nothing");
  // A fall like the model's: nothing to say.
  assert.deepEqual(tipsFor({ mine: (x) => 4 - 8 * x, model: FALL, tone: 4, verdict: "ok" }), []);
});

test("the other curve rules: level that moves, rise too small or late, dip too shallow", () => {
  assert.equal(tipsFor({ mine: RISE, model: LEVEL, tone: 1, extra: { heardTone: 2, why: "tone" } })[0].kind, "level_moves");
  assert.match(tipsFor({ mine: RISE, model: LEVEL, tone: 1, extra: { heardTone: 2, why: "tone" } })[0].text, /should stay level, but yours rises/);
  assert.equal(tipsFor({ mine: (x) => 0.5 * x, model: RISE, tone: 2, extra: { heardTone: 1, why: "tone" } })[0].kind, "rise_small");
  const late = (x) => (x < 0.7 ? -2 : -2 + (x - 0.7) * 22);
  const early = (x) => (x < 0.15 ? -2 : -2 + (x - 0.15) * 8);
  assert.equal(tipsFor({ mine: late, model: early, tone: 2, extra: { heardTone: 3, why: "tone" } })[0].kind, "rise_late");
  const shallow = (x) => 0.5 - 2 * x + 2 * x * x;
  const [d] = tipsFor({ mine: shallow, model: DIP, tone: 3, extra: { heardTone: 2, why: "tone" } });
  assert.equal(d.kind, "dip_shallow");
  assert.match(d.text, /comes back up/);
  assert.ok(!tipsFor({ mine: shallow, model: DIP, tone: 3, extra: { heardTone: 2, why: "tone", half: true } }).some((t) => t.kind === "dip_shallow"), "a half third is never read by its dip");
});

/** Tips for a three-syllable take, high – B – high (a first tone either
 *  side), the middle one's curve against the model's: height is read only
 *  from three syllables (COMPARE_RULES.heightMinSyllables). */
function middleTips({ b, modelB, tone = 3, verdict = "ok", extra = {} }) {
  const me = build([{ ms: 300, curve: LEVEL }, { ms: 300, curve: b }, { ms: 300, curve: LEVEL }]);
  const mo = build([{ ms: 300, curve: LEVEL }, { ms: 300, curve: modelB }, { ms: 300, curve: LEVEL }]);
  const mine = mineOf(me.spans, [{ tone: 1, verdict: "ok" }, { tone, verdict, extra }, { tone: 1, verdict: "ok" }]);
  return compareTips({ mine, frames: me.frames, model: modelOf(mo.spans, [{ tone: 1 }, { tone }, { tone: 1 }], mo.frames) }).filter((t) => t.syllable === 1);
}

test("a half third is read by how low it sits against each voice's own centre, not by how far it moves", () => {
  const lowLevel = () => -5;
  const modelFallingLow = (x) => -1 - 5 * x; // −1 → −6: moves 5, sits low
  const half = { half: true };
  // Low and level against a model falling into the low: right, nothing to say.
  assert.deepEqual(middleTips({ b: lowLevel, modelB: modelFallingLow, extra: half }), []);
  // The same take marked off (the scorer heard another tone): still no curve tip, only the plain one.
  const off = middleTips({ b: lowLevel, modelB: modelFallingLow, verdict: "off", extra: { ...half, heardTone: 1, why: "tone" } });
  assert.deepEqual(off.map((t) => t.kind), ["tone"]);
  assert.match(off[0].text, /should be low/);
  // Sitting high in the voice: off by the normal bar, ok only well past it.
  const [t] = middleTips({ b: () => 1, modelB: modelFallingLow, verdict: "off", extra: { ...half, heardTone: 1, why: "tone" } });
  assert.equal(t.kind, "half_high");
  assert.match(t.text, /sits too high in your voice.*just low/);
  assert.deepEqual(middleTips({ b: () => 1, modelB: modelFallingLow, extra: half }), [], "ok: a gap of 4.5 is under 1.6 × 3");
  assert.equal(middleTips({ b: () => 3, modelB: modelFallingLow, extra: half })[0]?.kind, "half_high");
  // A model that doesn't sit low itself says nothing about lowness.
  assert.deepEqual(middleTips({ b: () => 3, modelB: () => 0, extra: half }), []);
  // A lone syllable, or two: no height at all (the centre is the syllable
  // itself, or halfway between the two).
  assert.deepEqual(tipsFor({ mine: () => 3, model: modelFallingLow, tone: 3, verdict: "off", extra: { ...half, heardTone: 1, why: "tone" } }).map((x) => x.kind), ["tone"]);
});

/* Height through the real takeFrames: syllables held for different lengths
 * by the learner and the model, with the same pitches. Hz, not semitones:
 * a pitch track as trackPitch gives it, centred by takeFrames itself. */
const HIGH = 220;
const LOW = 220 * 2 ** (-6.5 / 12);
function trackOf(parts, { gapMs = 100, lead = 300 } = {}) {
  const f0 = [];
  const rms = [];
  const spans = [];
  const push = (n, hz) => {
    for (let i = 0; i < n; i++) {
      f0.push(hz);
      rms.push(hz ? 0.2 : 0.001);
    }
  };
  push(lead / STEP, 0);
  parts.forEach(({ ms, hz }, k) => {
    const start = f0.length * STEP;
    push(ms / STEP, hz);
    spans.push({ startMs: start, endMs: f0.length * STEP });
    push((k === parts.length - 1 ? lead : gapMs) / STEP, 0);
  });
  return { track: { hopMs: STEP, f0: Float32Array.from(f0), rms: Float32Array.from(rms) }, spans };
}
function heightTips({ mine: mineParts, model: modelParts, list, kids = false }) {
  const me = trackOf(mineParts);
  const mo = trackOf(modelParts);
  const frames = takeFrames(me.track, me.spans);
  const modelFrames = takeFrames(mo.track, mo.spans);
  const mine = mineOf(me.spans, list);
  const tips = compareTips({ mine, frames, model: modelOf(mo.spans, list.map((x) => ({ tone: x.tone })), modelFrames), kids });
  return { tips, frames, modelFrames, me, mo };
}
const meanIn = (frames, span) => {
  const v = framesIn(frames, span.startMs, span.endMs).filter((x) => x !== null);
  return v.reduce((a, x) => a + x, 0) / v.length;
};

test("the centre doesn't move with how long a syllable is held: a half third held longer is not 'too high'", () => {
  // 他好高-like: high, half third, high. The learner holds the middle one
  // 600 ms, the model 250 ms; the pitches are the same.
  for (const verdict of ["ok", "off"]) {
    const extra = verdict === "off" ? { half: true, heardTone: 1, why: "tone" } : { half: true };
    const { tips, frames, modelFrames, me, mo } = heightTips({
      mine: [{ ms: 250, hz: HIGH }, { ms: 600, hz: LOW }, { ms: 250, hz: HIGH }],
      model: [{ ms: 300, hz: HIGH }, { ms: 250, hz: LOW }, { ms: 300, hz: HIGH }],
      list: [{ tone: 1, verdict: "ok" }, { tone: 3, verdict, extra }, { tone: 1, verdict: "ok" }],
    });
    assert.ok(Math.abs(meanIn(frames, me.spans[1]) - meanIn(modelFrames, mo.spans[1])) < 0.2, "the same height on both sides");
    assert.ok(!tips.some((t) => t.kind === "half_high" || t.kind === "level_low"), `${verdict}: ${JSON.stringify(tips)}`);
  }
  // Said high for real: the tip. (The first syllable is a fourth tone here,
  // so a middle heard level isn't read as carried on from it.)
  const real = heightTips({
    mine: [{ ms: 250, hz: HIGH }, { ms: 600, hz: HIGH }, { ms: 250, hz: HIGH }],
    model: [{ ms: 300, hz: HIGH }, { ms: 250, hz: LOW }, { ms: 300, hz: HIGH }],
    list: [{ tone: 4, verdict: "ok" },{ tone: 3, verdict: "off", extra: { half: true, heardTone: 1, why: "tone" } }, { tone: 1, verdict: "ok" }],
  });
  assert.deepEqual(real.tips.map((t) => [t.syllable, t.kind]), [[1, "half_high"]]);
});

test("the mirror case: a first tone held longer is not 'sitting low'", () => {
  for (const verdict of ["ok", "off"]) {
    const extra = verdict === "off" ? { heardTone: 2, why: "tone" } : {};
    const { tips, frames, modelFrames, me, mo } = heightTips({
      mine: [{ ms: 600, hz: HIGH }, { ms: 250, hz: LOW }, { ms: 250, hz: LOW }],
      model: [{ ms: 250, hz: HIGH }, { ms: 300, hz: LOW }, { ms: 300, hz: LOW }],
      list: [{ tone: 1, verdict, extra }, { tone: 3, verdict: "ok" }, { tone: 3, verdict: "ok" }],
    });
    assert.ok(Math.abs(meanIn(frames, me.spans[0]) - meanIn(modelFrames, mo.spans[0])) < 0.2);
    assert.ok(!tips.some((t) => t.kind === "level_low" || t.kind === "half_high"), `${verdict}: ${JSON.stringify(tips)}`);
  }
  // Said low for real: the tip.
  const real = heightTips({
    mine: [{ ms: 600, hz: LOW }, { ms: 250, hz: LOW }, { ms: 250, hz: LOW }],
    model: [{ ms: 250, hz: HIGH }, { ms: 300, hz: LOW }, { ms: 300, hz: LOW }],
    list: [{ tone: 1, verdict: "off", extra: { heardTone: 3, why: "tone" } }, { tone: 3, verdict: "ok" }, { tone: 3, verdict: "ok" }],
  });
  assert.equal(real.tips.find((t) => t.syllable === 0)?.kind, "level_low");
});

test("two syllables: no height tip either way, however long each is held (好吃)", () => {
  for (const [mineMs, modelMs] of [[350, 250], [250, 350]]) {
    for (const verdict of ["ok", "off"]) {
      const extra = verdict === "off" ? { half: true, heardTone: 1, why: "tone" } : { half: true };
      const { tips } = heightTips({
        mine: [{ ms: mineMs, hz: HIGH }, { ms: 300, hz: HIGH }],
        model: [{ ms: modelMs, hz: LOW }, { ms: 300, hz: HIGH }],
        list: [{ tone: 3, verdict, extra }, { tone: 1, verdict: "ok" }],
      });
      assert.ok(!tips.some((t) => t.kind === "half_high" || t.kind === "level_low"), JSON.stringify(tips));
    }
  }
});

test("speakerCentre: the median of the syllables' own pitches, not of every frame", () => {
  const { track, spans } = trackOf([{ ms: 250, hz: HIGH }, { ms: 900, hz: LOW }, { ms: 250, hz: HIGH }]);
  const c = speakerCentre(track.f0, STEP, spans);
  assert.ok(Math.abs(c - 12 * Math.log2(HIGH)) < 0.01, "two of three syllables are high");
  assert.ok(Math.abs(speakerCentre(track.f0, STEP, spans.slice(1, 2)) - 12 * Math.log2(LOW)) < 0.01, "one: its own");
  assert.ok(Number.isFinite(speakerCentre(track.f0, STEP, [])), "no spans: every frame");
});

test("several accepted tones: a curve is compared only when the learner and the model said the same one", () => {
  // 我 before 很 takes 2 or 3; the reply's expected tone is the sandhi 2.
  const both = { accept: [2, 3] };
  const flatDip = (x) => -3 - 1 * x + 1 * x * x;
  // The learner said wǒ (ok, heard 3) and the model wó: two right answers, no tip.
  assert.deepEqual(tipsFor({ mine: flatDip, model: RISE, tone: 2, verdict: "ok", extra: { ...both, saidTone: 3 }, modelSaid: 2 }), []);
  // A take whose rise reads as too small against the expected tone…
  assert.equal(tipsFor({ mine: () => 0, model: (x) => -3 + 9 * x, tone: 2, verdict: "ok" })[0]?.kind, "rise_small", "with one tone accepted, a tip");
  // …says nothing where it was heard as the other accepted tone.
  assert.deepEqual(tipsFor({ mine: () => 0, model: (x) => -3 + 9 * x, tone: 2, verdict: "ok", extra: { ...both, saidTone: 3 }, modelSaid: 2 }), []);
  // No tone named on the reply, or none on the model: nothing either.
  assert.deepEqual(tipsFor({ mine: () => 0, model: (x) => -3 + 9 * x, tone: 2, verdict: "ok", extra: both, modelSaid: 2 }), []);
  assert.deepEqual(tipsFor({ mine: () => 0, model: (x) => -3 + 9 * x, tone: 2, verdict: "ok", extra: { ...both, saidTone: 2 } }), []);
  // Both said the same tone: compared as usual (不 said bù, a near-flat fall).
  const bu = { accept: [4, 2], saidTone: 4 };
  assert.equal(tipsFor({ mine: (x) => 0.3 - 0.6 * x, model: FALL, tone: 4, verdict: "ok", extra: bu, modelSaid: 4 })[0]?.kind, "fall_small");
  // A miss where several count: no curve tip, only the plain sentence.
  assert.deepEqual(tipsFor({ mine: () => 0, model: (x) => -3 + 9 * x, tone: 2, extra: { ...both, heardTone: 1, why: "tone" }, modelSaid: 2 }).map((t) => t.kind), ["tone"]);
});

test("length: never on a lone syllable said right, and never on a model span that wasn't read with confidence", () => {
  // Held to hear it, against a short voice clip: right, no "more briskly".
  assert.deepEqual(tipsFor({ mine: FALL, model: FALL, tone: 4, verdict: "ok", mineMs: 950, modelMs: 250 }), []);
  assert.equal(tipsFor({ mine: FALL, model: FALL, tone: 4, mineMs: 950, modelMs: 250, extra: { heardTone: 1, why: "tone" } })[0].kind, "long");
  // The model's span a stand-in: no length tip, only the plain one.
  assert.deepEqual(tipsFor({ mine: FALL, model: FALL, tone: 4, mineMs: 120, modelMs: 400, real: false, extra: { heardTone: 1, why: "tone" } }).map((t) => t.kind), ["tone"]);
});

test("no curve tips without the model's own curve, for the neutral tone, or for another reading of a card character", () => {
  const small = (x) => 0.3 - 0.6 * x;
  // Not real: only the verdict's own tip, about the tone in general.
  const [t] = tipsFor({ mine: small, model: FALL, tone: 4, real: false, extra: { heardTone: 1, why: "tone" } });
  assert.equal(t.kind, "tone");
  assert.match(t.text, /^是 \(shì\) should be falling; it sounded high level\. Start near the top/);
  assert.deepEqual(tipsFor({ mine: small, model: FALL, tone: 4, real: false, verdict: "ok" }), [], "an ok with no model curve: nothing");
  assert.deepEqual(tipsFor({ mine: small, model: FALL, tone: 0, verdict: "ok" }), []);
  assert.deepEqual(tipsFor({ mine: small, model: FALL, tone: 4, verdict: "ok", extra: { usual: "zhǎng" } }), []);
});

test("Azure's sound score: named when given, the whole syllable, never claiming which part", () => {
  const [t] = tipsFor({ mine: FALL, model: FALL, tone: 4, extra: { why: "sound", soundScore: 31 } });
  assert.equal(t.kind, "sound");
  assert.match(t.text, /the sound itself seemed off, not only the tone \(Azure scored the syllable 31 of 100\)/);
  assert.match(t.text, /can't tell whether it was the consonant or the vowel/);
  const [k] = tipsFor({ mine: FALL, model: FALL, tone: 4, extra: { why: "sound", soundScore: 31 }, kids: true });
  assert.equal(k.text, "Listen to how 是 (shì) sounds and copy it!");
});

test("much shorter than the model: as a share of the take in a phrase, by length alone for one syllable", () => {
  assert.equal(tipsFor({ mine: FALL, model: FALL, tone: 4, mineMs: 120, modelMs: 400, extra: { heardTone: 1, why: "tone" } })[0].kind, "short");
  assert.deepEqual(tipsFor({ mine: FALL, model: FALL, tone: 4, mineMs: 220, modelMs: 400, verdict: "ok" }), [], "a little shorter, said right: nothing");
  // A phrase said twice as fast overall is not "too short" anywhere.
  const me = build([{ ms: 150, curve: FALL }, { ms: 150, curve: FALL }]);
  const mo = build([{ ms: 300, curve: FALL }, { ms: 300, curve: FALL }]);
  const mine = mineOf(me.spans, [{ tone: 4, verdict: "ok" }, { tone: 4, verdict: "ok" }]);
  assert.deepEqual(compareTips({ mine, frames: me.frames, model: modelOf(mo.spans, [{ tone: 4 }, { tone: 4 }], mo.frames) }), []);
  // One syllable squeezed against its neighbour is.
  const me2 = build([{ ms: 80, curve: FALL }, { ms: 300, curve: FALL }]);
  const mine2 = mineOf(me2.spans, [{ tone: 4, verdict: "off", extra: { heardTone: 1, why: "tone" } }, { tone: 4, verdict: "ok" }]);
  const tips = compareTips({ mine: mine2, frames: me2.frames, model: modelOf(mo.spans, [{ tone: 4 }, { tone: 4 }], mo.frames) });
  assert.deepEqual(tips.map((t) => [t.syllable, t.kind]), [[0, "short"]]);
});

test("carried over: an off heard as the tone before, joined to it, while the model resets", () => {
  // 喝茶: hē chá said hē chā (the level pitch carried on).
  const me = build([{ ms: 300, curve: LEVEL }, { ms: 300, curve: LEVEL }], { gapMs: 30 });
  const mo = build([{ ms: 300, curve: LEVEL }, { ms: 300, curve: RISE }], { gapMs: 30 });
  const mine = mineOf(me.spans, [{ tone: 1, verdict: "ok", char: "喝" }, { tone: 2, verdict: "off", char: "茶", extra: { heardTone: 1, why: "tone" } }]);
  const model = modelOf(mo.spans, [{ tone: 1 }, { tone: 2 }], mo.frames);
  const names = ["喝 (hē)", "茶 (chá)"];
  const [t] = compareTips({ mine, frames: me.frames, model, name: (i) => names[i] });
  assert.equal(t.kind, "carried");
  assert.equal(t.text, "茶 (chá) carries on the high level pitch of 喝 (hē) before it. Reset between the two: 茶 (chá) should rise.");
  // Heard as some other tone: not "carried".
  const other = mineOf(me.spans, [{ tone: 1, verdict: "ok" }, { tone: 2, verdict: "off", extra: { heardTone: 4, why: "tone" } }]);
  assert.notEqual(compareTips({ mine: other, frames: me.frames, model })[0]?.kind, "carried");
  // The syllable before accepts several tones (一, 不, 我 before another
  // third): its tone is the one its reply names, or there is no carried tip.
  const before = (extra) => mineOf(me.spans, [{ tone: 4, verdict: "ok", extra }, { tone: 2, verdict: "off", extra: { heardTone: 1, why: "tone" } }]);
  const kinds = (m) => compareTips({ mine: m, frames: me.frames, model }).map((x) => x.kind);
  assert.ok(!kinds(before({ accept: [4, 1] })).includes("carried"), "none named: no carried tip");
  assert.ok(!kinds(before({ accept: [4, 1], saidTone: 4 })).includes("carried"), "said 4: heard 1 isn't carried from it");
  const said1 = compareTips({ mine: before({ accept: [4, 1], saidTone: 1 }), frames: me.frames, model, name: (i) => names[i] });
  assert.equal(said1[0].kind, "carried");
  assert.match(said1[0].text, /carries on the high level pitch/);
});

test("at most three tips, misses first; kids get one, gently, with no numbers and nothing on an ok", () => {
  const parts = [{ ms: 300, curve: RISE }, { ms: 300, curve: (x) => 0.2 * x }, { ms: 300, curve: (x) => 0.5 - 1 * x }, { ms: 300, curve: LEVEL }, { ms: 300, curve: (x) => 0.1 }];
  const me = build(parts);
  const mo = build([{ ms: 300, curve: LEVEL }, { ms: 300, curve: RISE }, { ms: 300, curve: FALL }, { ms: 300, curve: LEVEL }, { ms: 300, curve: FALL }]);
  const mine = mineOf(me.spans, [
    { tone: 1, extra: { heardTone: 2, why: "tone" } },
    { tone: 2, extra: { heardTone: 1, why: "tone" } },
    { tone: 4, extra: { heardTone: 1, why: "tone" } },
    { tone: 1, verdict: "ok" },
    { tone: 4, verdict: "ok" },
  ]);
  const model = modelOf(mo.spans, [{ tone: 1 }, { tone: 2 }, { tone: 4 }, { tone: 1 }, { tone: 4 }], mo.frames);
  const tips = compareTips({ mine, frames: me.frames, model });
  assert.equal(tips.length, COMPARE_RULES.maxTips);
  assert.ok(tips.every((t) => mine[t.syllable].verdict === "off"), "the misses outrank the large difference on an ok");
  assert.deepEqual(new Set(tips.map((t) => t.syllable)).size, tips.length, "one tip per syllable");
  for (let k = 1; k < tips.length; k++) assert.ok(tips[k - 1].weight >= tips[k].weight);
  const kids = compareTips({ mine, frames: me.frames, model, kids: true });
  assert.equal(kids.length, 1);
  assert.doesNotMatch(kids[0].text, /\d/);
  assert.match(kids[0].text, /!$/);
  // Kids: an ok alone, however different, gets nothing.
  const okOnly = mine.map((s) => ({ ...s, verdict: "ok" }));
  assert.deepEqual(compareTips({ mine: okOnly, frames: me.frames, model, kids: true }), []);
  assert.ok(compareTips({ mine: okOnly, frames: me.frames, model }).length >= 1, "an adult's large difference on an ok still gets one");
});

test("the picture in words names each syllable's shape and length", () => {
  const me = build([{ ms: 300, curve: FALL }, { ms: 200, curve: LEVEL }]);
  const mo = build([{ ms: 400, curve: FALL }, { ms: 300, curve: LEVEL }]);
  const mine = mineOf(me.spans, [{ tone: 4, verdict: "ok" }, { tone: 1, verdict: "ok" }]);
  const w = describeTakes({ mine, frames: me.frames, model: modelOf(mo.spans, [{ tone: 4 }, { tone: 1, real: false }], mo.frames) });
  assert.deepEqual(w.map((x) => [x.mine, x.model, x.mineMs, x.modelMs]), [["falls", "falls", 300, 400], ["level", "textbook shape", 200, 300]]);
});

/* ------------------------------ frames, record ----------------------------- */

test("takeFrames: pitch about the speaker's own middle inside the syllables, loudness everywhere", () => {
  const low = speak([1, 4], { lowHz: 100, gaps: [300, 80, 300] });
  const high = speak([1, 4], { lowHz: 220, gaps: [300, 80, 300] });
  const fl = takeFrames(trackPitch(low.samples, 16_000), low.timings);
  const fh = takeFrames(trackPitch(high.samples, 16_000), high.timings);
  assert.equal(fl.frameMs, 10);
  assert.equal(fl.pitch.length, fl.level.length);
  // Each voice about its own middle: the two curves sit at the same heights.
  const mid = (f, s) => f.pitch[Math.round((s.startMs + s.endMs) / 2 / 10)];
  assert.ok(Math.abs(mid(fl, low.timings[0]) - mid(fh, high.timings[0])) < 1.5);
  // Outside the spans (the lead-in) no pitch, and quiet.
  assert.equal(fl.pitch[5], null);
  assert.ok(fl.level[5] <= -40);
  assert.ok(Math.max(...fl.level) === 0);
});

test("the model record: a syllable is real only when the engine heard the expected tone (or a voiced neutral)", () => {
  const frames = { frameMs: 10, pitch: Array.from({ length: 100 }, (_, i) => (i >= 20 && i < 60 ? 1 : null)), level: Array(100).fill(-10) };
  assert.equal(modelSyllableReal({ verdict: "ok", startMs: 200, endMs: 600 }, frames), true);
  assert.equal(modelSyllableReal({ verdict: "off", startMs: 200, endMs: 600 }, frames), false, "the voice said another reading");
  assert.equal(modelSyllableReal({ verdict: "unsure", reason: "edges", startMs: 200, endMs: 600 }, frames), false);
  assert.equal(modelSyllableReal({ verdict: "unsure", reason: "neutral", startMs: 200, endMs: 600 }, frames), true);
  assert.equal(modelSyllableReal({ verdict: "unsure", reason: "neutral", startMs: 700, endMs: 900 }, frames), false, "neutral with no voice");
  assert.equal(modelSyllableReal({ verdict: "ok", startMs: null, endMs: null }, frames), false);
  const syllables = scoreSyllables("大", ["dà"]).syllables;
  const rec = { ...modelRecord({ result: { provider: "local", syllables: [{ verdict: "ok", startMs: 200.4, endMs: 600.6 }] }, frames, syllables, durationMs: 1000.2 }), azure: "skipped" };
  assert.deepEqual(rec.syllables, [{ char: "大", pinyin: "dà", expectedTone: 4, startMs: 200, endMs: 601, real: true }]);
  assert.equal(isModelRecord(rec), true);
  // The tone heard is kept on an ok (several tones may count there).
  const heard = modelRecord({ result: { provider: "local", syllables: [{ verdict: "ok", heardTone: 4, startMs: 200, endMs: 600 }] }, frames, syllables, durationMs: 1000 });
  assert.equal(heard.syllables[0].saidTone, 4);
  assert.equal(isModelRecord({ ...rec, v: 0 }), false);
  assert.equal(isModelRecord({ ...rec, azure: "maybe" }), false);
});

test("end to end on generated voices: a wrong tone gets a tip, a right one none", () => {
  const run = (shapes, text, readings, voice) => {
    const { samples, timings } = speak(shapes, { gaps: [300, ...shapes.slice(1).map(() => 80), 300], ...voice });
    const syllables = scoreSyllables(text, readings).syllables;
    const track = trackPitch(samples, 16_000);
    const result = scoreTones({ samples, sampleRate: 16_000, syllables, timings, track });
    return { syllables, result, frames: takeFrames(track, result.syllables), durationMs: samples.length / 16 };
  };
  const model = run([1, 2], "喝茶", ["hē", "chá"], { lowHz: 210, spanSt: 12, ms: 380, seed: 3 });
  const rec = modelRecord(model);
  assert.deepEqual(rec.syllables.map((s) => s.real), [true, true]);
  const m = { frames: rec.frames, syllables: rec.syllables, durationMs: rec.durationMs };
  for (const [shapes, want] of [[[1, 1], "carried"], [[1, 4], "tone"], [[1, 2], null]]) {
    const me = run(shapes, "喝茶", ["hē", "chá"], { lowHz: 110, spanSt: 10, ms: 260 });
    const reply = scoreReply(me.result, me.syllables, { engine: "local", text: "喝茶", locale: "zh-CN", frames: me.frames });
    const tips = compareTips({ mine: reply.syllables, frames: reply.frames, model: m });
    assert.equal(tips[0]?.kind ?? null, want, `${shapes}: ${JSON.stringify(reply.syllables.map((s) => s.verdict))} ${JSON.stringify(tips)}`);
  }
});

test("the score reply names the tone heard on an ok only where several count (saidTone)", () => {
  const syllables = scoreSyllables("我很好", ["wǒ", "hěn", "hǎo"]).syllables;
  const result = {
    provider: "local",
    syllables: syllables.map((s, i) => ({ ...s, verdict: i === 2 ? "off" : "ok", heardTone: i === 0 ? 3 : i === 1 ? 2 : 1, confidence: 1, startMs: i * 300, endMs: i * 300 + 250, pitch: [] })),
  };
  const reply = scoreReply(result, syllables, { engine: "local", text: "我很好", locale: "zh-CN" });
  const [wo, , hao] = reply.syllables;
  assert.ok(wo.accept.length > 1, JSON.stringify(wo.accept));
  assert.equal(wo.saidTone, 3);
  assert.equal(hao.saidTone, undefined, "an off names heardTone, not saidTone");
  assert.equal(hao.heardTone, 1);
  // One tone accepted: never named on an ok.
  const one = scoreSyllables("大", ["dà"]).syllables;
  const r1 = scoreReply({ provider: "local", syllables: [{ ...one[0], verdict: "ok", heardTone: 4, confidence: 1, startMs: 0, endMs: 300, pitch: [] }] }, one, { engine: "local", text: "大", locale: "zh-CN" });
  assert.equal(r1.syllables[0].saidTone, undefined);
});
