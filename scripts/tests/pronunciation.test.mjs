import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AZURE_MAX_WAV_BYTES, AZURE_RULES, HOP_MS, TONE_RULES, alignTimings, applySandhi, azurePronunciationHeader, azurePronunciationRequest, azurePronunciationResult,
  classifyContour, encodeWav, expectedSyllables, mergeAzure, parsePinyin, parseWav, pitchCurve, pronunciationProvider, referenceCurves, rulesOut, scoreTones,
  scoresTones, scribeCharTimings, segmentSyllables, speakerRange, trackPitch, withTone,
} from "../pronunciation.mjs";
import { readCodePoints } from "../../web/src/script/zh.ts";

// The pronunciation engine (scripts/pronunciation.mjs): provider choice, the
// connected-speech rules, the pitch tracker and tone classifier on audio
// generated here, the unsure threshold, and the Azure adapter against
// fixtures in the shape of Microsoft's documented replies. No network.

/* --------------------------------- providers -------------------------------- */

test("pronunciationProvider: Azure only with both its key and its region, else local", () => {
  assert.equal(pronunciationProvider({ elevenlabs: "x", azureKey: "k", azureRegion: "eastus" }), "azure");
  assert.equal(pronunciationProvider({ elevenlabs: "x", azureKey: "k", azureRegion: "" }), "local");
  assert.equal(pronunciationProvider({ elevenlabs: "x", azureKey: "", azureRegion: "eastus" }), "local");
  assert.equal(pronunciationProvider({ elevenlabs: "x", azureKey: "  ", azureRegion: "eastus" }), "local");
  assert.equal(pronunciationProvider({}), "local");
  assert.equal(pronunciationProvider(null), "local");
});

test("scoresTones: Mandarin in either script, never Cantonese or another language", () => {
  for (const l of ["zh-CN", "zh-TW", "zh", "zh-Hant-TW", "cmn-TW", "zh_TW"]) assert.equal(scoresTones(l), true, l);
  for (const l of ["zh-HK", "zh-Hant-MO", "es-MX", "en-US", "", null]) assert.equal(scoresTones(l), false, String(l));
});

/* ----------------------------------- pinyin --------------------------------- */

test("parsePinyin and withTone: marks, digits, the neutral tone, where the mark goes", () => {
  assert.deepEqual(parsePinyin("mǎ"), { base: "ma", tone: 3 });
  assert.deepEqual(parsePinyin("lǜ"), { base: "lü", tone: 4 });
  assert.deepEqual(parsePinyin("ma"), { base: "ma", tone: 0 });
  assert.deepEqual(parsePinyin("hao3"), { base: "hao", tone: 3 });
  assert.deepEqual(parsePinyin("de5"), { base: "de", tone: 0 });
  assert.equal(withTone("mā", 4), "mà");
  assert.equal(withTone("hǎo", 2), "háo");
  assert.equal(withTone("duì", 1), "duī");
  assert.equal(withTone("gǒu", 4), "gòu");
  assert.equal(withTone("xué", 0), "xue");
});

/* ------------------------------ connected speech ---------------------------- */

/** Syllables from "字:pinyin" pairs; "|" is punctuation. */
function syl(spec) {
  const text = [];
  const readings = [];
  for (const part of spec.split(" ")) {
    if (part === "|") {
      text.push("，");
      readings.push(null);
    } else {
      const [ch, py] = part.split(":");
      text.push(ch);
      readings.push(py);
    }
  }
  return expectedSyllables(text.join(""), readings);
}
const tones = (s) => s.map((x) => x.expectedTone);

test("third-tone sandhi: the one before the last rises, earlier ones may go either way, punctuation stops it", () => {
  assert.deepEqual(tones(syl("你:nǐ 好:hǎo")), [2, 3]);
  assert.deepEqual(syl("你:nǐ 好:hǎo").map((x) => x.accept), [[2], [3]]);
  assert.deepEqual(tones(syl("很:hěn 好:hǎo")), [2, 3]);
  const three = syl("我:wǒ 很:hěn 好:hǎo");
  assert.deepEqual(tones(three), [2, 2, 3]);
  // wó hén hǎo and wǒ hén hǎo are both said.
  assert.deepEqual(three.map((x) => x.accept), [[2, 3], [2], [3]]);
  // Across a comma each keeps its own tone.
  assert.deepEqual(tones(syl("你:nǐ | 好:hǎo")), [3, 3]);
  // A third tone before any other tone is unchanged, and marked half.
  const half = syl("我:wǒ 是:shì");
  assert.deepEqual(tones(half), [3, 4]);
  assert.equal(half[0].half, true);
  assert.equal(syl("好:hǎo")[0].half, false);
  // baseTone keeps the dictionary tone for the display.
  assert.deepEqual(syl("你:nǐ 好:hǎo").map((x) => x.baseTone), [3, 3]);
});

test("不: rises before a fourth tone, stays falling elsewhere, anything goes inside A不A", () => {
  assert.deepEqual(tones(syl("不:bù 是:shì")), [2, 4]);
  assert.deepEqual(tones(syl("不:bù 好:hǎo")), [4, 3]);
  assert.deepEqual(tones(syl("不:bù 来:lái")), [4, 2]);
  assert.deepEqual(tones(syl("不:bù")), [4]);
  const aba = syl("是:shì 不:bù 是:shì");
  assert.deepEqual(aba[1].accept.toSorted(), [0, 2, 4]);
  // Before a neutral syllable the lost tone decides: both are right.
  assert.deepEqual(syl("不:bù 了:le")[0].accept.toSorted(), [2, 4]);
});

test("一: yí before a fourth tone, yì before the others, yī as a number or at the end", () => {
  assert.deepEqual(tones(syl("一:yī 个:gè")), [2, 4]);
  assert.deepEqual(tones(syl("一:yī 个:ge")), [2, 0]);
  assert.deepEqual(tones(syl("一:yī 起:qǐ")), [4, 3]);
  assert.deepEqual(tones(syl("一:yī 天:tiān")), [4, 1]);
  assert.deepEqual(tones(syl("一:yī 年:nián")).slice(0, 1), [4]);
  assert.deepEqual(tones(syl("第:dì 一:yī")), [4, 1]);
  assert.deepEqual(tones(syl("十:shí 一:yī")), [2, 1]);
  // 第一个, 一九九八: a number even with something after it; the changed
  // tone is still accepted, never required.
  assert.equal(syl("第:dì 一:yī 个:gè")[1].expectedTone, 1);
  assert.deepEqual(syl("第:dì 一:yī 个:gè")[1].accept, [1, 2]);
  assert.equal(syl("一:yī 九:jiǔ")[0].expectedTone, 1);
  // …but 一百 is a quantity: yì bǎi.
  assert.deepEqual(tones(syl("一:yī 百:bǎi")), [4, 3]);
  // 一月: only a word list could tell; both readings are right.
  assert.deepEqual(syl("一:yī 月:yuè")[0].accept.toSorted(), [1, 2]);
  // 看一看: neutral between the doubled verb, and never flagged.
  assert.deepEqual(syl("看:kàn 一:yī 看:kàn")[1].accept.toSorted(), [0, 1, 2, 4]);
  // A 一 read another way (the app's reader marks it so) is left alone.
  assert.deepEqual(tones(syl("一:yí 个:gè")), [2, 4]);
});

test("expectedSyllables over the app's own reader: Chinese characters only, each with its reading", () => {
  const text = "你好，我是学生。OK";
  const s = expectedSyllables(text, readCodePoints(text, "zh-CN"));
  assert.deepEqual(s.map((x) => x.char).join(""), "你好我是学生");
  assert.deepEqual(tones(s).slice(0, 4), [2, 3, 3, 4]);
  assert.equal(s[2].breakBefore, true);
  // Traditional text with a Taiwan reading: 期 is qí there, qī on the mainland.
  const tw = expectedSyllables("星期", readCodePoints("星期", "zh-TW"));
  assert.deepEqual(tones(tw), [1, 2]);
  assert.deepEqual(tones(expectedSyllables("星期", readCodePoints("星期", "zh-CN"))), [1, 1]);
});

/* ------------------------------ generated speech ---------------------------- */

const RATE = 16_000;
// Chao levels over the syllable, as a learner's textbook draws them.
const SHAPES = { 1: [5, 5, 5], 2: [3, 3.6, 5], 3: [2.2, 1, 2.8], 4: [5, 3.2, 1], low: [2.2, 1.4, 1] };

/** A voice saying `shapes` (keys of SHAPES) one after another: a buzz of
 *  six harmonics whose pitch follows each shape between `lowHz` and
 *  `lowHz` + `spanSt` semitones, `ms` each, `gapMs` of silence between. */
function speak(shapes, { lowHz = 110, spanSt = 10, ms = 260, gapMs = 70 } = {}) {
  const gap = Math.round((RATE * gapMs) / 1000);
  const len = Math.round((RATE * ms) / 1000);
  const out = new Float32Array(gap + shapes.length * (len + gap));
  const timings = [];
  let at = gap;
  for (const name of shapes) {
    const levels = SHAPES[name];
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * (levels.length - 1);
      const k = Math.min(levels.length - 2, Math.floor(x));
      const level = levels[k] + (levels[k + 1] - levels[k]) * (x - k);
      const hz = lowHz * 2 ** ((((level - 1) / 4) * spanSt) / 12);
      phase += (2 * Math.PI * hz) / RATE;
      const env = Math.min(1, i / 240, (len - 1 - i) / 240);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(phase * h) / h;
      out[at + i] = 0.3 * env * v;
    }
    timings.push({ startMs: (at / RATE) * 1000, endMs: ((at + len) / RATE) * 1000 });
    at += len + gap;
  }
  return { samples: out, timings, range: { medianHz: lowHz * 2 ** (spanSt / 24), lowHz, highHz: lowHz * 2 ** (spanSt / 12), frames: 100 } };
}

/** Syllables with the given expected tones and no sandhi between them. */
const expecting = (...ts) => ts.map((t) => ({ char: "字", pinyin: withTone("ma", t), baseTone: t, expectedTone: t, accept: [t], half: false, breakBefore: true }));

test("WAV: what encodeWav writes parseWav reads back, and a non-PCM file is refused", () => {
  const { samples } = speak([1], { ms: 50 });
  const back = parseWav(encodeWav(samples, RATE));
  assert.equal(back.sampleRate, RATE);
  assert.equal(back.samples.length, samples.length);
  assert.ok(Math.abs(back.samples[500] - samples[500]) < 1e-3);
  assert.throws(() => parseWav(new Uint8Array(64)), /not a WAV/);
  const bad = encodeWav(samples, RATE);
  new DataView(bad.buffer).setUint16(34, 8, true);
  assert.throws(() => parseWav(bad), /16-bit PCM/);
});

test("trackPitch: a steady tone, a sweep, silence and noise", () => {
  for (const hz of [90, 220, 440]) {
    const s = new Float32Array(RATE / 2);
    for (let i = 0; i < s.length; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / RATE);
    const tr = trackPitch(s, RATE);
    assert.equal(tr.hopMs, HOP_MS);
    const mid = tr.f0[Math.floor(tr.f0.length / 2)];
    assert.ok(Math.abs(mid - hz) < hz * 0.02, `${hz} Hz read as ${mid}`);
  }
  // 150 → 300 Hz over 400 ms: the track rises with it.
  const sweep = new Float32Array(RATE * 0.4);
  let phase = 0;
  for (let i = 0; i < sweep.length; i++) {
    phase += (2 * Math.PI * (150 * 2 ** (i / sweep.length))) / RATE;
    sweep[i] = 0.4 * Math.sin(phase);
  }
  const tr = trackPitch(sweep, RATE);
  const voiced = [...tr.f0].filter((v) => v > 0);
  assert.ok(voiced.length > 25);
  assert.ok(voiced[3] < 175 && voiced.at(-4) > 265, `${voiced[3]} … ${voiced.at(-4)}`);
  // Silence and white noise have no pitch.
  assert.equal([...trackPitch(new Float32Array(RATE / 4), RATE).f0].filter((v) => v > 0).length, 0);
  let seed = 7;
  const noise = Float32Array.from({ length: RATE / 2 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff - 1) * 0.3);
  const n = [...trackPitch(noise, RATE).f0].filter((v) => v > 0).length;
  assert.ok(n <= 3, `${n} voiced frames in noise`);
});

test("classifyContour: the four textbook shapes, and a level contour that only a range can place", () => {
  const range = { lowSt: 12 * Math.log2(100), highSt: 12 * Math.log2(100) + 10 };
  const at = (levels) => levels.map((l) => range.lowSt + ((l - 1) / 4) * 10);
  assert.equal(classifyContour(at([5, 5, 5, 5, 5]), range).tone, 1);
  assert.equal(classifyContour(at([3, 3.2, 3.8, 4.4, 5]), range).tone, 2);
  assert.equal(classifyContour(at([2.2, 1.4, 1, 1.6, 3]), range).tone, 3);
  assert.equal(classifyContour(at([5, 4.4, 3.4, 2.2, 1]), range).tone, 4);
  // Low and level: a half third with the range, a coin toss with tone 1
  // without it (the shape alone is level).
  const low = at([1.6, 1.4, 1.3, 1.2, 1.2]);
  assert.equal(classifyContour(low, range).tone, 3);
  assert.ok(classifyContour(low, range).belief[1] < 0.05);
  assert.ok(classifyContour(low, null).belief[1] > 0.2);
  // The belief sums to one.
  const b = classifyContour(at([5, 5, 5, 5, 5]), range).belief;
  assert.ok(Math.abs(b[1] + b[2] + b[3] + b[4] - 1) < 1e-9);
});

test("scoreTones: each tone said and expected is ok, for a low adult voice and a child's", () => {
  for (const voice of [{ lowHz: 85, spanSt: 9 }, { lowHz: 180, spanSt: 11 }, { lowHz: 300, spanSt: 10 }]) {
    for (const tone of [1, 2, 3, 4]) {
      const { samples, range } = speak([tone], voice);
      const r = scoreTones({ samples, sampleRate: RATE, syllables: expecting(tone), speaker: range });
      assert.equal(r.provider, "local");
      assert.equal(r.syllables[0].heardTone, tone, `tone ${tone} at ${voice.lowHz} Hz heard as ${r.syllables[0].heardTone}`);
      assert.equal(r.syllables[0].verdict, "ok");
      assert.ok(r.syllables[0].confidence > 0.5);
    }
  }
});

test("scoreTones: a clearly different tone is off, with timings and without, and the result carries the curve", () => {
  const { samples, timings, range } = speak([1, 4, 2, 1]);
  // Said mā mà má mā; expected mā mā má mà: the second and fourth are wrong.
  const label = expecting(1, 1, 2, 4);
  for (const t of [timings, null]) {
    const r = scoreTones({ samples, sampleRate: RATE, syllables: label, timings: t, speaker: range });
    assert.deepEqual(r.syllables.map((s) => s.heardTone), [1, 4, 2, 1], t ? "timed" : "cut by energy");
    assert.deepEqual(r.syllables.map((s) => s.verdict), ["ok", "off", "ok", "off"], t ? "timed" : "cut by energy");
    assert.equal(r.timed, t ? "given" : "fallback");
    assert.equal(r.overall, 50);
    for (const s of r.syllables) {
      assert.equal(s.pitch.length, 16);
      assert.ok(s.endMs > s.startMs);
      assert.ok(s.confidence > 0.5 && s.confidence <= 1);
    }
    // The first syllable is high and level: its curve sits above the
    // speaker's median and barely moves.
    const curve = r.syllables[0].pitch.filter((v) => v !== null);
    assert.ok(Math.min(...curve) > 2 && Math.max(...curve) - Math.min(...curve) < 1.5, JSON.stringify(curve));
  }
  // Scribe-style anchors (a point inside each syllable, not its extent):
  // the cuts are still made by energy, and the verdicts are the same.
  const anchors = timings.map((t) => t.startMs + 0.6 * (t.endMs - t.startMs));
  const a = scoreTones({ samples, sampleRate: RATE, syllables: label, anchors, speaker: range });
  assert.equal(a.timed, "anchored");
  assert.deepEqual(a.syllables.map((s) => s.verdict), ["ok", "off", "ok", "off"]);
});

test("scoreTones: the half third (low, no rise) is a right third tone, and sandhi is applied before comparing", () => {
  // 我是: wǒ said low and falling, then shì.
  const { samples, timings, range } = speak(["low", 4]);
  const syllables = syl("我:wǒ 是:shì");
  const r = scoreTones({ samples, sampleRate: RATE, syllables, timings, speaker: range });
  assert.deepEqual(r.syllables.map((s) => s.verdict), ["ok", "ok"]);
  // 你好 said ní hǎo is right; said with two full third tones it is not
  // flagged either (3 for an expected 2 that started as a 3 is lenient in
  // longer runs only): here the first is expected 2 and heard 2.
  const nihao = speak([2, 3]);
  const ok = scoreTones({ samples: nihao.samples, sampleRate: RATE, syllables: syl("你:nǐ 好:hǎo"), timings: nihao.timings, speaker: nihao.range });
  assert.deepEqual(ok.syllables.map((s) => [s.expectedTone, s.heardTone, s.verdict]), [[2, 2, "ok"], [3, 3, "ok"]]);
});

test("unsure, not off: short, unvoiced, neutral, untimed, and anything under the confidence bar", () => {
  // 40 ms of voice is too little to call.
  const short = speak([4], { ms: 40 });
  const s1 = scoreTones({ samples: short.samples, sampleRate: RATE, syllables: expecting(1), speaker: short.range }).syllables[0];
  assert.equal(s1.verdict, "unsure");
  assert.ok(["short", "unvoiced"].includes(s1.reason), s1.reason);
  assert.equal(s1.confidence, 0);

  // Silence: nothing voiced.
  const silent = scoreTones({ samples: new Float32Array(RATE / 2), sampleRate: RATE, syllables: expecting(1), timings: [{ startMs: 100, endMs: 400 }] }).syllables[0];
  assert.deepEqual([silent.verdict, silent.reason, silent.heardTone], ["unsure", "unvoiced", null]);

  // An expected neutral tone is never judged.
  const one = speak([4]);
  const neutral = scoreTones({ samples: one.samples, sampleRate: RATE, syllables: expecting(0), speaker: one.range }).syllables[0];
  assert.deepEqual([neutral.verdict, neutral.reason], ["unsure", "neutral"]);

  // A syllable the transcript had no timing for is left alone.
  const two = speak([1, 1]);
  const untimed = scoreTones({ samples: two.samples, sampleRate: RATE, syllables: expecting(1, 4), timings: [two.timings[0], null], speaker: two.range }).syllables[1];
  assert.deepEqual([untimed.verdict, untimed.reason], ["unsure", "untimed"]);

  // A clean fourth tone where a first was expected is off…
  const args = { samples: one.samples, sampleRate: RATE, syllables: expecting(1), speaker: one.range };
  assert.equal(scoreTones(args).syllables[0].verdict, "off");
  // …and each bar on its own keeps it quiet: a measurement not clean
  // enough, a stretch not long enough, a heard tone not clear enough.
  for (const bar of [{ offQuality: 1.01 }, { offMinMs: 5000 }, { offBelief: 1.01 }]) {
    const s = scoreTones({ ...args, rules: { ...TONE_RULES, ...bar } }).syllables[0];
    assert.deepEqual([s.verdict, s.reason, s.heardTone], ["unsure", "unclear", 4], JSON.stringify(bar));
  }

  // A droop of three semitones where a first tone was expected: not level,
  // not a fall either. Whatever the best match is, it is not flagged.
  SHAPES.droop = [4.8, 4.4, 3.6];
  const droop = speak(["droop"]);
  assert.notEqual(scoreTones({ samples: droop.samples, sampleRate: RATE, syllables: expecting(1), speaker: droop.range }).syllables[0].verdict, "off");

  // Third against fourth is never flagged either way (a half third after a
  // high tone falls like a fourth), nor a low level pitch against a first
  // tone when the speaker's range is unknown.
  const fall = speak([4]);
  assert.notEqual(scoreTones({ samples: fall.samples, sampleRate: RATE, syllables: expecting(3), speaker: fall.range }).syllables[0].verdict, "off");
  const low = speak(["low"]);
  assert.notEqual(scoreTones({ samples: low.samples, sampleRate: RATE, syllables: expecting(4), speaker: low.range }).syllables[0].verdict, "off");
  SHAPES.lowLevel = [1.3, 1.3, 1.3];
  const flat = speak(["lowLevel"]);
  assert.notEqual(scoreTones({ samples: flat.samples, sampleRate: RATE, syllables: expecting(3) }).syllables[0].verdict, "off");
});

test("rulesOut: what a contour cannot be, and the middle ground where nothing is ruled out", () => {
  const no = (five, levels) => Object.entries(rulesOut(five, levels)).filter(([, v]) => v).map(([k]) => Number(k));
  // Level: not a rise, not a fall; a third tone only if it is known to be high.
  assert.deepEqual(no([50, 50.3, 50.2, 50.1, 50]), [2, 4]);
  assert.deepEqual(no([50, 50.3, 50.2, 50.1, 50], [4.6, 4.7, 4.7, 4.6, 4.6]), [2, 3, 4]);
  assert.deepEqual(no([50, 50.3, 50.2, 50.1, 50], [1.4, 1.5, 1.5, 1.4, 1.4]), [2, 4]);
  // A six-semitone fall: not level, not a rise. Third and fourth both remain.
  assert.deepEqual(no([56, 55, 53, 51, 50]), [1, 2]);
  // A six-semitone rise: not level, not a fall. Second and third both remain.
  assert.deepEqual(no([50, 50.5, 52, 54, 56]), [1, 4]);
  // A dip and a rise: only the level tone is out.
  assert.deepEqual(no([53, 50, 49, 51, 54]), [1]);
  // Three semitones of droop or lift: nothing is ruled out, so nothing can be flagged.
  assert.deepEqual(no([53, 52.5, 51.5, 50.5, 50]), []);
  assert.deepEqual(no([50, 50.5, 51.5, 52.5, 53]), []);
  // The neutral tone is never ruled out.
  assert.equal(rulesOut([56, 55, 53, 51, 50])[0], false);
});

test("segmentSyllables: the right number of pieces, at the gaps", () => {
  const { samples, timings } = speak([1, 2, 4]);
  const tr = trackPitch(samples, RATE);
  const cuts = segmentSyllables(tr, 3);
  assert.equal(cuts.length, 3);
  cuts.forEach((c, i) => {
    const mid = (timings[i].startMs + timings[i].endMs) / 2;
    assert.ok(c.startMs < mid && mid < c.endMs, `piece ${i}: ${c.startMs}–${c.endMs} misses ${mid}`);
  });
  assert.equal(segmentSyllables(tr, 1).length, 1);
  // Three sounds, two syllables: which gap is the boundary is anyone's
  // guess until each syllable has a point known to lie inside it (Scribe's
  // character times). The cut then falls where the anchors say.
  const mid = (t) => (t.startMs + t.endMs) / 2;
  const first = segmentSyllables(tr, 2, { anchorsMs: [mid(timings[0]), mid(timings[1])] });
  assert.ok(first[0].endMs < timings[1].startMs + 20 && first[1].startMs < mid(timings[1]), JSON.stringify(first));
  const second = segmentSyllables(tr, 2, { anchorsMs: [mid(timings[1]), mid(timings[2])] });
  assert.ok(second[0].endMs > timings[1].endMs - 20 && second[0].startMs < mid(timings[1]), JSON.stringify(second));
  // An anchor list of the wrong length is ignored, a null anchor is free.
  assert.equal(segmentSyllables(tr, 3, { anchorsMs: [100] }).length, 3);
  assert.equal(segmentSyllables(tr, 3, { anchorsMs: [null, mid(timings[1]), null] }).length, 3);
  assert.deepEqual(segmentSyllables(tr, 0), []);
  assert.deepEqual(segmentSyllables(trackPitch(new Float32Array(RATE / 4), RATE), 2), []);
});

test("speakerRange and the curves for a narrator's clip", () => {
  const { samples, timings } = speak([1, 4], { lowHz: 200, spanSt: 12 });
  const tr = trackPitch(samples, RATE);
  const range = speakerRange(tr);
  assert.ok(range.lowHz >= 195 && range.lowHz < 260, String(range.lowHz));
  assert.ok(range.highHz > 370 && range.highHz <= 405, String(range.highHz));
  assert.equal(speakerRange(trackPitch(new Float32Array(RATE / 4), RATE)), null);
  // pitchCurve: semitones against a reference, null where there is no voice.
  const curve = pitchCurve(tr, timings[1].startMs, timings[1].endMs, 200, 8);
  assert.equal(curve.length, 8);
  assert.ok(curve[1] > 9 && curve[6] < 3, JSON.stringify(curve));
  assert.deepEqual(pitchCurve(tr, 0, 40, 200, 4), [null, null, null, null]);
  // The same from reference audio, cut by energy or by given timings.
  for (const t of [null, timings]) {
    const ref = referenceCurves({ samples, sampleRate: RATE, count: 2, timings: t, points: 12 });
    assert.equal(ref.length, 2);
    assert.equal(ref[0].pitch.length, 12);
    const fall = ref[1].pitch.filter((v) => v !== null);
    assert.ok(fall[0] - fall.at(-1) > 6, JSON.stringify(fall));
  }
});

/* ----------------------------------- Scribe --------------------------------- */

test("scribeCharTimings and alignTimings: character timings when given, even shares of a word when not, an extra word skipped", () => {
  // The documented shape: words[] with start/end in seconds, a characters[]
  // inside each when asked for character granularity.
  const json = {
    text: "嗯你好吗",
    words: [
      { text: "嗯", start: 0.05, end: 0.2, type: "word", logprob: -0.2 },
      { text: " ", start: 0.2, end: 0.25, type: "spacing", logprob: 0 },
      { text: "你好", start: 0.25, end: 0.75, type: "word", logprob: -0.1, characters: [{ text: "你", start: 0.25, end: 0.45 }, { text: "好", start: 0.45, end: 0.75 }] },
      { text: "吗", start: 0.8, end: 1.0, type: "word", logprob: -0.1 },
      { text: "(laughs)", start: 1.0, end: 1.4, type: "audio_event", logprob: 0 },
    ],
  };
  const timed = scribeCharTimings(json);
  assert.deepEqual(timed.map((t) => t.char).join(""), "嗯你好吗");
  assert.deepEqual(timed[2], { char: "好", startMs: 450, endMs: 750 });
  // No characters[]: the word's time is shared out evenly.
  const even = scribeCharTimings({ words: [{ text: "你好", start: 1, end: 2, type: "word" }] });
  assert.deepEqual(even, [{ char: "你", startMs: 1000, endMs: 1500 }, { char: "好", startMs: 1500, endMs: 2000 }]);
  assert.deepEqual(scribeCharTimings({ text: "x" }), []);
  // The learner said 嗯 first; 你好吗 still lines up, and a character the
  // transcript lacks gets no timing.
  const cuts = alignTimings([{ char: "你" }, { char: "好" }, { char: "呢" }, { char: "吗" }], timed);
  assert.deepEqual(cuts, [{ startMs: 250, endMs: 450 }, { startMs: 450, endMs: 750 }, null, { startMs: 800, endMs: 1000 }]);
});

/* ------------------------------------ Azure --------------------------------- */

test("azurePronunciationHeader: base64 JSON of the documented parameters", () => {
  const scripted = JSON.parse(Buffer.from(azurePronunciationHeader({ referenceText: "你好" }), "base64").toString("utf8"));
  assert.deepEqual(scripted, { ReferenceText: "你好", GradingSystem: "HundredMark", Granularity: "Phoneme", Dimension: "Comprehensive", EnableMiscue: "True" });
  // Free speech scored against its own transcript: nothing can be omitted.
  const free = JSON.parse(Buffer.from(azurePronunciationHeader({ referenceText: "我是学生", scripted: false }), "base64").toString("utf8"));
  assert.equal(free.EnableMiscue, "False");
  // The docs' own example value round-trips the same way.
  assert.ok(azurePronunciationHeader({ referenceText: "Good morning." }).startsWith("eyJSZWZlcm"));
});

test("azurePronunciationRequest: the short-audio endpoint, the language, the headers; bad input refused", () => {
  const audio = new Uint8Array(100);
  const { url, init } = azurePronunciationRequest({ key: "k", region: "eastus", audio, locale: "zh-TW", referenceText: "你好" });
  assert.equal(url, "https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-TW&format=detailed");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Ocp-Apim-Subscription-Key"], "k");
  assert.equal(init.headers["Content-Type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
  assert.equal(init.headers.Accept, "application/json");
  assert.equal(JSON.parse(Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8")).ReferenceText, "你好");
  assert.equal(init.body, audio);
  // A resource's own endpoint, in the form the current docs give.
  const own = azurePronunciationRequest({ key: "k", endpoint: "https://myres.cognitiveservices.azure.com/", audio, locale: "es-MX", referenceText: "hola" });
  assert.equal(own.url, "https://myres.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1?language=es-MX&format=detailed");
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "east us/..", audio, locale: "zh-CN", referenceText: "你好" }), /region/);
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "eastus", audio, locale: "zh-CN&x=1", referenceText: "你好" }), /locale/);
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "eastus", audio, locale: "zh-CN", referenceText: " " }), /reference text/);
  assert.throws(() => azurePronunciationRequest({ key: "k", endpoint: "http://plain.example", audio, locale: "zh-CN", referenceText: "你好" }), /https/);
  // Thirty seconds of the browser's WAV.
  assert.equal(AZURE_MAX_WAV_BYTES, 960_044);
});

// The reply on the REST page (rest-speech-to-text-short, "recognition with
// pronunciation assessment"), prosody feedback trimmed: scores flat on the
// NBest entry and on each word.
const REST_SAMPLE = {
  RecognitionStatus: "Success", Offset: 700000, Duration: 8400000, DisplayText: "Good morning.", SNR: 38.76819,
  NBest: [{
    Confidence: 0.98503506, Lexical: "good morning", ITN: "good morning", MaskedITN: "good morning", Display: "Good morning.",
    AccuracyScore: 100.0, FluencyScore: 100.0, ProsodyScore: 87.8, CompletenessScore: 100.0, PronScore: 95.1,
    Words: [
      { Word: "good", Offset: 700000, Duration: 2600000, Confidence: 0.0, AccuracyScore: 100.0, ErrorType: "None" },
      { Word: "morning", Offset: 3400000, Duration: 5700000, Confidence: 0.0, AccuracyScore: 100.0, ErrorType: "None" },
    ],
  }],
};

// The reply on the how-to page (how-to-pronunciation-assessment, "hello"),
// NBestPhonemes trimmed: scores inside PronunciationAssessment, a numeric
// status, syllables and phonemes with their own timings.
const HOWTO_SAMPLE = {
  Id: "bbb42ea51bdb46d19a1d685e635fe173", RecognitionStatus: 0, Offset: 7500000, Duration: 13800000, DisplayText: "Hello.",
  NBest: [{
    Confidence: 0.975003, Lexical: "hello", ITN: "hello", MaskedITN: "hello", Display: "Hello.",
    PronunciationAssessment: { AccuracyScore: 100, FluencyScore: 100, CompletenessScore: 100, PronScore: 100 },
    Words: [{
      Word: "hello", Offset: 7500000, Duration: 13800000,
      PronunciationAssessment: { AccuracyScore: 99.0, ErrorType: "None" },
      Syllables: [
        { Syllable: "hɛ", PronunciationAssessment: { AccuracyScore: 91.0 }, Offset: 7500000, Duration: 4100000 },
        { Syllable: "loʊ", PronunciationAssessment: { AccuracyScore: 100.0 }, Offset: 11700000, Duration: 9600000 },
      ],
      Phonemes: [
        { Phoneme: "h", PronunciationAssessment: { AccuracyScore: 98.0 }, Offset: 7500000, Duration: 3500000 },
        { Phoneme: "ɛ", PronunciationAssessment: { AccuracyScore: 47.0 }, Offset: 11100000, Duration: 500000 },
      ],
    }],
  }],
};

test("azurePronunciationResult: both documented layouts, times in milliseconds, failures named", () => {
  const rest = azurePronunciationResult(REST_SAMPLE);
  assert.equal(rest.status, "Success");
  assert.equal(rest.text, "Good morning.");
  assert.deepEqual([rest.overall, rest.accuracy, rest.fluency, rest.completeness], [95.1, 100, 100, 100]);
  assert.deepEqual(rest.words.map((w) => [w.text, w.startMs, w.endMs, w.score, w.error]), [["good", 70, 330, 100, "None"], ["morning", 340, 910, 100, "None"]]);

  const howto = azurePronunciationResult(HOWTO_SAMPLE);
  assert.equal(howto.status, "Success");
  assert.equal(howto.overall, 100);
  assert.deepEqual([howto.words[0].startMs, howto.words[0].endMs, howto.words[0].score, howto.words[0].error], [750, 2130, 99, "None"]);
  assert.deepEqual(howto.words[0].phonemes.map((p) => [p.name, p.score, p.startMs, p.tone]), [["h", 98, 750, null], ["ɛ", 47, 1110, null]]);

  // Nothing recognised, and junk: no words, no scores, never a throw.
  const none = azurePronunciationResult({ RecognitionStatus: "NoMatch", Offset: 0, Duration: 0 });
  assert.deepEqual([none.status, none.words.length, none.overall], ["NoMatch", 0, null]);
  assert.equal(azurePronunciationResult(null).status, "Error");
  assert.equal(azurePronunciationResult({ RecognitionStatus: "Success", NBest: [{ Words: [null, { Word: 3 }] }] }).words.length, 0);
  // An omitted word has no timing; a tone digit ending a phoneme name is
  // read if Azure ever sends one (undocumented for zh-CN).
  const zh = azurePronunciationResult({ RecognitionStatus: "Success", NBest: [{ Words: [{ Word: "好", ErrorType: "Omission", AccuracyScore: 0, Phonemes: [{ Phoneme: "ao 3", AccuracyScore: 0 }] }] }] });
  assert.deepEqual([zh.words[0].startMs, zh.words[0].error, zh.words[0].phonemes[0].tone], [null, "Omission", 3]);
});

// A live zh-CN reply, recorded 2026-11-18 (eastus, F0) for a synthesized
// 你好: flat scores, one word of two characters, and a "phoneme" per
// syllable named with its dictionary tone.
const LIVE_ZH = {
  RecognitionStatus: "Success", Offset: 400000, Duration: 4800000, DisplayText: "你好。", SNR: 12.736702,
  NBest: [{
    Confidence: 0.9495999, Lexical: "你好", ITN: "你好", MaskedITN: "你好", Display: "你好。",
    AccuracyScore: 86.0, FluencyScore: 100.0, CompletenessScore: 100.0, PronScore: 91.6,
    Words: [{
      Word: "你好", Offset: 400000, Duration: 4800000, Confidence: 0.0, AccuracyScore: 86.0, ErrorType: "None",
      Syllables: [{ Syllable: "", Grapheme: "你好", Offset: 400000, Duration: 4800000, AccuracyScore: 88.0 }],
      Phonemes: [
        { Phoneme: "ni 3", Offset: 400000, Duration: 1700000, AccuracyScore: 92.0 },
        { Phoneme: "hao 3", Offset: 2200000, Duration: 3000000, AccuracyScore: 87.0 },
      ],
    }],
  }],
};

test("Azure's live Mandarin reply: a syllable per phoneme, timed and scored, its tone the reference's", () => {
  const azure = azurePronunciationResult(LIVE_ZH);
  assert.deepEqual([azure.status, azure.overall, azure.words.length], ["Success", 91.6, 1]);
  assert.deepEqual(azure.words[0].phonemes, [
    { name: "ni 3", score: 92, startMs: 40, endMs: 210, tone: 3 },
    { name: "hao 3", score: 87, startMs: 220, endMs: 520, tone: 3 },
  ]);
  // The merge takes each character's cut and score from its phoneme, not
  // an even share of the word.
  const syllables = expectedSyllables("你好", ["nǐ", "hǎo"]);
  let seen = null;
  const local = (cuts) => {
    seen = cuts;
    return { speaker: null, syllables: syllables.map((s, i) => ({ ...s, heardTone: s.expectedTone, verdict: "ok", confidence: 0.9, startMs: cuts[i].startMs, endMs: cuts[i].endMs, pitch: [] })) };
  };
  const r = mergeAzure({ azure, syllables, local });
  assert.deepEqual(seen, [{ startMs: 40, endMs: 210 }, { startMs: 220, endMs: 520 }]);
  assert.deepEqual(r.syllables.map((s) => [s.char, s.score, s.verdict]), [["你", 92, "ok"], ["好", 87, "ok"]]);
  assert.equal(r.overall, 92);
});

test("mergeAzure: Azure's timings, the local tone check on them, one result", () => {
  // Said mā mà má mā (generated), expected 妈 妈 麻 骂. A zh reply in the
  // documented layout (the docs have no Chinese sample: this one is written
  // by hand in the REST page's shape, one character per word and one word
  // of two).
  const { samples, timings, range } = speak([1, 4, 2, 1]);
  const ticks = (ms) => Math.round(ms * 10_000);
  const word = (text, a, b, score, error = "None") => ({ Word: text, Offset: ticks(a), Duration: ticks(b - a), AccuracyScore: score, ErrorType: error });
  const reply = {
    RecognitionStatus: "Success", DisplayText: "妈妈麻骂。",
    NBest: [{
      Display: "妈妈麻骂。", AccuracyScore: 71, FluencyScore: 90, CompletenessScore: 100, PronScore: 78.4,
      Words: [
        word("妈", timings[0].startMs, timings[0].endMs, 96),
        word("妈", timings[1].startMs, timings[1].endMs, 88),
        // 麻骂 as one word: the scorer cuts inside it.
        word("麻骂", timings[2].startMs, timings[3].endMs, 90),
      ],
    }],
  };
  const syllables = expectedSyllables("妈妈麻骂", ["mā", "mā", "má", "mà"]);
  const track = trackPitch(samples, RATE);
  const local = (cuts) => scoreTones({ samples, sampleRate: RATE, syllables, timings: cuts, speaker: range, track });
  const r = mergeAzure({ azure: azurePronunciationResult(reply), syllables, local, track });
  assert.equal(r.provider, "azure");
  assert.equal(r.overall, 78);
  assert.deepEqual(r.syllables.map((s) => s.heardTone), [1, 4, 2, 1]);
  // Azure liked the second 妈 (88) but the pitch fell: the tone flag stands.
  assert.deepEqual(r.syllables.map((s) => s.verdict), ["ok", "off", "ok", "off"]);
  assert.deepEqual(r.syllables.map((s) => s.reason), [undefined, "tone", undefined, "tone"]);
  assert.deepEqual(r.syllables.map((s) => s.score), [96, 88, 90, 90]);
  assert.ok(r.syllables.every((s) => s.pitch.length === 16 && s.endMs > s.startMs));

  // Azure's own flags: a mispronounced word under the bar is off for its
  // sound even when the tone was right; an omitted word is unsure; a word
  // Azure heard that wasn't expected is skipped.
  const flagged = structuredClone(reply);
  flagged.NBest[0].Words = [
    word("嗯", 0, 10, 50, "Insertion"),
    word("妈", timings[0].startMs, timings[0].endMs, AZURE_RULES.offBelow - 10, "Mispronunciation"),
    { Word: "妈", AccuracyScore: 0, ErrorType: "Omission" },
    word("麻", timings[2].startMs, timings[2].endMs, 70, "Mispronunciation"),
    word("骂", timings[3].startMs, timings[3].endMs, 95),
  ];
  const f = mergeAzure({ azure: azurePronunciationResult(flagged), syllables, local, track });
  assert.deepEqual(f.syllables.map((s) => [s.verdict, s.reason]), [["off", "sound"], ["unsure", "omitted"], ["ok", undefined], ["off", "tone"]]);

  // Nothing recognised: every syllable unsure, nothing thrown, the local
  // scorer never called.
  const empty = mergeAzure({ azure: azurePronunciationResult({ RecognitionStatus: "NoMatch" }), syllables, local: () => assert.fail("not called") });
  assert.deepEqual(empty.syllables.map((s) => [s.verdict, s.reason]), syllables.map(() => ["unsure", "untimed"]));
  assert.equal("overall" in empty, false);
});
