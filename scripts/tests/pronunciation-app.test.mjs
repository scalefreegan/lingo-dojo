// The app half of pronunciation scoring (scripts/pronunciation-app.mjs,
// ld-ne0.2): what text and audio the route takes, which engine runs (Azure
// with keys, for any learner), a lone character's readings, the per-user
// Azure cap, and the reply the page draws. Pure: no server, no network.
//   node --test scripts/tests/pronunciation-app.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, scoreTones, trackPitch } from "../pronunciation.mjs";
import {
  AZURE_PER_MINUTE, SCORE_MAX_CHARS, SCORE_MAX_SECONDS, azureLimiter, azureUsable, centredCurve, readScoreAudio, readScoreText, scoreReply, scoreSyllables, scoringEngine, toneShape, wavHeader,
} from "../pronunciation-app.mjs";
import { speak } from "../pronunciation-synth.mjs";
import { charReadings, readCodePoints } from "../../web/src/script/zh.ts";

const KEYS = { azureKey: "k", azureRegion: "eastus" };

test("scoringEngine: Azure whenever both keys are set, for any learner; local without them", () => {
  assert.deepEqual(scoringEngine({ keys: KEYS }), { engine: "azure", why: null });
  assert.deepEqual(scoringEngine({ keys: { azureKey: "k", azureRegion: " " } }), { engine: "local", why: "no_keys" });
  assert.deepEqual(scoringEngine({ keys: { azureKey: "", azureRegion: "eastus" } }), { engine: "local", why: "no_keys" });
  assert.deepEqual(scoringEngine({ keys: null }), { engine: "local", why: "no_keys" });
  // The learner's mode plays no part (the owner's decision, 2026-11-19).
  for (const mode of ["adult", "kids"]) assert.deepEqual(scoringEngine({ mode, keys: KEYS }), { engine: "azure", why: null }, mode);
});

test("readScoreText: 1 to 24 Han characters, punctuation and spaces allowed, nothing else", () => {
  for (const ok of ["大", " 你好！ ", "「謝謝」", "我很好，你呢？", "一".repeat(SCORE_MAX_CHARS)]) assert.equal(readScoreText(ok).error, undefined, ok);
  assert.equal(readScoreText(" 你好 ").text, "你好");
  for (const bad of [undefined, null, 7, "", "   ", "！？", "hello", "你好a", "我有3个", "😀", "ㄅㄆ", "ni3", "一".repeat(SCORE_MAX_CHARS + 1), `大${"。".repeat(70)}`]) {
    assert.ok(readScoreText(bad).error, JSON.stringify(bad));
  }
});

test("scoreSyllables: every Han character needs a reading; sandhi applied", () => {
  const s = scoreSyllables("你好", readCodePoints("你好", "zh-CN"));
  assert.deepEqual(s.syllables.map((x) => [x.char, x.expectedTone]), [["你", 2], ["好", 3]]);
  assert.match(scoreSyllables("你好", ["nǐ", null]).error, /no reading is known for 好/);
});

const wav = (seconds, rate = 16_000) => encodeWav(new Float32Array(Math.round(seconds * rate)), rate);

/** A lone character as the card scores it: every reading it shows. */
const card = (ch, locale = "zh-CN") => scoreSyllables(ch, readCodePoints(ch, locale), { alternatives: charReadings(ch, locale) });

test("scoreSyllables alternatives: a lone character accepts the tone of every reading the card shows", () => {
  const expect = { 长: ["cháng", [2, 3]], 行: ["xíng", [2, 4]], 好: ["hǎo", [3, 4]], 为: ["wèi", [4, 2]] };
  for (const [ch, [usual, accept]] of Object.entries(expect)) {
    const [syl] = card(ch).syllables;
    assert.equal(syl.pinyin, usual, ch);
    assert.deepEqual(syl.accept, accept, ch);
    assert.equal(syl.half, false, ch);
  }
  // 了 alone is le first, as the card puts it: a neutral usual reading stays
  // neutral (not judged), never liǎo's third tone.
  const [le] = card("了").syllables;
  assert.equal(le.pinyin, "le");
  assert.deepEqual([le.expectedTone, le.accept], [0, [0]]);
  // A phrase keeps its reading in context; no alternatives, no change.
  assert.deepEqual(scoreSyllables("长大", readCodePoints("长大", "zh-CN"), { alternatives: charReadings("长", "zh-CN") }).syllables.map((x) => x.pinyin), ["zhǎng", "dà"]);
  assert.equal(scoreSyllables("好", ["hǎo"]).syllables[0].accept.length, 1);
  // Readings in all four tones: nothing to check (拉 lā lá lǎ là, 揣, 呵);
  // 著 (zhù zhuó zhe zháo zhāo) has no third tone, so it is still checked.
  for (const ch of ["拉", "叉", "揣", "呵"]) assert.equal(card(ch).syllables[0].everyTone, true, ch);
  assert.equal(card("著").syllables[0].everyTone, undefined);
  assert.equal(card("长").syllables[0].everyTone, undefined);
});

test("scoreReply on a lone character: the reading heard is the one named, the usual one when none fits", () => {
  const run = (ch, tone) => {
    const syllables = card(ch).syllables;
    const { samples } = speak([tone], { gaps: [300, 300] });
    const sampleRate = 16000;
    const result = scoreTones({ samples, sampleRate, syllables, track: trackPitch(samples, sampleRate) });
    return scoreReply(result, syllables, { engine: "local", text: ch, locale: "zh-CN" }).syllables[0];
  };
  const pick = (y) => [y.verdict, y.pinyin, y.expectedTone];
  assert.deepEqual(pick(run("长", 2)), ["ok", "cháng", 2]);
  assert.deepEqual(pick(run("长", 3)), ["ok", "zhǎng", 3]);
  assert.deepEqual(pick(run("行", 4)), ["ok", "hàng", 4]);
  assert.deepEqual(pick(run("好", 4)), ["ok", "hào", 4]);
  assert.deepEqual(pick(run("为", 2)), ["ok", "wéi", 2]);
  // No reading fits: off against the usual one.
  const miss = run("为", 1);
  assert.deepEqual([...pick(miss), miss.heardTone], ["off", "wèi", 4, 1]);
  assert.equal(miss.reference.length > 0, true);
  // 了 said with any pitch: not judged.
  assert.deepEqual(pick(run("了", 3)), ["unsure", "le", 0]);
  // Another reading than the usual one names the usual one; the usual one doesn't.
  assert.equal(run("长", 3).usual, "cháng");
  assert.equal(run("长", 2).usual, undefined);
  assert.equal(run("为", 1).usual, undefined, "a miss");
  // 拉: whatever is heard, not sure, with the reason, the usual reading shown.
  for (const tone of [1, 3, 4]) {
    const la = run("拉", tone);
    assert.deepEqual([...pick(la), la.reason, la.heardTone, la.usual], ["unsure", "lā", 1, "every_tone", undefined, undefined], String(tone));
  }
});

test("readScoreAudio: 16 kHz mono 16-bit PCM WAV, 0.25 to 30 seconds", () => {
  assert.deepEqual(readScoreAudio(wav(1)), { seconds: 1 });
  assert.equal(readScoreAudio(wav(SCORE_MAX_SECONDS)).error, undefined);
  assert.equal(readScoreAudio(wav(SCORE_MAX_SECONDS + 0.1)).status, 413);
  assert.equal(readScoreAudio(wav(0.1)).status, 400);
  assert.equal(readScoreAudio(wav(1, 44_100)).status, 415);
  assert.equal(readScoreAudio(new Uint8Array(100)).status, 415);
  assert.equal(readScoreAudio(new TextEncoder().encode("RIFF....WAVEnot really a wav file at all, padding padding")).status, 415);
  // Stereo, and 8-bit: the header says so.
  const stereo = wav(1);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(readScoreAudio(stereo).status, 415);
  const eight = wav(1);
  new DataView(eight.buffer).setUint16(34, 8, true);
  assert.equal(readScoreAudio(eight).status, 415);
  assert.deepEqual(wavHeader(wav(0.5)), { format: 1, channels: 1, sampleRate: 16_000, bits: 16, dataBytes: 16_000 });
});

test("azureLimiter: a sliding minute per user", () => {
  const lim = azureLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) assert.equal(lim.take("a", 1000 + i), true);
  assert.equal(lim.take("a", 2000), false);
  assert.equal(lim.take("b", 2000), true, "another user has their own");
  assert.equal(lim.take("a", 61_001), true, "the first call has left the window");
  assert.equal(AZURE_PER_MINUTE > 0, true);
});

test("azureUsable: only a recognised reply with words", () => {
  assert.equal(azureUsable({ status: "Success", words: [{}] }), true);
  assert.equal(azureUsable({ status: "Success", words: [] }), false);
  assert.equal(azureUsable({ status: "NoMatch", words: [{}] }), false);
  assert.equal(azureUsable(null), false);
});

test("toneShape: the textbook contours, centred, about ten semitones for a fourth tone", () => {
  const four = toneShape(4);
  assert.equal(four.length, 16);
  assert.ok(four[0] > 0 && four[15] < 0 && Math.abs(four[0] - four[15] - 10) < 0.01);
  assert.ok(toneShape(1).every((v) => v === 0));
  const three = toneShape(3);
  assert.ok(Math.min(...three) < three[0] && three[15] > three[0], "dips, then rises past where it began");
  const half = toneShape(3, { half: true });
  assert.ok(half[15] <= half[0], "the half third does not rise");
  assert.equal(toneShape(0), null);
  assert.ok(toneShape(2)[15] > toneShape(2)[0]);
});

test("centredCurve: about its own voiced mean, gaps kept", () => {
  assert.deepEqual(centredCurve([1, null, 3]), [-1, null, 1]);
  assert.deepEqual(centredCurve([null, 2]), []);
  assert.deepEqual(centredCurve(undefined), []);
});

test("scoreReply: heard tone only on an off, reasons on unsure, no score for kids, clipped asks again", () => {
  const text = "你好吗";
  const { syllables } = scoreSyllables(text, readCodePoints(text, "zh-CN"));
  const base = (s, i) => ({ char: s.char, pinyin: s.pinyin, baseTone: s.baseTone, expectedTone: s.expectedTone, accept: s.accept, confidence: 0.8, startMs: i * 300, endMs: i * 300 + 250, pitch: [0, 1, 2, null] });
  const result = {
    provider: "local",
    overall: 50,
    syllables: [
      { ...base(syllables[0], 0), verdict: "ok", heardTone: 2 },
      { ...base(syllables[1], 1), verdict: "off", heardTone: 1 },
      { ...base(syllables[2], 2), verdict: "unsure", heardTone: 4, reason: "neutral" },
    ],
  };
  const r = scoreReply(result, syllables, { engine: "local", fallback: "no_keys", text, locale: "zh-CN" });
  assert.deepEqual(r.syllables.map((s) => [s.verdict, s.heardTone, s.why, s.reason]), [["ok", undefined, undefined, undefined], ["off", 1, "tone", undefined], ["unsure", undefined, undefined, "neutral"]]);
  assert.equal(r.overall, 50);
  assert.equal(r.retry, null);
  assert.deepEqual(r.syllables[0].heard, [-1, 0, 1, null]);
  assert.equal(r.syllables[2].reference, null, "a neutral tone has no shape");
  assert.ok(Array.isArray(r.syllables[1].reference), "好 before 吗 is a half third");
  assert.ok(r.syllables[1].reference[15] <= r.syllables[1].reference[0]);
  assert.equal(scoreReply(result, syllables, { engine: "local", kids: true, text, locale: "zh-CN" }).overall, null);
  const clipped = { ...result, syllables: [{ ...result.syllables[0], verdict: "unsure", reason: "clipped" }, ...result.syllables.slice(1)] };
  assert.equal(scoreReply(clipped, syllables, { engine: "local", text, locale: "zh-CN" }).retry, "clipped");
  const sound = { ...result, syllables: [result.syllables[0], { ...result.syllables[1], reason: "sound" }, result.syllables[2]] };
  assert.equal(scoreReply(sound, syllables, { engine: "azure", text, locale: "zh-CN" }).syllables[1].why, "sound");
});
