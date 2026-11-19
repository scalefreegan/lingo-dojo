import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  LOCAL_MAX_SECONDS, LOCAL_MAX_SYLLABLES, AZURE_MAX_SECONDS, AZURE_MAX_WAV_BYTES, AZURE_RULES, HOP_MS, TONE_RULES, alignTimings, azureLocale, azurePronunciationHeader, azurePronunciationRequest, azurePronunciationResult,
  classifyContour, encodeWav, expectedSyllables, mergeAzure, parsePinyin, parseWav, pitchCurve, pronunciationProvider, referenceCurves, ruleMargins, rulesOut, scoreTones,
  scoresTones, scribeCharTimings, segmentSyllables, speakerRange, trackPitch, trimToSpeech, withTone, TRIM_RULES,
} from "../pronunciation.mjs";
import { CURVES, GENERATED_PHRASES, LAST_SYLLABLE_CASES, NOISE_CONDITIONS, RATE, emptyTally, speak, surround, tallyLabellings } from "../pronunciation-synth.mjs";
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
  for (const l of ["zh-CN", "zh-TW", "zh", "zh-Hant-TW", "cmn-TW", "zh_TW", "zh-SG", "cmn-Hans-CN"]) assert.equal(scoresTones(l), true, l);
  // Cantonese under any name, other languages, and anything that isn't a
  // plain language[-Script][-REGION] tag.
  for (const l of ["zh-HK", "zh-Hant-MO", "zh-yue", "yue-HK", "zh-CN&x=1", "zh/CN", "zh-CN-x-1", "es-MX", "en-US", "", null]) assert.equal(scoresTones(l), false, String(l));
});

test("one locale parser: every locale scoresTones accepts has an Azure name, and nothing else Chinese does", () => {
  const all = ["zh", "zh-CN", "zh_TW", "zh-Hant-TW", "zh-Hant", "zh-Hans", "cmn-Hans-CN", "cmn-TW", "zh-SG", "zh-MY", "zh-HK", "zh-Hant-MO", "zh-yue", "zh-CN&x=1", "zh-CN-x-1", "zh/CN", ""];
  for (const l of all) {
    if (scoresTones(l)) assert.match(azureLocale(l), /^zh-(CN|TW)$/, l);
    else assert.throws(() => azureLocale(l), /locale/, l);
  }
  // Singapore has no Azure model of its own: mainland Mandarin.
  assert.equal(azureLocale("zh-SG"), "zh-CN");
  assert.equal(azureLocale("es-mx"), "es-MX");
  assert.throws(() => azureLocale("es"), /locale/);
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

test("a third tone doubled into a neutral one may rise: 姐姐, 奶奶, 宝宝", () => {
  for (const [a, py] of [["姐", "jiě"], ["奶", "nǎi"], ["姥", "lǎo"], ["宝", "bǎo"]]) {
    const s = syl(`${a}:${py} ${a}:${parsePinyin(py).base}`);
    assert.deepEqual(tones(s), [3, 0]);
    assert.deepEqual(s[0].accept, [3, 2], a);
  }
  // Only its own copy: 你的 and 好吗 keep a plain third tone.
  assert.deepEqual(syl("你:nǐ 的:de")[0].accept, [3]);
  assert.deepEqual(syl("好:hǎo 吗:ma")[0].accept, [3]);
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
  // 一 after another syllable may end a word, where it stays yī whatever
  // follows: 统一了, 唯一的, 统一思想. Only a word list could tell, so yī
  // is right there too…
  assert.deepEqual(syl("统:tǒng 一:yī 了:le")[1].accept.toSorted(), [1, 2, 4]);
  assert.deepEqual(syl("唯:wéi 一:yī 的:de")[1].accept.toSorted(), [1, 2, 4]);
  assert.deepEqual(syl("统:tǒng 一:yī 思:sī 想:xiǎng")[1].accept.toSorted(), [1, 4]);
  // (And the same after a third tone doubled into a neutral one: below.)
  // …but at the start of a phrase it can only be the changing 一.
  assert.deepEqual(syl("一:yī 起:qǐ")[0].accept, [4]);
  assert.deepEqual(syl("好:hǎo | 一:yī 个:gè")[1].accept, [2]);
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

// The generated voice (speak, CURVES, sessionRange) lives in
// scripts/pronunciation-synth.mjs, where the proof uses it too.

/** Syllables with the given expected tones and no sandhi between them. */
const expecting = (...ts) => ts.map((t) => ({ char: "字", pinyin: withTone("ma", t), baseTone: t, expectedTone: t, accept: [t], half: false, breakBefore: true }));
/** The same as one phrase: only the first follows a break. */
const phrase = (...ts) => expecting(...ts).map((s, i) => ({ ...s, breakBefore: i === 0 }));
const verdicts = (r) => r.syllables.map((s) => s.verdict);

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

test("trackPitch: an octave-high onset is put back and does not drag the syllable with it; a missing fundamental is still heard", () => {
  // 110 Hz whose first 50 ms have only the even harmonics: those frames
  // read 220 Hz. The rest must stay at 110 (the old correction compared
  // each frame with the corrected one before it and moved them all).
  const s = new Float32Array(RATE * 0.4);
  for (let i = 0; i < s.length; i++) {
    const ph = (2 * Math.PI * 110 * i) / RATE;
    const onset = i < RATE * 0.05;
    let v = 0;
    for (let h = 1; h <= 6; h++) if (!onset || h % 2 === 0) v += Math.sin(ph * h) / h;
    s[i] = 0.3 * v;
  }
  const voiced = [...trackPitch(s, RATE).f0].filter((v) => v > 0);
  assert.ok(voiced.length > 30);
  const near = (hz) => voiced.filter((v) => Math.abs(v - hz) < hz * 0.06).length;
  assert.ok(near(110) >= voiced.length - 2, `${near(110)} of ${voiced.length} frames at 110 Hz, ${near(220)} at 220`);
  // A whole syllable an octave up stays there: nothing to compare it with.
  const high = new Float32Array(RATE * 0.3);
  for (let i = 0; i < high.length; i++) high[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  const up = [...trackPitch(high, RATE).f0].filter((v) => v > 0);
  assert.ok(up.every((v) => Math.abs(v - 220) < 8));
  // And a real fall of an octave inside one syllable is left alone.
  const fall = new Float32Array(RATE * 0.3);
  let phase = 0;
  for (let i = 0; i < fall.length; i++) {
    phase += (2 * Math.PI * 300 * 2 ** (-i / fall.length)) / RATE;
    fall[i] = 0.3 * (Math.sin(phase) + Math.sin(2 * phase) / 2);
  }
  const down = [...trackPitch(fall, RATE).f0].filter((v) => v > 0);
  assert.ok(down[2] > 270 && down.at(-3) < 170, `${down[2]} … ${down.at(-3)}`);
  // The same slip in the middle of a syllable: 60 ms of the vowel read an
  // octave up, with right frames on both sides.
  const mid = new Float32Array(RATE * 0.4);
  for (let i = 0; i < mid.length; i++) {
    const ph = (2 * Math.PI * 110 * i) / RATE;
    const slip = i > RATE * 0.17 && i < RATE * 0.23;
    let v = 0;
    for (let h = 1; h <= 6; h++) if (!slip || h % 2 === 0) v += Math.sin(ph * h) / h;
    mid[i] = 0.3 * v;
  }
  const midVoiced = [...trackPitch(mid, RATE).f0].filter((v) => v > 0);
  assert.ok(midVoiced.length > 30 && midVoiced.filter((v) => Math.abs(v - 110) < 7).length >= midVoiced.length - 2, JSON.stringify(midVoiced.map(Math.round)));
  // A small child's first tone is above the old 600 Hz ceiling.
  const child = new Float32Array(RATE * 0.3);
  for (let i = 0; i < child.length; i++) child[i] = 0.3 * (Math.sin((2 * Math.PI * 640 * i) / RATE) + Math.sin((4 * Math.PI * 640 * i) / RATE) / 2);
  const c = [...trackPitch(child, RATE).f0].filter((v) => v > 0);
  assert.ok(c.length > 20 && c.every((v) => Math.abs(v - 640) < 20), JSON.stringify(c.slice(0, 5)));
  // No fundamental at all (harmonics 2 to 6 of 150 Hz): the period is still 150.
  const weak = speak([(x) => 3 + 0 * x], { lowHz: 106, spanSt: 12, weak: true, declineSt: 0, jitter: 0 });
  const w = [...trackPitch(weak.samples, RATE).f0].filter((v) => v > 0);
  assert.ok(w.length > 15 && w.every((v) => Math.abs(v - 150) < 8), JSON.stringify(w.slice(0, 6)));
});

test("classifyContour: the four textbook shapes, and a level contour that only a range can place", () => {
  const range = { lowSt: 12 * Math.log2(100), highSt: 12 * Math.log2(100) + 10 };
  const at = (levels, span = 10) => levels.map((l) => range.lowSt + ((l - 1) / 4) * span);
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
  // With no range the size of a step is unknown: a narrow voice (five
  // semitones top to bottom) and a wide one (fifteen) are read by shape.
  for (const span of [5, 15]) {
    assert.equal(classifyContour(at([3, 3.2, 3.8, 4.4, 5], span), null).tone, 2, `rise, ${span} st`);
    assert.equal(classifyContour(at([5, 4.4, 3.4, 2.2, 1], span), null).tone, 4, `fall, ${span} st`);
    assert.equal(classifyContour(at([2.2, 1.4, 1, 1.6, 3], span), null).tone, 3, `dip, ${span} st`);
  }
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
    assert.deepEqual(verdicts(r), ["ok", "off", "ok", "off"], t ? "timed" : "cut by energy");
    assert.equal(r.timed, t ? "given" : "fallback");
    assert.equal(r.overall, 50);
    for (const s of r.syllables) {
      assert.equal(s.pitch.length, 16);
      assert.ok(s.endMs > s.startMs);
      assert.ok(s.confidence > 0.5 && s.confidence <= 1);
    }
    // A flag says by how much the contour rules the label out.
    assert.ok(r.syllables[1].margin > 0 && r.syllables[0].margin < 0);
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
  assert.deepEqual(verdicts(a), ["ok", "off", "ok", "off"]);
});

test("scoreTones: every tone said for every other, in a known voice: what is flagged and what never is", () => {
  const flagged = {};
  for (const said of [1, 2, 3, 4]) {
    for (const want of [1, 2, 3, 4]) {
      if (said === want) continue;
      const { samples, range } = speak([said], { lowHz: 140 });
      flagged[`${said}→${want}`] = scoreTones({ samples, sampleRate: RATE, syllables: expecting(want), speaker: range }).syllables[0].verdict === "off";
    }
  }
  // A full third (down and back up) against a second, and a third against a
  // fourth, share too much of their shape: never flagged. Everything else is.
  const quiet = Object.entries(flagged).filter(([, off]) => !off).map(([k]) => k).sort();
  assert.deepEqual(quiet, ["3→2", "3→4"], JSON.stringify(flagged));
  // A fourth tone said for a third is caught by where it starts, which
  // needs the speaker's range: without one it is not flagged.
  const fall = speak([4], { lowHz: 140 });
  assert.notEqual(scoreTones({ samples: fall.samples, sampleRate: RATE, syllables: expecting(3) }).syllables[0].verdict, "off");
  // A low fall with no rise (a half third) said for a second is a flag
  // once it falls far enough to be no accident; for a fourth it never is
  // (a low fall is both).
  const low = speak([(x) => 2.7 - 1.7 * x], { lowHz: 140 });
  assert.equal(scoreTones({ samples: low.samples, sampleRate: RATE, syllables: expecting(2), speaker: low.range }).syllables[0].verdict, "off");
  assert.notEqual(scoreTones({ samples: low.samples, sampleRate: RATE, syllables: expecting(4), speaker: low.range }).syllables[0].verdict, "off");
  const sinking = speak(["low"], { lowHz: 140 });
  assert.notEqual(scoreTones({ samples: sinking.samples, sampleRate: RATE, syllables: expecting(2), speaker: sinking.range }).syllables[0].verdict, "off");
});

test("scoreTones: declination, a narrow voice with no range, a weak fundamental and noise don't turn right into off", () => {
  // Four first tones, the pitch sinking two semitones across the phrase.
  const sag = speak([1, 1, 1, 1], { declineSt: 2 });
  for (const speaker of [sag.range, null]) assert.ok(!verdicts(scoreTones({ samples: sag.samples, sampleRate: RATE, syllables: expecting(1, 1, 1, 1), timings: sag.timings, speaker })).includes("off"));
  // A voice that uses six semitones, heard for the first time: its tones
  // are right, and its fourth for a first is still caught.
  const narrow = speak([1, 2, 4, 3], { spanSt: 6, lowHz: 150 });
  const own = scoreTones({ samples: narrow.samples, sampleRate: RATE, syllables: expecting(1, 2, 4, 3), timings: narrow.timings });
  assert.ok(!verdicts(own).includes("off"), JSON.stringify(verdicts(own)));
  assert.deepEqual(own.syllables.map((s) => s.heardTone).slice(1, 3), [2, 4]);
  const wrong = scoreTones({ samples: narrow.samples, sampleRate: RATE, syllables: expecting(1, 2, 1, 3), timings: narrow.timings });
  assert.equal(wrong.syllables[2].verdict, "off");
  // No fundamental (a phone's speaker), and white noise 20 dB under the voice.
  for (const how of [{ weak: true }, { noise: 0.03 }, { jitter: 0.02 }]) {
    const v = speak([1, 4, 2, 1], how);
    const r = scoreTones({ samples: v.samples, sampleRate: RATE, syllables: expecting(1, 1, 2, 4), timings: v.timings, speaker: v.range });
    assert.deepEqual(r.syllables.map((s) => s.heardTone), [1, 4, 2, 1], JSON.stringify(how));
    assert.ok(!["off"].includes(r.syllables[0].verdict) && r.syllables[2].verdict !== "off", JSON.stringify(how));
    assert.equal(r.syllables[1].verdict, "off", JSON.stringify(how));
  }
  // Noise alone, labelled as speech: nothing to flag.
  const hiss = speak([1], { noise: 0.2 });
  hiss.samples.fill(0);
  let seed = 5;
  for (let i = 0; i < hiss.samples.length; i++) hiss.samples[i] = (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1) * 0.2;
  assert.notEqual(scoreTones({ samples: hiss.samples, sampleRate: RATE, syllables: expecting(2), timings: hiss.timings }).syllables[0].verdict, "off");
});

test("scoreTones: the half third is a right third tone, sandhi is applied before comparing, and a word-final 一 may stay level", () => {
  // 我是: wǒ said low and falling, then shì.
  const { samples, timings, range } = speak(["low", 4]);
  const r = scoreTones({ samples, sampleRate: RATE, syllables: syl("我:wǒ 是:shì"), timings, speaker: range });
  assert.deepEqual(verdicts(r), ["ok", "ok"]);
  // 你好 said ní hǎo is right…
  const nihao = speak([2, 3]);
  const ok = scoreTones({ samples: nihao.samples, sampleRate: RATE, syllables: syl("你:nǐ 好:hǎo"), timings: nihao.timings, speaker: nihao.range });
  assert.deepEqual(ok.syllables.map((s) => [s.expectedTone, s.heardTone, s.verdict]), [[2, 2, "ok"], [3, 3, "ok"]]);
  // …and said with two full third tones (nǐ hǎo, each down and back up)
  // the first is not what sandhi asks for, but a dip that comes back up is
  // too close to a rise to flag: no "off" on either.
  const full = speak([3, 3]);
  const both = scoreTones({ samples: full.samples, sampleRate: RATE, syllables: syl("你:nǐ 好:hǎo"), timings: full.timings, speaker: full.range });
  assert.equal(both.syllables[0].expectedTone, 2);
  assert.ok(!verdicts(both).includes("off"), JSON.stringify(verdicts(both)));
  // 统一了 with a level yī: the end of a word, not the changing 一.
  const tong = speak(["low", 1, (x) => 2.6 - 0.4 * x]);
  const level = scoreTones({ samples: tong.samples, sampleRate: RATE, syllables: syl("统:tǒng 一:yī 了:le"), timings: tong.timings, speaker: tong.range });
  assert.deepEqual([level.syllables[1].heardTone, level.syllables[1].verdict], [1, "ok"]);
  // 一起 at the start of a phrase with a level yī is a wrong tone.
  const yiqi = speak([1, 3]);
  const start = scoreTones({ samples: yiqi.samples, sampleRate: RATE, syllables: syl("一:yī 起:qǐ"), timings: yiqi.timings, speaker: yiqi.range });
  assert.equal(start.syllables[0].verdict, "off");
});

test("no false alarm: a doubled third tone that rises, a third tone that starts at the floor, a creaky onset, a long sentence drifting down", () => {
  // 姐姐 said jiéjie, by a child (260 Hz, a twelve-semitone range) and an adult.
  for (const voice of [{ lowHz: 260, spanSt: 12 }, { lowHz: 110, spanSt: 10 }]) {
    for (const seed of [3, 11, 17, 23]) {
      const v = speak([2, (x) => 2.8 - 0.6 * x], { ...voice, seed });
      for (const t of [v.timings, null]) {
        const r = scoreTones({ samples: v.samples, sampleRate: RATE, syllables: syl("姐:jiě 姐:jie"), timings: t, speaker: v.range });
        assert.notEqual(r.syllables[0].verdict, "off", `${voice.lowHz} Hz, seed ${seed}`);
      }
    }
  }
  // A third tone with hardly any fall before its rise: starts near the
  // floor and comes up to the middle. Not a second tone, which starts in
  // the middle. Alone, in a phrase, and with the range unknown.
  for (const curve of [(x) => 1.2 + 2.1 * x * x, (x) => 1.4 - 0.4 * x + 2.4 * x * x, (x) => 1.3 + 2.2 * x]) {
    const one = speak([curve]);
    assert.notEqual(scoreTones({ samples: one.samples, sampleRate: RATE, syllables: expecting(3), speaker: one.range }).syllables[0].verdict, "off");
    assert.notEqual(scoreTones({ samples: one.samples, sampleRate: RATE, syllables: expecting(3) }).syllables[0].verdict, "off");
    const three = speak([1, curve, 4]);
    assert.notEqual(scoreTones({ samples: three.samples, sampleRate: RATE, syllables: expecting(1, 3, 4), timings: three.timings, speaker: three.range }).syllables[1].verdict, "off");
  }
  // The same when creak hides the first third of the syllable and only the
  // rise is left to see.
  for (const seed of [5, 11, 19]) {
    const creaky = speak([(x) => 2.3 - 3.6 * x + 4.6 * x * x], { creakOnset: 0.32, seed });
    assert.notEqual(scoreTones({ samples: creaky.samples, sampleRate: RATE, syllables: expecting(3), speaker: creaky.range }).syllables[0].verdict, "off", `seed ${seed}`);
  }
  // …while a real second tone for a third is still caught.
  const rise = speak([2]);
  assert.equal(scoreTones({ samples: rise.samples, sampleRate: RATE, syllables: expecting(3), speaker: rise.range }).syllables[0].verdict, "off");

  // Eight syllables, the pitch sinking seven or eight semitones from first
  // to last: the last first tone sits where the voice's low tones began,
  // and is still a first tone.
  for (const declineSt of [7, 8]) {
    const long = speak([1, 2, 4, 1, 2, 4, 1, 1], { declineSt, lowHz: 140 });
    const r = scoreTones({ samples: long.samples, sampleRate: RATE, syllables: phrase(1, 2, 4, 1, 2, 4, 1, 1), timings: long.timings, speaker: long.range });
    assert.ok(!verdicts(r).includes("off"), `${declineSt} st: ${JSON.stringify(verdicts(r))}`);
    // After a comma the count starts again, and so does the voice.
    assert.equal(ruleMargins([40, 40.2, 40.1, 40, 40], [1.5, 1.5, 1.5, 1.5, 1.5], TONE_RULES, 2.5, { late: true })[1] < 0, true);
    assert.equal(ruleMargins([40, 40.2, 40.1, 40, 40], [1.5, 1.5, 1.5, 1.5, 1.5], TONE_RULES, 2.5)[1] >= 0, true);
  }
  // At the start of a phrase a low level pitch is still not a first tone.
  const low = speak([(x) => 1.3 + 0 * x, 4], { declineSt: 0 });
  assert.equal(scoreTones({ samples: low.samples, sampleRate: RATE, syllables: expecting(1, 4), timings: low.timings, speaker: low.range }).syllables[0].verdict, "off");
});

test("scoreTones refuses more than it can do quickly: over 30 seconds, over 60 syllables", () => {
  const long = new Float32Array(RATE * (LOCAL_MAX_SECONDS + 1));
  assert.throws(() => scoreTones({ samples: long, sampleRate: RATE, syllables: expecting(1) }), /at most 30 seconds/);
  const one = speak([1]);
  assert.throws(() => scoreTones({ samples: one.samples, sampleRate: RATE, syllables: expecting(...Array.from({ length: LOCAL_MAX_SYLLABLES + 1 }, () => 1)) }), /at most 60 syllables/);
  // A track in hand is measured the same way.
  const track = trackPitch(one.samples, RATE);
  assert.equal(scoreTones({ track, syllables: expecting(1), speaker: one.range }).syllables[0].verdict, "ok");
});

// Pitch tracks of real proof clips (synthesized voices; written by
// `node scripts/pronunciation-proof.mjs --fixtures`): what the scorer sees
// on audio it did not generate itself.
const TRACKS = JSON.parse(fs.readFileSync(new URL("./fixtures/pronunciation/tracks.json", import.meta.url), "utf8"));
const replay = (voice, text, readings = null) => {
  const f = TRACKS.find((x) => x.voice === voice && x.text === text);
  assert.ok(f, `${voice} ${text}`);
  const track = { hopMs: f.hopMs, f0: Float32Array.from(f.f0), rms: Float32Array.from(f.rms), periodicity: Float32Array.from(f.periodicity), zcr: Float32Array.from(f.zcr) };
  return scoreTones({ track, syllables: expectedSyllables(text, readings ?? f.readings), speaker: f.range });
};

test("recorded pitch tracks: no flag on any correctly said syllable, the near misses included; plain wrong tones flagged", () => {
  for (const f of TRACKS) {
    const r = replay(f.voice, f.text);
    assert.ok(!verdicts(r).includes("off"), `${f.voice} ${f.text}: ${JSON.stringify(r.syllables.map((s) => [s.char, s.verdict, s.margin]))}`);
  }
  // The two correct syllables that came closest to a flag in the proof:
  // Reed's 客 (ruled out by the contour, held back because the measurement
  // isn't clean) and Rachel's 什 (under the margin a phrase asks for).
  const ke = replay("Reed", "不客气").syllables[1];
  assert.ok(ke.verdict !== "off" && (ke.margin < TONE_RULES.phraseMarginSt || ke.quality < TONE_RULES.offQuality), JSON.stringify(ke));
  const shen = replay("Rachel", "你叫什么").syllables[2];
  assert.ok(shen.verdict !== "off" && shen.margin < TONE_RULES.phraseMarginSt, JSON.stringify(shen));
  // A fourth tone labelled first, a first labelled fourth, a second
  // labelled fourth, a fourth labelled second.
  assert.equal(replay("Tingting", "骂", ["mā"]).syllables[0].verdict, "off");
  assert.equal(replay("Tingting", "妈", ["mà"]).syllables[0].verdict, "off");
  assert.equal(replay("Reed", "麻", ["mà"]).syllables[0].verdict, "off");
  assert.equal(replay("Tingting", "骂", ["má"]).syllables[0].verdict, "off");
});

/** `speech` as a push-to-talk recording: a lead-in and a tail of room
 *  noise around it, and whatever else is asked for. `blips` are short
 *  pitched sounds ({ atMs, ms, hz, amp }, times from the start of the
 *  recording), `clickAtMs` a key press (a short decaying thump). */
function recording(speech, { leadMs = 700, tailMs = 1200, noise = 0.004, blips = [], clickAtMs = null, seed = 5 } = {}) {
  const lead = Math.round((RATE * leadMs) / 1000);
  const out = new Float32Array(lead + speech.length + Math.round((RATE * tailMs) / 1000));
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let i = 0; i < out.length; i++) out[i] = noise * rand();
  for (let i = 0; i < speech.length; i++) out[lead + i] += speech[i];
  for (const b of blips) {
    const from = Math.round((RATE * b.atMs) / 1000);
    const len = Math.round((RATE * b.ms) / 1000);
    for (let i = 0; i < len && from + i < out.length; i++) {
      const x = (2 * Math.PI * b.hz * i) / RATE;
      out[from + i] += b.amp * Math.min(1, i / 40, (len - i) / 40) * (Math.sin(x) + Math.sin(2 * x) / 2 + Math.sin(3 * x) / 3);
    }
  }
  if (clickAtMs !== null) {
    const from = Math.round((RATE * clickAtMs) / 1000);
    for (let k = 0; k < 240 && from + k < out.length; k++) out[from + k] += 0.25 * Math.exp(-k / 40) * Math.sin(k / 3);
  }
  return { samples: out, leadMs, speechEndMs: leadMs + (speech.length / RATE) * 1000 };
}

test("trimToSpeech: the noise and blips around a syllable no longer count as speech", () => {
  for (const seed of [11, 23, 57]) {
    const said = speak([2], { seed });
    // 700 ms of room noise, the syllable, a 40 ms pitched blip half a
    // second later and 20 dB under it, another before it, a key press at
    // the very end: a lone syllable as a person records it.
    const rec = recording(said.samples, { blips: [{ atMs: 80, ms: 40, hz: 150, amp: 0.02 }, { atMs: 1650, ms: 40, hz: 260, amp: 0.02 }], clickAtMs: 2150 });
    const raw = trackPitch(rec.samples, RATE);
    const voicedAt = (track) => [...track.f0].map((f, i) => (f > 0 ? i * HOP_MS : -1)).filter((ms) => ms >= 0);
    // The test is only a test if the tracker heard the blips as voice.
    assert.ok(voicedAt(raw).some((ms) => ms > rec.speechEndMs + 300), "the trailing blip is voiced in the raw track");
    const trimmed = trimToSpeech(raw);
    const kept = voicedAt(trimmed);
    assert.ok(kept.length >= 20);
    assert.ok(kept[0] >= rec.leadMs && kept[kept.length - 1] <= rec.speechEndMs, `voiced only in the syllable (${kept[0]}–${kept[kept.length - 1]})`);
    // Every voiced frame of the syllable itself is still there, unchanged.
    for (let i = 0; i < raw.f0.length; i++) if (raw.f0[i] > 0 && i * HOP_MS >= rec.leadMs && i * HOP_MS <= rec.speechEndMs) assert.equal(trimmed.f0[i], raw.f0[i]);
    // Outside the kept stretch there is no level left to cut on.
    assert.equal(trimmed.rms[5], 0);
    assert.equal(trimmed.rms[trimmed.rms.length - 2], 0);
    assert.notEqual(trimmed, raw);
    assert.equal(raw.rms[5] > 0, true, "the input is not changed");

    // And so the syllable is read as what it is, and as wrong when it is.
    const right = scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: expecting(2), speaker: said.range }).syllables[0];
    assert.deepEqual([right.verdict, right.heardTone], ["ok", 2], `seed ${seed}: ${right.reason}`);
    assert.ok(right.startMs >= rec.leadMs - TRIM_RULES.beforeMs && right.endMs <= rec.speechEndMs + TRIM_RULES.afterMs + HOP_MS);
    assert.equal(scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: expecting(1), speaker: said.range }).syllables[0].verdict, "off");
  }
});

test("trimToSpeech: a phrase in a long recording is cut where the speech is", () => {
  const said = speak([1, 4, 2]);
  const rec = recording(said.samples, { leadMs: 900, tailMs: 1500, blips: [{ atMs: 60, ms: 30, hz: 140, amp: 0.02 }, { atMs: 2900, ms: 50, hz: 120, amp: 0.02 }], clickAtMs: 3350 });
  const r = scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: phrase(1, 4, 2), speaker: said.range });
  assert.deepEqual(verdicts(r), ["ok", "ok", "ok"]);
  assert.deepEqual(r.syllables.map((x) => x.heardTone), [1, 4, 2]);
  // Each piece sits on its own syllable, none in the silence.
  r.syllables.forEach((x, k) => {
    const mid = (x.startMs + x.endMs) / 2 - rec.leadMs;
    assert.ok(mid > said.timings[k].startMs && mid < said.timings[k].endMs, `piece ${k + 1} is on syllable ${k + 1}`);
  });
  // A wrong tone in the middle is still caught.
  assert.equal(scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: phrase(1, 1, 2), speaker: said.range }).syllables[1].verdict, "off");
});

test("trimToSpeech never cuts into speech: a quiet consonant before the vowel, a soft last syllable, a clean clip", () => {
  // A clip with nothing around the speech comes back as it is.
  const clean = speak([1, 4]);
  const cleanTrack = trackPitch(clean.samples, RATE);
  assert.equal(trimToSpeech(cleanTrack), cleanTrack);

  // 180 ms of quiet hiss (an sh, 20 dB under the vowel) right before the
  // vowel, in a recording with a long lead-in: the hiss is kept.
  const vowel = speak([4]).samples;
  const hissMs = 180;
  const hiss = new Float32Array(Math.round((RATE * hissMs) / 1000));
  let state = 3;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let i = 0; i < hiss.length; i++) hiss[i] = 0.03 * rand();
  const sh = new Float32Array(hiss.length + vowel.length);
  sh.set(hiss);
  sh.set(vowel, hiss.length);
  const rec = recording(sh);
  const raw = trackPitch(rec.samples, RATE);
  const trimmed = trimToSpeech(raw);
  for (let ms = rec.leadMs + 20; ms < rec.leadMs + hissMs; ms += HOP_MS) assert.equal(trimmed.rms[ms / HOP_MS], raw.rms[ms / HOP_MS], `the consonant at ${ms} ms is kept`);

  // A neutral tone at the end: 90 ms long, 18 dB under the syllable
  // before it, after a 120 ms stop closure. Short and soft, and still
  // speech: all of its voiced frames are kept.
  const first = speak([4], { gapMs: 0 }).samples;
  const soft = speak([(x) => 2.2 - 0.6 * x], { ms: 90, gapMs: 0, seed: 29 }).samples;
  const word = new Float32Array(first.length + Math.round(RATE * 0.12) + soft.length);
  word.set(first);
  for (let i = 0; i < soft.length; i++) word[first.length + Math.round(RATE * 0.12) + i] = soft[i] * 0.125;
  const rec2 = recording(word);
  const raw2 = trackPitch(rec2.samples, RATE);
  const trimmed2 = trimToSpeech(raw2);
  const softFrom = rec2.leadMs + ((first.length / RATE) * 1000) + 120;
  let softVoiced = 0;
  for (let i = 0; i < raw2.f0.length; i++) {
    if (!(raw2.f0[i] > 0) || i * HOP_MS < softFrom || i * HOP_MS > rec2.speechEndMs) continue;
    softVoiced++;
    assert.equal(trimmed2.f0[i], raw2.f0[i]);
  }
  assert.ok(softVoiced >= 5, `the soft syllable is voiced in the raw track (${softVoiced} frames)`);
});

/** Creak over part of a syllable: the buzz replaced by glottal pulses at
 *  irregular intervals, loud but with no period to find. */
function creakOver(samples, fromMs, toMs, seed = 7) {
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  const from = Math.round((RATE * fromMs) / 1000);
  const to = Math.round((RATE * toMs) / 1000);
  for (let i = from; i < to; i++) samples[i] = 0;
  for (let i = from + 20; i < to; i += Math.round(RATE * (0.012 + 0.016 * Math.abs(rand())))) {
    for (let k = 0; k < 90 && i + k < to; k++) samples[i + k] += 0.5 * Math.exp(-k / 18) * Math.sin(k / 6);
  }
  return samples;
}

test("creak can confirm a tone but never flag one", () => {
  for (const seed of [11, 23, 57]) {
    // A fourth tone in a low voice: the fall is there, and the middle of it
    // breaks into creak for 100 ms, as a low voice does near its floor.
    const said = speak([4], { ms: 320, seed });
    const at = said.timings[0];
    creakOver(said.samples, at.startMs + 130, at.startMs + 230, seed);
    const right = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(4), speaker: said.range }).syllables[0];
    assert.deepEqual([right.verdict, right.heardTone], ["ok", 4], `seed ${seed}: ${right.reason}`);
    // …counted for less than a clean one.
    const cleanOk = speak([4], { ms: 320, seed });
    assert.ok(right.confidence < scoreTones({ samples: cleanOk.samples, sampleRate: RATE, syllables: expecting(4), speaker: cleanOk.range }).syllables[0].confidence);
    // Labelled as a first tone the same clip is plainly wrong, and still
    // not flagged: creak is where the tracker is least to be trusted.
    for (const wrong of [1, 2]) {
      const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(wrong), speaker: said.range }).syllables[0];
      assert.deepEqual([res.verdict, res.reason], ["unsure", "creaky"], `seed ${seed}, labelled ${wrong}`);
    }
  }
});

test("an octave jump inside a vowel makes the syllable unsure, not off", () => {
  // A level first tone whose track drops an octave for 130 ms in the
  // middle and comes back: longer than the 80 ms the tracker mends by
  // itself, which is how a low voice near creak comes out of it.
  const said = speak([1], { ms: 400 });
  const track = trackPitch(said.samples, RATE);
  const ok = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(1), speaker: said.range, track }).syllables[0];
  assert.equal(ok.verdict, "ok");
  const slipped = { ...track, f0: Float32Array.from(track.f0) };
  const from = Math.round((said.timings[0].startMs + 130) / HOP_MS);
  for (let i = from; i < from + 13; i++) slipped.f0[i] /= 2;
  const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(1), speaker: said.range, track: slipped }).syllables[0];
  assert.deepEqual([res.verdict, res.reason, res.confidence], ["unsure", "octave", 0]);
  // The steepest real movement is not a jump: a fourth tone said fast.
  const fast = speak([4], { ms: 140, spanSt: 14 });
  assert.equal(scoreTones({ samples: fast.samples, sampleRate: RATE, syllables: expecting(4), speaker: fast.range }).syllables[0].verdict, "ok");
});

test("unsure, not off: short, unvoiced, neutral, untimed, and anything under the bar", () => {
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
  // enough, a stretch not long enough, evidence not far enough past its bar.
  for (const bar of [{ offQuality: 1.01 }, { offMinMs: 5000 }, { offMarginSt: 99 }]) {
    const s = scoreTones({ ...args, rules: { ...TONE_RULES, ...bar } }).syllables[0];
    assert.deepEqual([s.verdict, s.reason, s.heardTone], ["unsure", "unclear", 4], JSON.stringify(bar));
  }
  // A syllable inside a phrase asks for more margin than one said alone,
  // on given timings as much as on the scorer's own cuts.
  const pair = speak([4, 4]);
  const strict = { ...TONE_RULES, phraseMarginSt: 99 };
  assert.equal(scoreTones({ ...args, rules: strict }).syllables[0].verdict, "off");
  for (const t of [pair.timings, null]) assert.equal(scoreTones({ samples: pair.samples, sampleRate: RATE, syllables: expecting(1, 4), timings: t, speaker: pair.range, rules: strict }).syllables[0].verdict, "unsure");
  assert.equal(scoreTones({ samples: pair.samples, sampleRate: RATE, syllables: expecting(1, 4), timings: pair.timings, speaker: pair.range }).syllables[0].verdict, "off");

  // A sag of two semitones where a first tone was expected: not level, not
  // a fall either. Whatever the best match is, it is not flagged.
  const droop = speak([(x) => 4.8 - 0.8 * x]);
  assert.notEqual(scoreTones({ samples: droop.samples, sampleRate: RATE, syllables: expecting(1), speaker: droop.range }).syllables[0].verdict, "off");

  // A low level pitch is a half third; against a first tone it is a flag
  // only in a voice whose range is known (it could be anyone's high).
  const flat = speak([(x) => 1.3 + 0 * x], { declineSt: 0 });
  assert.notEqual(scoreTones({ samples: flat.samples, sampleRate: RATE, syllables: expecting(3), speaker: flat.range }).syllables[0].verdict, "off");
  assert.notEqual(scoreTones({ samples: flat.samples, sampleRate: RATE, syllables: expecting(1) }).syllables[0].verdict, "off");
  assert.equal(scoreTones({ samples: flat.samples, sampleRate: RATE, syllables: expecting(1), speaker: flat.range }).syllables[0].verdict, "off");
  // A level pitch in the middle of the range is a syllable squeezed flat:
  // no tone is flagged on it.
  const mid = speak([(x) => 3 + 0 * x], { declineSt: 0 });
  for (const want of [1, 2, 3, 4]) assert.notEqual(scoreTones({ samples: mid.samples, sampleRate: RATE, syllables: expecting(want), speaker: mid.range }).syllables[0].verdict, "off", `tone ${want}`);
});

test("rulesOut: what a contour cannot be, and the middle ground where nothing is ruled out", () => {
  const no = (five, levels) => Object.entries(rulesOut(five, levels)).filter(([, v]) => v).map(([k]) => Number(k));
  const level = [50, 50.3, 50.2, 50.1, 50];
  // Level, range unknown: not a rise, not a fall.
  assert.deepEqual(no(level), [2, 4]);
  // Level and high: a first tone and nothing else. Level and low: a half
  // third. Level in the middle: anything squeezed flat.
  assert.deepEqual(no(level, [4.6, 4.7, 4.7, 4.6, 4.6]), [2, 3, 4]);
  assert.deepEqual(no(level, [1.4, 1.5, 1.5, 1.4, 1.4]), [1, 2, 4]);
  assert.deepEqual(no(level, [3, 3.1, 3.1, 3, 3]), []);
  // A six-semitone fall: not level, not a rise; third and fourth both
  // remain, until it is known to start high.
  assert.deepEqual(no([56, 55, 53, 51, 50]), [1, 2]);
  assert.deepEqual(no([56, 55, 53, 51, 50], [4.8, 4.4, 3.6, 2.8, 2.4]), [1, 2, 3]);
  assert.deepEqual(no([56, 55, 53, 51, 50], [3.2, 2.8, 2, 1.2, 0.8]), [1, 2]);
  // A fourth tone rises into its fall: still not a second tone.
  assert.deepEqual(no([52, 55, 54, 51, 49]), [1, 2]);
  // A plain six-semitone rise: not level, not a fall. A second tone only
  // if it is known to start mid-range; from the floor it is a third tone
  // with no fall to show, and so is one whose start is hidden.
  assert.deepEqual(no([50, 50.5, 52, 54, 56]), [1, 4]);
  assert.deepEqual(no([50, 50.5, 52, 54, 56], [3, 3.2, 3.8, 4.6, 5.4]), [1, 3, 4]);
  assert.deepEqual(no([50, 50.5, 52, 54, 56], [1.3, 1.5, 2.1, 2.9, 3.7]), [1, 4]);
  assert.equal(ruleMargins([50, 50.5, 52, 54, 56], [3, 3.2, 3.8, 4.6, 5.4], TONE_RULES, 2.5, { hiddenOnset: true })[3] < 0, true);
  // A second tone dips before it rises: still not a fourth, and with that
  // much dip a third tone is possible again.
  assert.deepEqual(no([52, 50, 51, 54, 56]), [1, 4]);
  // A deep dip that barely comes back: a third tone, not a second.
  assert.deepEqual(no([55, 51, 49, 49.5, 50.5]), [1, 2]);
  // Two semitones of droop or lift: nothing is ruled out, so nothing can be flagged.
  assert.deepEqual(no([52, 51.5, 51, 50.4, 50]), []);
  assert.deepEqual(no([50, 50.5, 51, 51.6, 52]), []);
  // The neutral tone is never ruled out.
  assert.equal(rulesOut([56, 55, 53, 51, 50])[0], false);
  // The margins behind those answers are in semitones past the bar.
  const m = ruleMargins([56, 55, 53, 51, 50]);
  assert.equal(m[1], 6 - TONE_RULES.moveSt);
  assert.ok(m[4] < 0 && m[0] === -Infinity);
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
});

test("azurePronunciationRequest: the short-audio endpoint, the language, the headers; bad input refused", () => {
  const audio = encodeWav(new Float32Array(RATE / 10), RATE);
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
  // The locale is read as scoresTones reads it, and named Azure's way.
  for (const [given, sent] of [["zh", "zh-CN"], ["zh_TW", "zh-TW"], ["zh-Hant-TW", "zh-TW"], ["zh-Hant", "zh-TW"], ["cmn-Hans-CN", "zh-CN"], ["zh-SG", "zh-CN"], ["es-mx", "es-MX"]]) {
    assert.equal(azureLocale(given), sent);
    assert.ok(azurePronunciationRequest({ key: "k", region: "eastus", audio, locale: given, referenceText: "你好" }).url.includes(`language=${sent}&`), given);
  }
  for (const bad of ["", null, "es", "zh-CN-x-1", "zh/CN", "zh-HK", "zh-yue"]) assert.throws(() => azureLocale(bad), /locale/, String(bad));
  // The request says 16 kHz and Azure assesses 30 seconds: both are read
  // off the file, and anything else is refused before it is sent.
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "eastus", audio: new Uint8Array(100), locale: "zh-CN", referenceText: "你好" }), /WAV/);
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "eastus", audio: encodeWav(new Float32Array(800), 8000), locale: "zh-CN", referenceText: "你好" }), /16 kHz/);
  assert.throws(() => azurePronunciationRequest({ key: "k", region: "eastus", audio: encodeWav(new Float32Array(RATE * (AZURE_MAX_SECONDS + 1)), RATE), locale: "zh-CN", referenceText: "你好" }), /at most 30 seconds/);
  assert.ok(azurePronunciationRequest({ key: "k", region: "eastus", audio: encodeWav(new Float32Array(RATE * AZURE_MAX_SECONDS), RATE), locale: "zh-CN", referenceText: "你好" }).url);
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

  // A high Azure score does not settle an unclear pitch reading: a wrong
  // tone scores high too. Unsure stays unsure.
  const unclear = (cuts) => ({ speaker: null, syllables: syllables.map((s, i) => ({ ...s, heardTone: 2, verdict: "unsure", reason: "unclear", confidence: 0, startMs: cuts[i]?.startMs ?? null, endMs: cuts[i]?.endMs ?? null, pitch: [] })) });
  const high = structuredClone(reply);
  for (const w of high.NBest[0].Words) w.AccuracyScore = 100;
  const u = mergeAzure({ azure: azurePronunciationResult(high), syllables, local: unclear, track });
  assert.deepEqual(u.syllables.map((s) => [s.verdict, s.reason, s.score]), syllables.map(() => ["unsure", "unclear", 100]));

  // Nothing recognised: every syllable unsure, nothing thrown, the local
  // scorer never called.
  const empty = mergeAzure({ azure: azurePronunciationResult({ RecognitionStatus: "NoMatch" }), syllables, local: () => assert.fail("not called") });
  assert.deepEqual(empty.syllables.map((s) => [s.verdict, s.reason]), syllables.map(() => ["unsure", "untimed"]));
  assert.equal("overall" in empty, false);
});

/* The trim's edges. Each bar in TRIM_RULES was set on one speaker's clips,
 * so each is tried just on its wrong side, and the rule is the same every
 * time: the trim may cost a verdict (unsure, reason "trimmed"); it never
 * makes one. Where it can't tell speech from noise the scorer reads the
 * recording both ways and keeps what agrees. */
const voicedIn = (track, fromMs, toMs) => {
  let n = 0;
  for (let i = Math.floor(fromMs / HOP_MS); i < Math.ceil(toMs / HOP_MS); i++) if (track.f0[i] > 0) n++;
  return n;
};
const scored = (rec, said, ...labels) => scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: phrase(...labels), speaker: said.range }).syllables.map((x) => (x.reason === "trimmed" ? "trimmed" : x.verdict));

test("a short last syllable after a pause over nearMs: doubted, never erased into a wrong verdict", () => {
  for (const pauseMs of [150, 250, 350]) {
    // 70 ms, under runMs; the pause puts it past nearMs for two of three.
    const said = speak([4, 1, 2], { ms: [260, 260, 70], gaps: [70, 70, pauseMs, 70] });
    const rec = recording(said.samples);
    const raw = trackPitch(rec.samples, RATE);
    const last = said.timings[2];
    const before = voicedIn(raw, rec.leadMs + last.startMs, rec.leadMs + last.endMs);
    assert.ok(before >= 3 && before * HOP_MS < TRIM_RULES.runMs, `the last syllable is a short voiced run (${before} frames)`);
    const far = pauseMs > TRIM_RULES.nearMs;
    // By the bars alone it is noise once it is far…
    assert.equal(voicedIn(trimToSpeech(raw), rec.leadMs + last.startMs, rec.leadMs + last.endMs), far ? 0 : before, `pause ${pauseMs}`);
    // …but two voiced runs for three syllables is a reason to doubt that,
    // and the readings with and without it differ on the last syllable.
    assert.deepEqual(scored(rec, said, 4, 1, 2), ["ok", "ok", far ? "trimmed" : "ok"], `pause ${pauseMs}`);
    assert.notEqual(scored(rec, said, 4, 1, 4)[2], "off", `pause ${pauseMs}`);
    // What both readings agree on stands: a wrong first tone is caught.
    assert.deepEqual(scored(rec, said, 1, 1, 2).slice(0, 2), ["off", "ok"], `pause ${pauseMs}`);
  }
});

test("a creaky, broken last syllable after a pause is not erased", () => {
  const said = speak([1, 4, 3], { gaps: [70, 70, 300, 70] });
  const last = said.timings[2];
  creakOver(said.samples, last.startMs + 40, last.startMs + 140, 3);
  creakOver(said.samples, last.startMs + 190, last.endMs - 20, 4);
  const rec = recording(said.samples);
  const got = scored(rec, said, 1, 4, 3);
  assert.equal(got[0], "ok");
  assert.ok(!got.includes("off"), got.join(" "));
});

test("a soft last syllable on either side of floorDb", () => {
  for (const db of [-24, -27]) {
    const said = speak([4, 2, 1], { amps: [1, 1, 10 ** (db / 20)] });
    const rec = recording(said.samples);
    const raw = trackPitch(rec.samples, RATE);
    const last = said.timings[2];
    assert.ok(voicedIn(raw, rec.leadMs + last.startMs, rec.leadMs + last.endMs) >= 15, `${db} dB: the soft syllable is voiced`);
    // Under the floor the bars drop it; beside the speech, so doubted.
    const under = db < TRIM_RULES.floorDb;
    assert.equal(voicedIn(trimToSpeech(raw), rec.leadMs + last.startMs, rec.leadMs + last.endMs) === 0, under, `${db} dB`);
    assert.deepEqual(scored(rec, said, 4, 2, 1), ["ok", "ok", under ? "trimmed" : "ok"], `${db} dB`);
    assert.deepEqual(scored(rec, said, 1, 2, 1).slice(0, 2), ["off", "ok"], `${db} dB`);
  }
});

test("a last syllable every bar calls noise (short, far, 18 dB under) is doubted when a syllable is missing", () => {
  const said = speak([4, 2, 1], { ms: [260, 260, 70], gaps: [70, 70, 300, 70], amps: [1, 1, 10 ** (-18 / 20)] });
  const rec = recording(said.samples);
  const raw = trackPitch(rec.samples, RATE);
  const last = said.timings[2];
  assert.ok(voicedIn(raw, rec.leadMs + last.startMs, rec.leadMs + last.endMs) >= 3);
  const trimmed = trimToSpeech(raw);
  assert.equal(voicedIn(trimmed, rec.leadMs + last.startMs, rec.leadMs + last.endMs), 0, "the bars alone drop it");
  assert.equal(trimmed.trim.dropped.length, 1);
  for (const labels of [[4, 2, 1], [4, 2, 4]]) {
    const got = scored(rec, said, ...labels);
    assert.deepEqual(got, ["ok", "ok", "trimmed"], `labelled ${labels}`);
  }
});

test("a knock louder than the speech is dropped when every syllable is accounted for", () => {
  // Three syllables, three voiced runs: nothing is missing, so the knock
  // half a second before them is noise and the phrase is read as if it
  // weren't there, flags included.
  const said = speak([4, 2, 1]);
  const rec = recording(said.samples, { blips: [{ atMs: 200, ms: 50, hz: 220, amp: 0.9 }] });
  assert.deepEqual(scored(rec, said, 4, 2, 1), ["ok", "ok", "ok"]);
  assert.deepEqual(scored(rec, said, 4, 2, 4), ["ok", "ok", "off"]);
  // Two syllables run together (one voiced run for two): the knock might
  // be the second, so both readings are taken. No reading invents a flag.
  const fused = speak([1, 4], { gapMs: 0 });
  const fusedRec = recording(fused.samples, { blips: [{ atMs: 200, ms: 50, hz: 220, amp: 0.9 }] });
  assert.ok(!scored(fusedRec, fused, 1, 4).includes("off"));
});

test("a syllable with no long voiced run is still the speech", () => {
  // (An edited track.) A clipped fourth tone the tracker broke into pieces
  // of 50 ms: none reaches runMs, so the loudest is the speech and its
  // neighbours join it.
  const said = speak([4], { ms: 200 });
  const rec = recording(said.samples);
  const raw = trackPitch(rec.samples, RATE);
  const broken = { ...raw, f0: Float32Array.from(raw.f0) };
  const voiced = [...raw.f0].map((f, i) => (f > 0 ? i : -1)).filter((i) => i >= 0);
  for (const [k, i] of voiced.entries()) if (k % 6 === 5) broken.f0[i] = 0;
  const trimmed = trimToSpeech(broken);
  assert.equal(voicedIn(trimmed, 0, rec.samples.length / 16), voicedIn(broken, 0, rec.samples.length / 16));
  const res = scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: expecting(1), speaker: said.range, track: broken }).syllables[0];
  assert.notEqual(res.reason, "trimmed");
});

/* The proof's "With lead-in noise", in small: the same disturbances
 * (NOISE_CONDITIONS) around generated speech. What must hold in every
 * condition: no correctly said syllable is "off"; wrong tones passed as
 * "ok" are not above the clean count by more than 1; single syllables are
 * caught exactly as often as clean; phrases at least four times in five
 * (words run together are read twice at a stray sound, and lose verdicts). */
test("lead-in noise: no false alarm, no extra wrong ok, catches hold", () => {
  const voice = { lowHz: 110, spanSt: 10 };
  const said = [];
  for (const tones of [[1], [2], [3], [4], [4, 1, 2], [2, 4, 1]]) said.push({ tones, clip: speak(tones, voice) });
  // Words run together: one voiced run for two syllables.
  said.push({ tones: [1, 4], clip: speak([1, 4], { ...voice, gapMs: 0 }) });
  const run = (cond) => {
    const t = { single: emptyTally(), phrase: emptyTally() };
    for (const [k, { tones, clip }] of said.entries()) {
      const samples = surround(clip.samples, RATE, cond, 77 + k);
      const track = trackPitch(samples, RATE);
      tallyLabellings(t[tones.length === 1 ? "single" : "phrase"], tones, (syllables) => scoreTones({ samples, sampleRate: RATE, syllables, speaker: clip.range, track }));
    }
    return t;
  };
  const clean = run(NOISE_CONDITIONS[0]);
  assert.equal(clean.single.right.off + clean.phrase.right.off, 0);
  assert.ok(clean.single.wrong.off >= 9 && clean.phrase.wrong.off >= 20, JSON.stringify(clean));
  for (const cond of NOISE_CONDITIONS.slice(1)) {
    const t = run(cond);
    for (const kind of ["single", "phrase"]) {
      assert.equal(t[kind].right.off, 0, `${cond.key} ${kind}: a correct syllable flagged`);
      assert.ok(t[kind].wrong.ok <= clean[kind].wrong.ok + 1, `${cond.key} ${kind}: wrong tones passed as ok ${t[kind].wrong.ok}, clean ${clean[kind].wrong.ok}`);
    }
    assert.equal(t.single.wrong.off, clean.single.wrong.off, `${cond.key}: single syllables caught`);
    assert.ok(t.phrase.wrong.off >= 0.8 * clean.phrase.wrong.off, `${cond.key}: phrases caught ${t.phrase.wrong.off}, clean ${clean.phrase.wrong.off}`);
  }
});

test("lead-in noise: a last syllable the trim could take for noise costs verdicts, never a wrong one", () => {
  const room = NOISE_CONDITIONS.find((c) => c.key === "room");
  const counts = {};
  for (const kase of LAST_SYLLABLE_CASES) {
    const t = emptyTally();
    for (const [k, tones] of GENERATED_PHRASES.slice(0, 3).entries()) {
      const clip = speak(tones, { lowHz: 110, spanSt: 10, ...kase.options });
      const samples = surround(clip.samples, RATE, room, 500 + k);
      const track = trackPitch(samples, RATE);
      tallyLabellings(t, tones, (syllables) => scoreTones({ samples, sampleRate: RATE, syllables, speaker: clip.range, track }));
    }
    counts[kase.key] = t;
    assert.equal(t.right.off, 0, `${kase.key}: a correct syllable flagged`);
  }
  for (const key of ["pause", "soft"]) assert.ok(counts[key].wrong.ok <= counts.plain.wrong.ok + 1, `${key}: ${JSON.stringify(counts[key])}`);
  // The readings still agree on part of it: some right syllables stay
  // ok and some wrong ones are still caught.
  for (const key of ["pause", "soft"]) assert.ok(counts[key].right.ok >= 3 && counts[key].wrong.off >= 6, `${key}: ${JSON.stringify(counts[key])}`);
});

test("no speech at all: the track comes back as it is and nothing is judged", () => {
  const rec = recording(new Float32Array(RATE / 2), { noise: 0.004 });
  const raw = trackPitch(rec.samples, RATE);
  assert.equal(trimToSpeech(raw), raw);
  const res = scoreTones({ samples: rec.samples, sampleRate: RATE, syllables: expecting(1) });
  assert.deepEqual([res.syllables[0].verdict, res.syllables[0].reason, res.overall], ["unsure", "unvoiced", undefined]);
});

/* The jump guard, through the real path (audio in) wherever a jump can be
 * made in audio at all: the tracker mends or drops most of what a
 * generator can produce, so two cases edit a track, and say so. */
test("a jump at a syllable join is not a slip: close syllables in a child's range are all read", () => {
  // 10 ms between syllables: a fourth tone starts an octave above the end
  // of the one before, and the frame at the join belongs to the neighbour.
  for (const [lowHz, spanSt] of [[250, 12], [230, 16]]) {
    for (const tones of [[4, 4], [4, 1], [1, 4, 1], [2, 4, 1], [3, 4]]) {
      for (const seed of [11, 23, 57]) {
        const said = speak(tones, { lowHz, spanSt, gapMs: 10, ms: 220, seed });
        const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: phrase(...tones), speaker: said.range });
        assert.deepEqual(verdicts(res), tones.map(() => "ok"), `${lowHz} Hz [${tones}] seed ${seed}: ${res.syllables.map((x) => x.reason ?? "").join(" ")}`);
      }
    }
  }
});

test("a glitch of a frame or three at the edge of a syllable is dropped, not held against it", () => {
  // (An edited track: the tracker itself absorbs a generated edge glitch.)
  for (const [tone, frames, end] of [[2, 1, "start"], [2, 3, "start"], [4, 2, "end"], [1, 1, "start"]]) {
    const said = speak([tone], { ms: 320 });
    const track = trackPitch(said.samples, RATE);
    const glitched = { ...track, f0: Float32Array.from(track.f0) };
    const voiced = [...track.f0].map((f, i) => (f > 0 ? i : -1)).filter((i) => i >= 0);
    const at = end === "start" ? voiced.slice(0, frames) : voiced.slice(-frames);
    for (const i of at) glitched.f0[i] = end === "start" ? glitched.f0[i] / 2 : glitched.f0[i] * 2;
    const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(tone), speaker: said.range, track: glitched }).syllables[0];
    assert.deepEqual([res.verdict, res.heardTone, res.reason], ["ok", tone, undefined], `tone ${tone}, ${frames} frame(s) at the ${end}`);
  }
});

test("a glitch in the middle of a vowel is read through; a track that flips throughout is not read at all", () => {
  // (Edited tracks.)
  for (const tone of [1, 2, 4]) {
    const said = speak([tone], { ms: 320 });
    const track = trackPitch(said.samples, RATE);
    const voiced = [...track.f0].map((f, i) => (f > 0 ? i : -1)).filter((i) => i >= 0);
    const score = (edited, label) => scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(label), speaker: said.range, track: edited }).syllables[0];
    // Two frames an octave down in the middle: taken out, and the vowel
    // carries on where it was. Right is ok, and a wrong label is still caught.
    const mid = { ...track, f0: Float32Array.from(track.f0) };
    const m = voiced[Math.floor(voiced.length / 2)];
    mid.f0[m] /= 2;
    mid.f0[m + 1] /= 2;
    assert.deepEqual([score(mid, tone).verdict, score(mid, tone).heardTone], ["ok", tone], `tone ${tone}, a glitch mid-vowel`);
    assert.equal(score(mid, tone === 1 ? 4 : 1).verdict, "off", `tone ${tone}, a glitch mid-vowel, labelled wrong`);
    // An octave down every other three frames, the whole vowel through
    // (period doubling): no piece is longer than a glitch, and the guard
    // must not switch itself off for want of one.
    const all = { ...track, f0: Float32Array.from(track.f0) };
    voiced.forEach((i, k) => { if (Math.floor(k / 3) % 2 === 1) all.f0[i] /= 2; });
    for (const label of [1, 2, 3, 4]) assert.deepEqual([score(all, label).verdict, score(all, label).reason], ["unsure", "octave"], `tone ${tone} flipping throughout, labelled ${label}`);
    // The same over the middle half only: too much of the contour is
    // glitch to read through what is left.
    const half = { ...track, f0: Float32Array.from(track.f0) };
    voiced.slice(Math.floor(voiced.length / 4), Math.floor((3 * voiced.length) / 4)).forEach((i, k) => { if (Math.floor(k / 3) % 2 === 1) half.f0[i] /= 2; });
    for (const label of [1, 2, 3, 4]) assert.notEqual(score(half, label).verdict, label === tone ? "off" : "ok", `tone ${tone} flipping in the middle, labelled ${label}`);
  }
});

test("a sustained octave jump, said into the microphone, is unsure", () => {
  // The voice itself drops an octave for 130 ms in the middle of a level
  // tone and comes back (the generator's levels: 4.8 is an octave at this
  // span). Longer than the tracker mends, so it reaches the scorer.
  for (const seed of [11, 23, 57]) {
    const said = speak([(x) => CURVES[1](x) - (x > 0.33 && x < 0.33 + 130 / 400 ? 4.8 : 0)], { ms: 400, seed });
    for (const label of [1, 2, 3, 4]) {
      const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(label), speaker: said.range });
      assert.deepEqual([res.syllables[0].verdict, res.syllables[0].reason], ["unsure", "octave"], `seed ${seed}, labelled ${label}`);
      assert.equal(res.overall, undefined);
    }
  }
});

test("the jump check comes before the creaky third tone: a slipped, creaky rise is not an ok third tone", () => {
  // (An edited track.) A second tone whose track sits an octave low for
  // 120 ms with four creaky frames inside: low and creaky is what the
  // third-tone rule looks for, and it is the tracker's doing.
  for (const seed of [11, 23, 57]) {
    const said = speak([2], { ms: 360, seed });
    const track = trackPitch(said.samples, RATE);
    const slipped = { ...track, f0: Float32Array.from(track.f0) };
    const from = Math.round((said.timings[0].startMs + 60) / HOP_MS);
    for (let i = from; i < from + 12; i++) slipped.f0[i] /= 2;
    for (let i = from + 3; i < from + 7; i++) slipped.f0[i] = 0;
    const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: expecting(3), speaker: said.range, track: slipped }).syllables[0];
    assert.deepEqual([res.verdict, res.reason], ["unsure", "octave"], `seed ${seed}`);
  }
});

test("a creaky ok is marked, left out of overall, and keeps its mark through mergeAzure", () => {
  const said = speak([4, 1], { ms: 320 });
  const first = said.timings[0];
  creakOver(said.samples, first.startMs + 130, first.startMs + 230, 11);
  const res = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: phrase(4, 1), speaker: said.range });
  assert.deepEqual(res.syllables.map((x) => [x.verdict, x.creaky ?? false]), [["ok", true], ["ok", false]]);
  assert.equal(res.overall, 100);
  // Only the clean syllable is counted: flagged, it is the whole score.
  const wrong = scoreTones({ samples: said.samples, sampleRate: RATE, syllables: phrase(4, 4), speaker: said.range });
  assert.deepEqual([verdicts(wrong), wrong.overall], [["ok", "off"], 0]);
  // A creaky ok alone is no score at all.
  const alone = speak([4], { ms: 320 });
  creakOver(alone.samples, alone.timings[0].startMs + 130, alone.timings[0].startMs + 230, 11);
  const one = scoreTones({ samples: alone.samples, sampleRate: RATE, syllables: expecting(4), speaker: alone.range });
  assert.deepEqual([one.syllables[0].verdict, one.syllables[0].creaky, one.overall], ["ok", true, undefined]);

  const ticks = (ms) => Math.round(ms * 10_000);
  const word = (text, t, score) => ({ Word: text, Offset: ticks(t.startMs), Duration: ticks(t.endMs - t.startMs), AccuracyScore: score, ErrorType: "None" });
  const reply = { RecognitionStatus: "Success", DisplayText: "骂妈。", NBest: [{ Display: "骂妈。", AccuracyScore: 90, FluencyScore: 90, CompletenessScore: 100, PronScore: 90, Words: [word("骂", said.timings[0], 91), word("妈", said.timings[1], 93)] }] };
  const syllables = expectedSyllables("骂妈", ["mà", "mā"]);
  const merged = mergeAzure({ azure: azurePronunciationResult(reply), syllables, local: (cuts) => scoreTones({ samples: said.samples, sampleRate: RATE, syllables, timings: cuts, speaker: said.range }) });
  assert.deepEqual(merged.syllables.map((x) => [x.char, x.verdict, x.creaky ?? false, x.score]), [["骂", "ok", true, 91], ["妈", "ok", false, 93]]);
});
