// Pronunciation scoring, stage 0 (ld-ne0.1): the engine only. No routes, no
// UI, no storage; later stages wire it (docs/VOICE.md §Pronunciation).
//
// Speech-to-text is generous: a learner's wrong tone still transcribes as
// the right word, so nobody tells them. This module scores a recording
// against the text it was meant to be and answers one shape whichever
// engine did the work:
//
//   { provider: "azure" | "local",
//     syllables: [{ char, pinyin, baseTone, expectedTone, accept, heardTone,
//                   verdict: "ok" | "off" | "unsure", confidence, reason?,
//                   score?, startMs, endMs, pitch }],
//     overall? }
//
// A syllable is "off" only when the engine is confident; everything else it
// can't vouch for is "unsure". A false alarm costs more than a miss: a
// learner told a right tone was wrong stops trusting the marks.
//
// Two engines:
//  - Azure Pronunciation Assessment when Azure keys are set
//    (azurePronunciationRequest / azurePronunciationResult). Built from the
//    docs, then run live for zh-CN (see the comments there). Azure times
//    and scores each syllable but reports no heard tone for Mandarin, so
//    the local pitch check below runs on Azure's timings and the two are
//    merged (mergeAzure).
//  - Local, on this Mac, for everyone else: a YIN pitch track over the
//    16 kHz mono WAV the browser already sends (web/src/recorder.ts), cut
//    into syllables by the caller's timings or by energy, each contour
//    matched against the four tones after the connected-speech rules have
//    been applied to what was expected (third-tone sandhi, 不 and 一, the
//    half third, the neutral tone).
//
// v1 is Mandarin tones. Pure ESM with no server imports and no dependency,
// like scripts/voice.mjs, so `node --test` covers it. Pinyin comes from the
// caller (web/src/script/zh.ts readCodePoints: pinyin-pro is the web
// package's dependency, with the Taiwan readings and the particle fixes
// already applied), never from here.
//
// How well it does on synthesized speech: docs/pronunciation-proof.md,
// written by scripts/pronunciation-proof.mjs.

/* -------------------------------- providers ------------------------------- */

export const PRONUNCIATION_PROVIDERS = ["azure", "local"];

/** Which engine scores a recording: a pure function of the keys
 *  (`voiceKeys()` in scripts/voice.mjs). Azure needs its key and its region,
 *  the same test as `configuredProviders`; anything less is local. */
export function pronunciationProvider(keys) {
  return keys && String(keys.azureKey ?? "").trim() && String(keys.azureRegion ?? "").trim() ? "azure" : "local";
}

/** The locales v1 scores: Mandarin, either script. Cantonese is another
 *  language with other tones. */
export function scoresTones(locale) {
  return isMandarin(parseLocale(locale));
}

/** The one reading of a locale tag in this module: `{ lang, script, region }`
 *  from `zh`, `zh_TW`, `zh-Hant-TW`, `cmn-Hans-CN`, `es-mx`, or null for
 *  anything that isn't language[-Script][-REGION] in letters (`zh-yue`,
 *  `zh-CN&x=1`: the value can end up in a URL). */
function parseLocale(locale) {
  const parts = String(locale ?? "").trim().replace(/_/g, "-").split("-");
  if (!/^[A-Za-z]{2,3}$/.test(parts[0] ?? "")) return null;
  let script = null;
  let region = null;
  for (const x of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(x) && !script && !region) script = x.toLowerCase();
    else if (/^[A-Za-z]{2}$/.test(x) && !region) region = x.toUpperCase();
    else return null;
  }
  return { lang: parts[0].toLowerCase(), script, region };
}

// Where "zh" means Mandarin. Hong Kong and Macau are Cantonese, another
// language with other tones.
const MANDARIN_REGIONS = new Set(["CN", "TW", "SG", "MY"]);
const isMandarin = (p) => Boolean(p) && (p.lang === "zh" || p.lang === "cmn") && (!p.region || MANDARIN_REGIONS.has(p.region));

/* ---------------------------------- pinyin --------------------------------- */

const TONE_MARKS = {
  ā: ["a", 1], á: ["a", 2], ǎ: ["a", 3], à: ["a", 4],
  ē: ["e", 1], é: ["e", 2], ě: ["e", 3], è: ["e", 4],
  ī: ["i", 1], í: ["i", 2], ǐ: ["i", 3], ì: ["i", 4],
  ō: ["o", 1], ó: ["o", 2], ǒ: ["o", 3], ò: ["o", 4],
  ū: ["u", 1], ú: ["u", 2], ǔ: ["u", 3], ù: ["u", 4],
  ǖ: ["ü", 1], ǘ: ["ü", 2], ǚ: ["ü", 3], ǜ: ["ü", 4],
  ń: ["n", 2], ň: ["n", 3], ǹ: ["n", 4], ḿ: ["m", 2],
  ế: ["ê", 2], ề: ["ê", 4],
};
const MARK_FOR = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", ü: "ǖǘǚǜ" };

/** A tone-marked syllable (mǎ, lǜ, ma) → its letters and tone; 0 is the
 *  neutral tone. A trailing digit (ma3, ma5) is read too. */
export function parsePinyin(syllable) {
  const s = String(syllable ?? "").normalize("NFC").trim().toLowerCase();
  const digit = s.match(/^([a-zêü]+)([0-5])$/);
  if (digit) return { base: digit[1], tone: digit[2] === "5" ? 0 : Number(digit[2]) };
  let base = "";
  let tone = 0;
  for (const ch of s) {
    const m = TONE_MARKS[ch];
    if (m) {
      base += m[0];
      tone = m[1];
    } else base += ch;
  }
  return { base, tone };
}

/** The same syllable in another tone, marked where pinyin puts the mark (a
 *  or e if there is one, the o of ou, else the last vowel). The proof
 *  harness relabels clips with it; a later stage shows what was heard. */
export function withTone(syllable, tone) {
  const { base } = parsePinyin(syllable);
  if (!tone) return base;
  const at = base.includes("a") ? base.indexOf("a")
    : base.includes("e") ? base.indexOf("e")
      : base.includes("ou") ? base.indexOf("o")
        : Math.max(...[...base].map((c, i) => (MARK_FOR[c] ? i : -1)));
  if (at < 0) return base;
  return base.slice(0, at) + MARK_FOR[base[at]][tone - 1] + base.slice(at + 1);
}

/* ------------------------- what the learner should say --------------------- */

// Characters that make a neighbouring 一 a number rather than "a/one + noun":
// 十一, 一九九八, 第一. There 一 keeps its first tone.
const DIGITS = new Set([..."零〇一二三四五六七八九十"]);
// …but before these it is still a quantity and changes: 一百 yì bǎi.
const BIG_UNITS = new Set([..."百千万萬亿億"]);
// Calendar and ordinal nouns where 一 is read as a number (一月, 一号, 一楼):
// either reading is taken as right, since only a word list could tell.
const ORDINAL_NOUNS = new Set([..."月号號日楼樓层層班年"]);
const HAN = /\p{Script=Han}/u;

/**
 * The syllables of `text` with the tone each should carry in connected
 * speech. `readings` is one entry per code point of `text`: tone-marked
 * pinyin for a Chinese character, null for anything else, each character's
 * own (citation) tone: what `readCodePoints(text, locale)` in
 * web/src/script/zh.ts returns, with the Taiwan readings already applied for
 * zh-TW.
 *
 * Each syllable gets:
 *  - `baseTone`: the dictionary tone (0 neutral);
 *  - `expectedTone`: what a speaker says there after the rules below;
 *  - `accept`: every tone that counts as right, which is wider than
 *    `expectedTone` wherever the rule depends on something this function
 *    can't see (word boundaries, whether 一 is a number). Wide on purpose:
 *    the comparison must not flag a reading a teacher would accept;
 *  - `half`: a third tone before another tone, said low without the rise.
 *
 * Punctuation ends a phrase: no rule reaches across it.
 */
export function expectedSyllables(text, readings) {
  const cps = [...String(text ?? "")];
  const out = [];
  let broke = true;
  for (let i = 0; i < cps.length; i++) {
    const r = readings?.[i];
    if (r && HAN.test(cps[i])) {
      const { tone } = parsePinyin(r);
      out.push({ char: cps[i], pinyin: r, baseTone: tone, breakBefore: broke });
      broke = false;
    } else if (!/\s/.test(cps[i])) {
      // Punctuation, a digit, a Latin word: a pause or a foreign word, and
      // either way the end of the tone group.
      broke = true;
    }
  }
  return applySandhi(out);
}

/** The connected-speech rules over syllables that carry `char`, `baseTone`
 *  and `breakBefore`. Returns new objects with `expectedTone`, `accept` and
 *  `half` added. Exported so a caller holding its own readings (the proof
 *  harness relabelling a clip) uses the same rules. */
export function applySandhi(syllables) {
  const s = syllables.map((x) => ({ ...x, expectedTone: x.baseTone, accept: [x.baseTone], half: false }));
  const next = (i) => (i + 1 < s.length && !s[i + 1].breakBefore ? s[i + 1] : null);
  const prev = (i) => (i > 0 && !s[i].breakBefore ? s[i - 1] : null);
  const set = (x, tone, ...also) => {
    x.expectedTone = tone;
    x.accept = [...new Set([tone, ...also])];
  };

  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    const n = next(i);
    const p = prev(i);
    if (x.char === "一" && x.baseTone === 1) {
      if (!n) continue; // 第一, 十一, 一: said yī at the end
      // 看一看: light and toneless between the doubled verb.
      if (p && p.char === n.char) set(x, 0, 1, 2, 4);
      else {
        // A neutral-tone measure word is 个 at heart (fourth tone): yí ge.
        const changed = n.baseTone === 4 || n.baseTone === 0 ? 2 : 4;
        const numeric = (p && (p.char === "第" || DIGITS.has(p.char))) || (DIGITS.has(n.char) && !BIG_UNITS.has(n.char));
        // After another syllable 一 may be the end of a word (统一了, 唯一的,
        // 统一思想), where it keeps yī whatever follows. Only a word list
        // could tell, so there the first tone is right as well; at the start
        // of a phrase it can only be the changing 一.
        const final = p ? [1] : [];
        if (numeric) set(x, 1, changed);
        else if (ORDINAL_NOUNS.has(n.char)) set(x, changed, 1);
        else if (n.baseTone === 0) set(x, changed, 4, ...final);
        else set(x, changed, ...final);
      }
    } else if (x.char === "不" && x.baseTone === 4) {
      if (!n) continue;
      // 是不是, 好不好: light in the middle; a careful speaker still says
      // bú / bù, so all three are right.
      if (p && p.char === n.char) set(x, n.baseTone === 4 ? 2 : 4, 0, 2, 4);
      else if (n.baseTone === 4) set(x, 2);
      // Before a neutral syllable the tone it lost decides, which is unknown.
      else if (n.baseTone === 0) set(x, 4, 2);
    }
  }

  // Third-tone sandhi over each run of third tones. The last keeps its tone
  // and the one before it rises (你好 ní hǎo). Further back the grouping
  // decides (我很好 is wó hén hǎo or wǒ hén hǎo), and grouping needs word
  // boundaries this function doesn't have: both are right there.
  for (let i = 0; i < s.length; i++) {
    if (s[i].expectedTone !== 3) continue;
    let end = i;
    while (end + 1 < s.length && !s[end + 1].breakBefore && s[end + 1].expectedTone === 3) end++;
    for (let k = i; k < end; k++) {
      if (k === end - 1) set(s[k], 2);
      else set(s[k], 2, 3);
    }
    i = end;
  }

  // A third tone doubled with a neutral second half (姐姐, 奶奶, 宝宝, 走走):
  // the second lost a third tone, and many speakers, children above all,
  // still let it lift the first (jiéjie, báobao). Both are right.
  for (let i = 0; i < s.length; i++) {
    const n = next(i);
    if (s[i].expectedTone === 3 && n && n.baseTone === 0 && n.char === s[i].char) s[i].accept = [...new Set([...s[i].accept, 2])];
  }

  // The half third: before any other tone a third tone stays low and never
  // rises. Same category, so `accept` is unchanged; the classifier treats
  // low-and-falling as a third tone everywhere.
  for (let i = 0; i < s.length; i++) {
    const n = next(i);
    if (s[i].expectedTone === 3 && n) s[i].half = true;
  }
  return s;
}

/* ----------------------------------- audio --------------------------------- */

/** A RIFF/WAVE file of 16-bit PCM → mono float samples. The browser sends
 *  16 kHz mono (web/src/recorder.ts toWav); other rates and stereo are
 *  taken too (channels averaged), since the proof harness and a narrator's
 *  clip come from elsewhere. Throws on anything that isn't PCM16. */
export function parseWav(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (u8.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let fmt = null;
  while (at + 8 <= u8.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      // 0xFFFE is WAVE_FORMAT_EXTENSIBLE, which ffmpeg writes for PCM too.
      if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16) throw new Error("WAV must be 16-bit PCM");
      // A streamed file may claim a size past its end (0xFFFFFFFF).
      const bytes = Math.min(size, u8.length - body);
      const frames = Math.floor(bytes / 2 / fmt.channels);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += view.getInt16(body + (i * fmt.channels + c) * 2, true);
        samples[i] = sum / fmt.channels / 32768;
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    at = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

/** Float samples → a 16-bit PCM mono WAV (tests build their recordings
 *  with it; the proof harness never needs to). */
export function encodeWav(samples, sampleRate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at, s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  ascii(36, "data");
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/* ----------------------------------- pitch --------------------------------- */

/** Frame step of the pitch track. Ten milliseconds gives a 150 ms syllable
 *  fifteen points, enough to tell a rise from a fall. */
export const HOP_MS = 10;

// The search range covers a low adult voice (about 70 Hz at the bottom of a
// third tone) and a small child (a high first tone can pass 600 Hz). The
// ceiling was 600 until a review showed a 640 Hz tone coming back
// unvoiced; 800 changes nothing on the proof clips.
const F_MIN = 60;
const F_MAX = 800;
// YIN's own threshold on the normalised difference: the first dip under it
// is the period. 0.15 is the paper's value.
const YIN_THRESHOLD = 0.15;
// A frame whose best dip is still above this has no clear period: unvoiced.
const VOICED_MAX = 0.45;
// …and one this far under the clip's loudest frame is silence or a breath.
const SILENCE_RATIO = 0.04;

const hzToSt = (hz) => 12 * Math.log2(hz);

function median(values) {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function quantile(values, q) {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const at = (a.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return a[lo] + (a[hi] - a[lo]) * (at - lo);
}

/**
 * The pitch of `samples` every HOP_MS: YIN (de Cheveigné & Kawahara 2002,
 * "YIN, a fundamental frequency estimator for speech and music", JASA
 * 111(4)), written out here rather than taken as a dependency: it is sixty
 * lines, has no native part, and the tests can feed it sine sweeps.
 *
 * Returns `{ hopMs, f0, rawF0, rms, periodicity, zcr }`, one entry per
 * frame, frame i centred at i × hopMs. `f0` is hertz, 0 where the frame is
 * unvoiced (no clear period, or too quiet). `rawF0` is the same before the
 * steps that look at the whole recording (the silence floor, octave slips,
 * the range gate): scoreTones redoes those from it on the part of the
 * recording it takes for speech, so that a cough or another voice
 * elsewhere can't decide them. It is a field of the track, so it survives
 * a structured copy (a worker's postMessage, a cache that keeps typed
 * arrays). It does not survive JSON, which turns a typed array into an
 * object with no length: such a track is not used at all. scoreTones
 * reads the pitch from `rawF0`, never from `f0`, and a track without a
 * usable one is not scored (the recording is tracked again from the
 * samples, or nothing is judged).
 * `periodicity` is 1 − YIN's dip, so 1 is a
 * clean period; creaky voice sits low. `zcr` is the share of samples where
 * the wave changes sign: high in the hiss of s or sh, low in creak, which
 * is how the two kinds of loud unvoiced frame are told apart.
 */
export function trackPitch(samples, sampleRate, { fMin = F_MIN, fMax = F_MAX } = {}) {
  const hop = Math.round((sampleRate * HOP_MS) / 1000);
  const W = Math.round(sampleRate * 0.02);
  const tauMax = Math.min(Math.floor(sampleRate / fMin), W * 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  const frames = Math.max(0, Math.floor(samples.length / hop) + 1);
  const f0 = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const periodicity = new Float32Array(frames);
  const zcr = new Float32Array(frames);
  const d = new Float32Array(tauMax + 1);
  const span = W + tauMax;

  for (let f = 0; f < frames; f++) {
    // Centre the analysis span on the frame's time; clamp at the edges.
    const start = Math.max(0, Math.min(samples.length - span, f * hop - (span >> 1)));
    if (samples.length < span) break;
    let energy = 0;
    let crossings = 0;
    for (let j = 0; j < W; j++) {
      const v = samples[start + (tauMax >> 1) + j];
      energy += v * v;
      if (j && v >= 0 !== samples[start + (tauMax >> 1) + j - 1] >= 0) crossings++;
    }
    rms[f] = Math.sqrt(energy / W);
    zcr[f] = crossings / W;

    // The difference function, then its cumulative-mean normalisation.
    let running = 0;
    d[0] = 1;
    let best = -1;
    let bestVal = Infinity;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const diff = samples[start + j] - samples[start + j + tau];
        sum += diff * diff;
      }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < bestVal) {
        bestVal = d[tau];
        best = tau;
      }
      // The first dip under the threshold, followed down to its bottom:
      // taking the global minimum instead picks octave-low periods.
      if (found < 0 && d[tau] < YIN_THRESHOLD) {
        let t = tau;
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        found = t;
        break;
      }
    }
    if (found < 0 && best > 0) {
      // No dip that deep (a fast glide, a rough voice). The deepest dip
      // may be two periods along, an octave low; the first local dip
      // nearly as deep is the period.
      for (let tau = tauMin + 1; tau < best; tau++) {
        if (d[tau] < bestVal + 0.1 && d[tau] <= d[tau - 1] && d[tau] <= d[tau + 1]) {
          best = tau;
          break;
        }
      }
    }
    const tau = found >= 0 ? found : best;
    if (tau <= 0) continue;
    periodicity[f] = Math.max(0, 1 - d[tau]);
    if (d[tau] > VOICED_MAX) continue;
    // Parabolic interpolation around the dip for a sub-sample period.
    const a = d[tau - 1] ?? d[tau];
    const b = d[tau];
    const c = d[tau + 1] ?? d[tau];
    const denom = a - 2 * b + c;
    const shift = denom ? (a - c) / (2 * denom) : 0;
    f0[f] = sampleRate / (tau + (Math.abs(shift) < 1 ? shift : 0));
  }

  for (let f = 0; f < frames; f++) if (f0[f] < fMin || f0[f] > fMax) f0[f] = 0;
  return { hopMs: HOP_MS, f0: finishPitch(f0, rms), rawF0: f0, rms, periodicity, zcr };
}

/** A track's pitch before finishPitch (`rawF0`), or null when it has none
 *  that fits its frames. */
const rawPitch = (track) => (track?.rawF0 && Number.isFinite(track.rawF0.length) && track.rawF0.length === track.rms?.length ? track.rawF0 : null);

/**
 * A pitch track's `f0` from its `raw` pitch: frames under the silence
 * floor unvoiced, octave slips undone, pitch outside one voice's range
 * dropped, specks dropped, a median filter. With `keep` (one flag per
 * frame) only those frames are read and everything else is unvoiced: the
 * floor is set by the loudest kept frame and the range by the kept
 * frames' median, so nothing outside them has a say. `gate: false` leaves
 * out the range gate (for finding the speech, before it is known whose
 * median to use).
 */
function finishPitch(raw, rms, keep = null, gate = true) {
  const n = raw.length;
  const f0 = Float32Array.from(raw);
  let peak = 0;
  for (let i = 0; i < n; i++) if ((!keep || keep[i]) && rms[i] > peak) peak = rms[i];
  const floor = peak * SILENCE_RATIO;
  for (let i = 0; i < n; i++) if ((keep && !keep[i]) || rms[i] < floor) f0[i] = 0;
  smoothTrack(f0, gate);
  return f0;
}

/** In place: undo octave slips, drop voiced specks, median-filter. */
function smoothTrack(f0, gate = true) {
  const n = f0.length;
  // An octave slip is a short stretch that sits about twelve semitones from
  // the rest of its own voiced run, across a jump no voice makes in 10 ms.
  // Each run is cut at such jumps and every piece is compared with the
  // run's longest piece; a short piece an octave away is moved back. Judged
  // per run and never frame against the corrected frame before it: that
  // let one wrong onset frame "correct" every right frame after it. A run
  // may hold a single unvoiced frame (the tracker often loses the frame
  // where the period changes) but never a real silence, and a piece is
  // only moved when it is short (80 ms): a fourth tone really does start
  // nine semitones above the syllable before it, and a child's third tone
  // an octave under the next, so height alone proves nothing.
  const voicedAt = (k) => k < n && (f0[k] > 0 || (k > 0 && k + 1 < n && f0[k - 1] > 0 && f0[k + 1] > 0));
  for (let i = 0; i < n; ) {
    if (!f0[i]) {
      i++;
      continue;
    }
    let j = i;
    while (voicedAt(j)) j++;
    const pieces = [];
    let from = i;
    let prev = i;
    for (let k = i + 1; k <= j; k++) {
      if (k < j && !f0[k]) continue;
      if (k === j || Math.abs(hzToSt(f0[k]) - hzToSt(f0[prev])) >= 7) {
        pieces.push({ from, to: prev + 1 });
        from = k;
      }
      prev = k;
    }
    if (pieces.length > 1) {
      const stOf = (piece) => median([...f0.subarray(piece.from, piece.to)].filter((v) => v > 0).map(hzToSt));
      const longest = pieces.reduce((x, y) => (y.to - y.from > x.to - x.from ? y : x));
      const home = stOf(longest);
      for (const piece of pieces) {
        const size = piece.to - piece.from;
        if (piece === longest || size > 8 || size * 2 > longest.to - longest.from) continue;
        const diff = stOf(piece) - home;
        if (Math.abs(Math.abs(diff) - 12) < 2.5) for (let k = piece.from; k < piece.to; k++) f0[k] = diff > 0 ? f0[k] / 2 : f0[k] * 2;
      }
    }
    i = j;
  }
  // Further than fourteen semitones from the middle is outside any one
  // voice's speaking range: a squeak at the release, not pitch.
  // The middle is the median of what this call was given: the whole
  // recording for trackPitch, only the speech for scoreTones (a child's
  // voice in the lead-in once set it, and the adult's syllables were
  // dropped as squeaks).
  if (gate) {
    const centre = median([...f0].filter((v) => v > 0).map(hzToSt));
    for (let i = 0; i < n; i++) if (f0[i] && Math.abs(hzToSt(f0[i]) - centre) > 14) f0[i] = 0;
  }
  // A voiced run shorter than 30 ms is a click or a fricative's edge.
  for (let i = 0; i < n; ) {
    if (!f0[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && f0[j]) j++;
    if (j - i < 3) for (let k = i; k < j; k++) f0[k] = 0;
    i = j;
  }
  const copy = Float32Array.from(f0);
  for (let i = 1; i < n - 1; i++) {
    if (!copy[i] || !copy[i - 1] || !copy[i + 1]) continue;
    f0[i] = median([copy[i - 1], copy[i], copy[i + 1]]);
  }
}

/**
 * A speaker's pitch range from one or more tracks: the median and the 5th
 * and 95th percentiles of the voiced frames, in hertz. Tones are relative:
 * a child's low tone is above a man's high one, so every contour is read
 * against the range of the voice that said it. A later stage keeps one per
 * learner per session and passes it to `scoreTones` as `speaker`; without
 * one the scorer falls back to the recording's own range, which a single
 * syllable doesn't have.
 */
export function speakerRange(tracks) {
  const st = [];
  // Clean frames only: creak and the edges of consonants read low or wild
  // and would stretch the range past what the voice uses for tones.
  for (const t of Array.isArray(tracks) ? tracks : [tracks]) for (let i = 0; i < t.f0.length; i++) if (t.f0[i] > 0 && t.periodicity[i] >= 0.8) st.push(hzToSt(t.f0[i]));
  if (st.length < 20) return null;
  const toHz = (s) => 2 ** (s / 12);
  return { medianHz: toHz(median(st)), lowHz: toHz(quantile(st, 0.05)), highHz: toHz(quantile(st, 0.95)), frames: st.length };
}

/* ---------------------------------- trimming -------------------------------- */

/** What counts as speech when nobody said where it is: the energy path,
 *  the fallback for a recording that comes without syllable timings.
 *
 *  EVERY number here comes from 43 real clips of ONE speaker, one
 *  microphone, one room (docs/VOICE.md §Pronunciation): the noises seen
 *  there were 30–50 ms long, 16–25 dB under the speech and 260 ms or more
 *  away from it. None is "held out", and another voice or room will sit
 *  differently against each bar.
 *
 *  So the bars are not believed. The rule the energy path is held to: any
 *  doubt about where the speech is ends in "unsure", for an "ok" as much
 *  as for an "off". A run the bars can't place is read both ways (with it
 *  and without it) and a verdict stands only where the two readings give
 *  the same verdict and the same tone; and a recording where the bars
 *  can't even say which stretch is the speech is not judged at all
 *  (speechOf). What that costs and what it still lets through is measured
 *  in the proof's "With lead-in noise" and its small copy in `npm test`. */
export const TRIM_RULES = Object.freeze({
  // A voiced run this long and within `sureDb` of the loudest voiced
  // frame is speech by the bars.
  runMs: 80,
  sureDb: -12,
  // Voice either side of a hole this short is one run.
  joinMs: 20,
  // Under `floorDb` a run far from the speech is noise; over it, it could
  // be a syllable (a short last one after a beginner's pause) or a knock,
  // a blip, a murmur.
  floorDb: -26,
  // "Near" the speech: a soft neutral tone at the end of a phrase, the
  // pieces of a creaky vowel, a syllable cut short; or a knock.
  nearMs: 200,
  // Kept around the speech: room for an unvoiced consonant before the
  // first vowel (sh, q, a long aspirated stop) and for the end of the last.
  beforeMs: 250,
  afterMs: 120,
  // …and past that for as long as it stays loud (this share of the loudest
  // voiced frame) with no quiet stretch longer than `bridgeMs`: a creaky
  // voice can say a whole last syllable without one frame of clear pitch.
  loudShare: 0.15,
  bridgeMs: 100,
  // A pitched background (mains hum, a fan): this long a voiced stretch
  // softer than `sureDb` whose pitch stays within `stillSt` semitones. No
  // voice holds still that long that softly, and under such a recording
  // nothing the tracker says between or under the syllables is the voice.
  stillMs: 300,
  stillSt: 0.5,
  // A sound this long can be judged as a syllable (TONE_RULES.minFrames)…
  judgeMs: 60,
  // …and a sound shows in the track as a voiced run about this much
  // longer than it is: a frame's analysis window (trackPitch: 20 ms and
  // the longest period) reaches that far either side of it. A 40 ms knock
  // is a 70 ms run.
  windowMs: 30,
  // More doubted runs than this and the recording is not read at all.
  maxDoubts: 3,
});

/** The voiced runs of a track (frames `from`…`to`), each with what the
 *  bars say of it: `strong`, within sureDb of the loudest; `core`, strong
 *  and long (when no run is, the loudest one); `keep`, core or over the
 *  floor and near a kept run (what trimToSpeech keeps); `loud`, over the
 *  floor. `peak` is the loudest voiced frame. */
function speechRuns(track, rules) {
  const { f0, rms, hopMs } = track;
  const n = f0.length;
  let peak = 0;
  for (let i = 0; i < n; i++) if (f0[i] > 0 && rms[i] > peak) peak = rms[i];
  const floor = peak * 10 ** (rules.floorDb / 20);
  const sure = peak * 10 ** (rules.sureDb / 20);
  const minRun = Math.round(rules.runMs / hopMs);
  const near = Math.round(rules.nearMs / hopMs);
  const join = Math.round(rules.joinMs / hopMs);
  const runs = [];
  for (let i = 0; i < n; ) {
    if (!(f0[i] > 0)) {
      i++;
      continue;
    }
    let j = i;
    let top = 0;
    for (; j < n && f0[j] > 0; j++) if (rms[j] > top) top = rms[j];
    // The tracker loses a frame or two inside a vowel (where the period
    // changes, at the bottom of a fall): voice either side of so short a
    // hole is one run.
    const prev = runs[runs.length - 1];
    if (prev && i - prev.to <= join) {
      prev.to = j;
      prev.top = Math.max(prev.top, top);
    } else runs.push({ from: i, to: j, top });
    i = j;
  }
  for (const r of runs) {
    r.loud = r.top >= floor;
    r.strong = r.top >= sure;
    r.core = r.strong && r.to - r.from >= minRun;
  }
  // No run long enough at all (a clipped syllable, a vowel the tracker
  // broke into pieces): the loudest run is the speech.
  if (runs.length && !runs.some((r) => r.core)) runs.reduce((x, y) => (y.top > x.top ? y : x)).core = true;
  for (const r of runs) r.keep = r.core;
  // Short loud runs join the speech they are near, and then count as
  // speech for the next one along.
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of runs) {
      if (r.keep || !r.loud) continue;
      if (runs.some((k) => k.keep && r.from - k.to <= near && k.from - r.to <= near)) {
        r.keep = true;
        changed = true;
      }
    }
  }
  return { runs, peak };
}

/** `track` with only the runs `isSpeech` picks left voiced, and silence
 *  outside the stretch they span (a little kept before and after, and
 *  further while the sound stays loud); the other runs are silenced, their
 *  loudness too. Given the raw pitch (`before`), the kept part is
 *  finished again on its own (finishPitch), so the silence floor and the
 *  range gate are the speech's and not the recording's. Says what was done
 *  in `trim`: the frames kept (`from`, `to`) and the voiced runs removed
 *  (`dropped`). The same track when there is no run to keep. */
function cutToRuns(track, { runs, peak, before = null }, isSpeech, rules) {
  const { f0, rms, hopMs } = track;
  const n = f0.length;
  const kept = runs.filter(isSpeech);
  if (!kept.length) return track;
  let lo = Math.max(0, kept[0].from - Math.round(rules.beforeMs / hopMs));
  let hi = Math.min(n, kept[kept.length - 1].to + Math.round(rules.afterMs / hopMs));
  // Loud sound that runs on from the kept stretch belongs to it.
  const bridge = Math.round(rules.bridgeMs / hopMs);
  const loud = (i) => rms[i] >= peak * rules.loudShare;
  for (let i = lo - 1; i >= 0 && lo - i <= bridge; i--) if (loud(i)) lo = i;
  for (let i = hi; i < n && i - hi < bridge; i++) if (loud(i)) hi = i + 1;
  const dropped = runs.filter((r) => !isSpeech(r));
  if (!before && !dropped.length && lo === 0 && hi === n) return track;
  const keep = new Uint8Array(n).fill(1, lo, hi);
  const outRms = Float32Array.from(rms);
  outRms.fill(0, 0, lo);
  outRms.fill(0, hi);
  // A run that isn't speech is not there at all: its frames, and the one
  // either side its sound spills into, are silent to the cuts as well.
  for (const r of dropped) {
    keep.fill(0, r.from, r.to);
    if (r.to > lo && r.from < hi) outRms.fill(0, Math.max(lo, r.from - 1), Math.min(hi, r.to + 1));
  }
  const outF0 = before ? finishPitch(before, rms, keep) : Float32Array.from(f0, (v, i) => (keep[i] ? v : 0));
  // The raw pitch goes with what was kept: scoring the trimmed track must
  // not bring back what the trim took out.
  const raw = before ?? rawPitch(track);
  return { ...track, f0: outF0, ...(raw ? { rawF0: Float32Array.from(raw, (v, i) => (keep[i] ? v : 0)) } : {}), rms: outRms, trim: { from: lo, to: hi, dropped: dropped.map((r) => ({ from: r.from, to: r.to })) } };
}

/**
 * A pitch track with everything that isn't the speech silenced, by the
 * bars alone (TRIM_RULES): the seconds before and after it in a
 * push-to-talk recording, and what lives there (a key press, a breath, a
 * short pitched blip of room noise). Speech is the voiced runs that are
 * long and loud, plus the ones near them that are not much softer; the
 * track is kept from a little before the first to a little after the
 * last, and inside that stretch nothing is touched except stray voiced
 * runs, which become unvoiced. A trimmed track says what was done to it
 * in `trim`: the frames kept (`from`, `to`) and the voiced runs removed
 * (`dropped`, frames). A track with no speech in it is returned as it is.
 *
 * This is one opinion of where the speech is, for drawing and for the
 * proof. scoreTones doesn't rest a verdict on it: see speechOf.
 */
export function trimToSpeech(track, rules = TRIM_RULES) {
  return cutToRuns(track, speechRuns(track, rules), (r) => r.keep, rules);
}

/**
 * Where the speech is in a recording that came without timings, as far as
 * energy can say: `{ tracks }`, one or more readings of it, or `{ doubt }`
 * (a reason) when it can't say at all.
 *
 * The first track keeps only the runs that are speech by any measure
 * (`core`: long, and within sureDb of the loudest). Every other run that
 * might be speech is doubted:
 *   - any run within nearMs of the core ones, however soft (the soft end
 *     of a syllable, a last one said under the floor, the pieces of a
 *     creaky vowel; or a knock, a click, an "uh"), and
 *   - when there is more than one syllable to find, any run over the floor
 *     wherever it is (a short last syllable after a beginner's pause; or a
 *     blip. One syllable is one sound: a far run too short to judge is no
 *     part of it).
 * There is a track for every choice of doubted runs to take as speech
 * (with up to `maxDoubts` of them: 2, 4 or 8 tracks). None is believed
 * over another: scoreTones reads them all and a verdict stands only where
 * all agree. So a doubted run that was noise costs verdicts and can't add
 * one, and one that was a syllable can't be erased into a wrong verdict;
 * and with a knock and the soft end of a word both doubted, the reading
 * that is right (one kept, the other not) is among them.
 *
 * No reading at all:
 *  - "scattered": sounds long enough to judge (`judgeMs`, measured net
 *    of the analysis window: a run of `judgeMs + windowMs`) and over the floor
 *    lie in stretches of sound more than nearMs apart. One of them may be a cough, another
 *    voice, a chair; or the speaker paused. Energy can't tell which
 *    stretch is the speech, and reading them all as speech puts the cuts
 *    on the wrong characters.
 *  - "trimmed": more doubted runs than `maxDoubts`.
 *
 * What this still lets through, because nothing in the energy shows it: a
 * loud voiced sound within nearMs of the speech and 80 ms or longer, a
 * knock on top of the first sound, a recording that starts mid-word, a
 * room that echoes (the proof's "With lead-in noise" has the numbers).
 */
function speechOf(raw, count, rules = TRIM_RULES) {
  // Found on the pitch before the range gate: whose median to gate
  // against is only known once the speech is.
  const before = rawPitch(raw);
  const loose = { ...raw, f0: finishPitch(before, raw.rms, null, false) };
  const found = speechRuns(loose, rules);
  found.before = before;
  const core = found.runs.filter((r) => r.core);
  if (!core.length) return { tracks: [raw] };
  const near = Math.round(rules.nearMs / raw.hopMs);
  const judge = Math.round((rules.judgeMs + rules.windowMs) / raw.hopMs);
  // Stretches of sound: runs as loud as speech, each within nearMs of the
  // next (a syllable with 50 ms of voice between two others holds a
  // phrase together). Runs that could be judged as a syllable (core, or
  // over the floor and judgeMs long) in more than one stretch, or off on
  // their own: scattered.
  const strong = found.runs.filter((r) => r.strong);
  strong.forEach((r, k) => (r.stretch = k && r.from - strong[k - 1].to <= near ? strong[k - 1].stretch : k));
  const places = new Set();
  for (const r of found.runs) {
    if (!r.core && !(r.loud && r.to - r.from >= judge)) continue;
    const by = r.strong ? r : strong.find((k) => r.from - k.to <= near && k.from - r.to <= near);
    places.add(by ? by.stretch : `far ${r.from}`);
  }
  if (places.size > 1) return { doubt: "scattered" };
  const first = core[0].from;
  const last = core[core.length - 1].to;
  const doubted = found.runs.filter((r) => !r.core && ((r.loud && count > 1) || (r.to + near >= first && r.from - near <= last)));
  if (doubted.length > rules.maxDoubts) return { doubt: "trimmed" };
  const tracks = [];
  for (let pick = 0; pick < 1 << doubted.length; pick++) {
    const taken = new Set(doubted.filter((_, k) => pick & (1 << k)));
    tracks.push(cutToRuns(loose, found, (r) => r.core || taken.has(r), rules));
  }
  return { tracks };
}

/** Whether the track has a pitched background: a voiced stretch of
 *  stillMs or more, softer than sureDb throughout, whose pitch stays
 *  within stillSt semitones. */
function pitchedBackground(track, rules = TRIM_RULES) {
  const { rms, hopMs } = track;
  // Before the range gate, which would hide a hum far under the voice.
  const f0 = finishPitch(rawPitch(track), rms, null, false);
  let peak = 0;
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0 && rms[i] > peak) peak = rms[i];
  const soft = peak * 10 ** (rules.sureDb / 20);
  const need = Math.round(rules.stillMs / hopMs);
  let from = -1;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < f0.length; i++) {
    const st = f0[i] > 0 && rms[i] < soft ? hzToSt(f0[i]) : null;
    if (st !== null && from >= 0 && Math.max(hi, st) - Math.min(lo, st) <= rules.stillSt) {
      lo = Math.min(lo, st);
      hi = Math.max(hi, st);
      if (i - from + 1 >= need) return true;
    } else if (st !== null) {
      from = i;
      lo = hi = st;
    } else from = -1;
  }
  return false;
}

/* ------------------------------- segmentation ------------------------------ */

/**
 * Where each of `count` syllables is, when nobody supplied timings: the
 * speech span cut at the `count − 1` places that are quietest and least
 * voiced, without letting any piece get far from the average length. A
 * dynamic programme over the frames; the cost of a cut is how loud and
 * voiced that frame is, the cost of a piece is how far its length is from
 * the even share.
 *
 * Good enough for a word said on its own and for short careful phrases
 * (most Mandarin syllables start with a consonant, so there is a dip);
 * weak where syllables run together (我爱, 一月), which is why the scorer
 * trusts these cuts less than real timings (FALLBACK_TRUST).
 *
 * `anchorsMs`, when given, is one time per syllable that should fall
 * inside its piece (null for none): a piece that misses its anchor costs
 * more the further it misses. Scribe's character times are such points (see
 * scribeCharTimings): they say roughly where a character is, which keeps
 * the cuts honest across a pause or a run of vowels, but not where it
 * starts and ends.
 */
export function segmentSyllables(track, count, { fromMs = 0, toMs = Infinity, anchorsMs = null } = {}) {
  const { f0, rms, hopMs } = track;
  const n = f0.length;
  let lo = Math.max(0, Math.round(fromMs / hopMs));
  let hi = Math.min(n - 1, Math.round(toMs / hopMs));
  let peak = 0;
  for (let i = lo; i <= hi; i++) if (rms[i] > peak) peak = rms[i];
  const loud = (i) => rms[i] > peak * 0.08 || f0[i] > 0;
  while (lo < hi && !loud(lo)) lo++;
  while (hi > lo && !loud(hi)) hi--;
  if (count <= 0 || hi <= lo) return [];
  if (count === 1) return [{ startMs: lo * hopMs, endMs: (hi + 1) * hopMs }];

  const T = hi - lo + 1;
  const even = T / count;
  // Cut cost in [0, 1]: quiet and unvoiced frames are cheap.
  const cut = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const i = lo + t;
    const level = peak ? Math.min(1, rms[i] / peak) : 0;
    cut[t] = 0.6 * Math.sqrt(level) + (f0[i] > 0 ? 0.4 : 0);
  }
  const lenCost = (len) => ((len - even) / even) ** 2 * 0.5;
  // Piece k spans frames [p, t): how far (in 100 ms) its anchor lies outside.
  const anchors = Array.isArray(anchorsMs) && anchorsMs.length === count ? anchorsMs.map((a) => (Number.isFinite(a) ? a / hopMs - lo : null)) : null;
  const anchorCost = (k, p, t) => {
    const a = anchors?.[k - 1];
    if (a === null || a === undefined) return 0;
    const miss = a < p ? p - a : a >= t ? a - t + 1 : 0;
    return (miss * hopMs) / 100;
  };
  const minLen = Math.max(4, Math.floor(even * 0.35));
  // No piece longer than three even shares: such a piece already costs
  // more than any cut could save, and without the bound the search is
  // syllables × frames², over a second for 27 s and 60 syllables.
  const maxLen = Math.max(minLen + 1, Math.ceil(even * 3));
  // best[k][t]: cheapest way to end piece k at frame t (exclusive).
  const best = Array.from({ length: count + 1 }, () => new Float32Array(T + 1).fill(Infinity));
  const from = Array.from({ length: count + 1 }, () => new Int32Array(T + 1).fill(-1));
  best[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let t = k * minLen; t <= T; t++) {
      if (k === count && t !== T) continue;
      for (let p = Math.max((k - 1) * minLen, t - maxLen); p <= t - minLen; p++) {
        if (best[k - 1][p] === Infinity) continue;
        const c = best[k - 1][p] + lenCost(t - p) + (t < T ? cut[t] : 0) + anchorCost(k, p, t);
        if (c < best[k][t]) {
          best[k][t] = c;
          from[k][t] = p;
        }
      }
    }
  }
  if (best[count][T] === Infinity) {
    // Too short to cut by the rules: even shares.
    return Array.from({ length: count }, (_, k) => ({ startMs: (lo + k * even) * hopMs, endMs: (lo + (k + 1) * even) * hopMs }));
  }
  const bounds = [T];
  for (let k = count, t = T; k > 0; k--) {
    t = from[k][t];
    bounds.unshift(t);
  }
  return Array.from({ length: count }, (_, k) => ({ startMs: (lo + bounds[k]) * hopMs, endMs: (lo + bounds[k + 1]) * hopMs }));
}

/** Per-character times from a Scribe reply, for the characters that are
 *  Chinese: `[{ char, startMs, endMs }]`. Scribe returns `words[]` with
 *  `start`/`end` in seconds and, when asked with
 *  `timestamps_granularity=character`, a `characters[]` inside each
 *  (https://elevenlabs.io/docs/api-reference/speech-to-text/convert). A
 *  word of several characters without `characters` is cut into even shares.
 *  The app's `transcriptText` keeps only `text` today; a later stage keeps
 *  this too.
 *
 *  Measured on synthesized clips (docs/pronunciation-proof.md): for Chinese
 *  Scribe v2 gives one `words` entry per character, but the times are where
 *  the recognizer emitted the character, not the syllable's extent: 你好
 *  came back as 你 140–260 ms and 好 460–480 ms in a clip where 好 sounds
 *  from 270 to 510. So they are passed to `scoreTones` as `anchors` (a
 *  point inside each syllable), never as `timings`. */
export function scribeCharTimings(json) {
  const out = [];
  for (const w of Array.isArray(json?.words) ? json.words : []) {
    if (!w || w.type === "spacing" || w.type === "audio_event") continue;
    const chars = Array.isArray(w.characters) ? w.characters.filter((c) => c && typeof c.text === "string") : [];
    if (chars.length && chars.every((c) => Number.isFinite(c.start) && Number.isFinite(c.end))) {
      for (const c of chars) for (const ch of [...c.text]) if (HAN.test(ch)) out.push({ char: ch, startMs: c.start * 1000, endMs: c.end * 1000 });
      continue;
    }
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const cps = [...String(w.text ?? "")];
    const share = ((w.end - w.start) * 1000) / (cps.length || 1);
    cps.forEach((ch, i) => {
      if (HAN.test(ch)) out.push({ char: ch, startMs: w.start * 1000 + i * share, endMs: w.start * 1000 + (i + 1) * share });
    });
  }
  return out;
}

/** Timings for `syllables` out of timed characters (Scribe's, Azure's):
 *  matched in order by character, so a transcript with an extra or a
 *  missing word still times the rest. A syllable nobody timed gets null.
 *  A traditional character matches its simplified twin only if the caller
 *  normalised both; the transcript and the expected text are usually the
 *  same string. */
export function alignTimings(syllables, timed) {
  const out = syllables.map(() => null);
  let from = 0;
  for (let i = 0; i < syllables.length; i++) {
    // Look a little ahead only: a far match is more likely another word.
    for (let j = from; j < Math.min(timed.length, from + 4); j++) {
      if (timed[j].char === syllables[i].char) {
        out[i] = { startMs: timed[j].startMs, endMs: timed[j].endMs };
        from = j + 1;
        break;
      }
    }
  }
  return out;
}

/* ------------------------------- classification ---------------------------- */

/** The contours, on Chao's five-level scale (1 the bottom of the speaker's
 *  range, 5 the top), at five evenly spaced points of the syllable's voiced
 *  part. Several per tone: what a tone looks like alone and what it looks
 *  like in a sentence differ more than tone 2 and tone 3 do on paper. */
const TEMPLATES = [
  { tone: 1, levels: [5, 5, 5, 5, 5] },
  { tone: 1, levels: [4.4, 4.5, 4.5, 4.5, 4.4] },
  { tone: 2, levels: [3, 3, 3.5, 4.2, 5] },
  { tone: 2, levels: [2.6, 2.5, 2.9, 3.6, 4.4] },
  // The full third (214), the half third (21) and the sentence-final low
  // fall with a small or no rise.
  { tone: 3, levels: [2.2, 1.4, 1, 1.5, 3] },
  { tone: 3, levels: [2.4, 1.8, 1.3, 1.1, 1] },
  { tone: 3, levels: [2, 1.4, 1, 1, 1.6] },
  { tone: 4, levels: [5, 4.6, 3.7, 2.4, 1.2] },
  { tone: 4, levels: [4.6, 4.2, 3.5, 2.8, 2.2] },
];
const POINTS = 5;

/** Tunables, exported so the proof report prints the values it ran with. */
export const TONE_RULES = Object.freeze({
  // Width of one Chao step in semitones when the speaker's range is
  // unknown: a 10-semitone range.
  stepSt: 2.5,
  // A speaker's measured range is trusted between these (semitones).
  minRangeSt: 7,
  maxRangeSt: 12,
  // How forgiving the match is (semitones RMS).
  sigmaSt: 1,
  // Weight of pitch height against pitch shape, when the range is known.
  levelWeight: 0.3,
  // Voiced frames needed to say anything (× HOP_MS).
  minFrames: 6,
  // "ok" when the accepted tones hold at least this much of the belief.
  okBelief: 0.34,
  // "off" is decided by what the contour rules out (rulesOut), not by the
  // belief: a level tone is ruled out by this much movement (semitones)…
  moveSt: 3,
  // …a rising tone by never climbing more than this, a falling tone by
  // never dropping more than this…
  stillSt: 1,
  // …and, for those two, only when the contour is clearly doing something
  // else: level within `flatSt`, or moving the other way by `moveSt`.
  flatSt: 1.5,
  // In a voice whose range is known, heights count too (the Chao scale):
  // a third tone is ruled out by a level pitch this high…
  highLevel: 3.8,
  // …or by a fall that starts this high (a fourth tone's start; the half
  // third starts in the middle)…
  highStart: 3.7,
  // …and a first tone by a level pitch this low, or by a pitch of any
  // shape that never gets above this.
  lowLevel: 2.2,
  lowTop: 2.2,
  // A third tone is also ruled out by a plain rise: one whose dip before
  // the bottom is at most this share of the climb after it, starting at
  // least this high in a known range.
  dipShare: 0.25,
  riseStart: 2.5,
  // From this syllable of a phrase on (0 is the first), a low pitch rules
  // nothing out: sentences drift down.
  lateFrom: 2,
  // Whether the semitone bars above scale with a known range.
  scaleRange: true,
  // A second tone is ruled out by a deep dip whose final rise is under
  // this share of the dip (a third tone that barely comes back up).
  riseShare: 0.5,
  // The evidence must clear its bar by this many semitones (0: just clear
  // it), the measurement must be this clean, and the voiced stretch this
  // long (ms).
  offMarginSt: 0,
  offQuality: 0.75,
  offMinMs: 80,
  // In connected speech (more than one syllable) the neighbours pull at
  // each tone and the cuts between them are never exact, whoever made
  // them: a flag there asks for this much more margin. Every false alarm
  // on phrases in the proof, on the scorer's own cuts and on Azure's, sat
  // under it. Kept apart from `quality`, which is only how clean the
  // measurement is.
  phraseMarginSt: 0.5,
  // A syllable with creak in it is flagged at all only when this is true,
  // and then on its voiced frames alone, its quality counted without the
  // penalty for the gap and times `creakTrust`.
  creakFlags: false,
  creakTrust: 0.85,
  // A silence this long between two voiced parts of one syllable's span:
  // two sounds, not one syllable (reason "apart").
  apartMs: 50,
  // A syllable whose loudest frame is under this share of the loudest
  // syllable's (−20 dB) is not judged (reason "soft").
  softShare: 0.1,
  // A syllable whose span begins with the recording (under `clippedMs`
  // in: the first two frames, which are the ones looked at)
  // while the recording's first 20 ms are already this share of the
  // syllable's loudest frame: the recording started inside the syllable,
  // and the start of its contour is missing (reason "clipped").
  clippedMs: 20,
  clippedShare: 0.15,
});

/** Confidence multiplier for cuts made by `segmentSyllables` rather than by
 *  real timings: its boundaries can sit a few frames inside a neighbour.
 *  It scales the reported confidence only; what a flag needs is
 *  `offMarginSt`, plus `phraseMarginSt` in connected speech. */
export const FALLBACK_TRUST = 0.85;

/** The voiced frames of [startMs, endMs) as `{ i, st }` (frame index, pitch
 *  in semitones), with what the classifier needs to know about how clean
 *  they are. */
// Voiced sound and creak change sign a few hundred times a second; the hiss
// of a fricative, thousands. As a share of samples at 16 kHz.
const CREAK_MAX_ZCR = 0.12;
// Further than this between frames 10 or 20 ms apart is not a voice moving:
// the steepest fourth tone in the proof clips moves under 3 semitones a
// frame. Seven is also where trackPitch cuts a run when it looks for octave
// slips.
const JUMP_ST = 7;
// A stretch this short between such jumps (frames) is a glitch, not part
// of the contour.
const GLITCH_FRAMES = 3;
// What a creaky syllable's "ok" counts for. Like TRIM_RULES, set on the
// real clips of one speaker; the synthesized voices barely creak, so the
// proof cannot measure it. A creaky ok is also marked (`creaky`) and left
// out of `overall`.
const CREAKY_OK_TRUST = 0.5;

function contourOf(track, startMs, endMs) {
  const { f0, rms, periodicity, hopMs } = track;
  const a = Math.max(0, Math.round(startMs / hopMs));
  const b = Math.min(f0.length, Math.round(endMs / hopMs));
  let first = -1;
  let last = -1;
  for (let i = a; i < b; i++) {
    if (f0[i] > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { points: [], voicedMs: 0, gaps: 0, creak: 0, jumps: 0, mended: 0, quietMs: 0, peak: 0, periodicity: 0 };
  let peak = 0;
  for (let i = a; i < b; i++) if (rms[i] > peak) peak = rms[i];
  const points = [];
  let gaps = 0;
  let creak = 0;
  let per = 0;
  // Loud frames with no period before the first voiced one, unless they
  // hiss (the s or sh of the syllable itself): creak at the very start, or
  // a consonant's burst. Either way the start of the contour is hidden, and
  // with it the fall a third tone begins with. Not counted as creak (most
  // are consonants); the plain-rise rule is what must not trust them.
  let lead = 0;
  // Places where the pitch moves further between neighbouring frames than
  // a voice can in 10 ms (JUMP_ST): the tracker has slipped an octave, as
  // it does on a low voice near creak. The per-run correction in
  // trackPitch only mends slips of 80 ms or less, and not at the edge of a
  // run or far from the run's longest piece.
  let jumps = 0;
  // Glitches taken out of the middle of the contour (not its edges).
  let mended = 0;
  // The longest stretch between voiced frames that is unvoiced and quiet:
  // not creak (that is loud) but a silence, with voice on both sides of it.
  let quiet = 0;
  let quietNow = 0;
  if (track.zcr) for (let i = a; i < first; i++) if (rms[i] > peak * 0.15 && track.zcr[i] < CREAK_MAX_ZCR) lead++;
  for (let i = first; i <= last; i++) {
    if (f0[i] > 0) {
      const st = hzToSt(f0[i]);
      const prev = points[points.length - 1];
      if (prev && i - prev.i <= 2 && Math.abs(st - prev.st) >= JUMP_ST) jumps++;
      points.push({ i, st });
      per += periodicity[i];
      quietNow = 0;
    } else {
      gaps++;
      // Loud but with no clear period, in the middle of the vowel: creak
      // (vocal fry), where a third tone bottoms out.
      if (rms[i] > peak * 0.15) {
        creak++;
        quietNow = 0;
      } else if (++quietNow > quiet) quiet = quietNow;
    }
  }
  // Most such jumps are a frame or three at the edge of a voiced run: the
  // tracker's glitch where the voice starts or stops, or the neighbouring
  // syllable's pitch where two meet without a gap (a child's fourth tone
  // starts an octave above the end of the one before). The contour is cut
  // at the jumps, a piece of GLITCH_FRAMES or fewer is dropped, and only a
  // jump between two pieces that both stay is a slip the syllable can't be
  // read through: a sustained one.
  if (jumps) {
    const pieces = [[points[0]]];
    for (let k = 1; k < points.length; k++) {
      const p = points[k];
      const q = points[k - 1];
      if (p.i - q.i <= 2 && Math.abs(p.st - q.st) >= JUMP_ST) pieces.push([p]);
      else pieces[pieces.length - 1].push(p);
    }
    const kept = pieces.filter((piece) => piece.length > GLITCH_FRAMES);
    // No piece longer than a glitch, or a third of the contour and more
    // in glitches: the track flips every few frames (period doubling in
    // creak) and what is left is too little to read through. The count
    // stands.
    const stay = kept.reduce((sum, piece) => sum + piece.length, 0);
    if (kept.length && (points.length - stay) * 2 <= stay) {
      if (kept.length < pieces.length) {
        points.length = 0;
        points.push(...kept.flat());
        per = 0;
        for (const p of points) per += periodicity[p.i];
      }
      // What counts is a jump between pieces that stay: with a glitch in
      // the middle of a vowel taken out, the vowel carries on where it was.
      jumps = 0;
      for (let k = 1; k < kept.length; k++) if (Math.abs(kept[k][0].st - kept[k - 1][kept[k - 1].length - 1].st) >= JUMP_ST) jumps++;
      const firstKept = pieces.indexOf(kept[0]);
      const lastKept = pieces.indexOf(kept[kept.length - 1]);
      for (let k = firstKept + 1; k < lastKept; k++) if (pieces[k].length <= GLITCH_FRAMES) mended++;
    }
  }
  return { points, voicedMs: points.length * hopMs, spanFrames: points[points.length - 1].i - points[0].i + 1, gaps, creak, lead, jumps, mended, quietMs: quiet * hopMs, peak, periodicity: per / points.length };
}

/** Five evenly spaced medians over the voiced points, the onset trimmed:
 *  the first frames after a consonant carry its pitch perturbation and the
 *  tail of the tone before. */
function fivePoints(points) {
  const skip = points.length >= 10 ? Math.floor(points.length * 0.12) : 0;
  const tail = points.length >= 14 ? Math.floor(points.length * 0.05) : 0;
  const use = points.slice(skip, points.length - tail);
  const out = [];
  for (let k = 0; k < POINTS; k++) {
    const from = Math.floor((k * use.length) / POINTS);
    const to = Math.max(from + 1, Math.floor(((k + 1) * use.length) / POINTS));
    out.push(median(use.slice(from, to).map((p) => p.st)));
  }
  return out;
}

/**
 * One syllable's contour → a belief over the four tones.
 *
 * `points` are five pitches in semitones (absolute, 12·log2 Hz). `range`,
 * when the speaker's is known, is `{ lowSt, highSt }`; then the height of
 * the contour counts as well as its shape (a level high pitch is tone 1, a
 * level low one a half third). Without it only the shape counts, and a
 * level contour stays ambiguous between those two, which is honest.
 *
 * Returns `{ belief: {1,2,3,4}, tone, levels }` where `levels` is the
 * contour on the Chao scale (null without a range).
 */
export function classifyContour(points, range = null, rules = TONE_RULES) {
  const span = range ? Math.max(rules.minRangeSt, Math.min(rules.maxRangeSt, range.highSt - range.lowSt)) : rules.stepSt * 4;
  const step = span / 4;
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  // The middle of the range sits at Chao 3.
  const mid = range ? (range.lowSt + range.highSt) / 2 : null;
  const scores = { 1: -Infinity, 2: -Infinity, 3: -Infinity, 4: -Infinity };
  for (const t of TEMPLATES) {
    const tMean = t.levels.reduce((a, b) => a + b, 0) / POINTS;
    // With no range the size of a Chao step is a guess, and a narrow voice
    // would read flat against it: let each template stretch or shrink to
    // the contour, within reason.
    let gain = 1;
    if (!range) {
      let pt = 0;
      let tt = 0;
      for (let k = 0; k < POINTS; k++) {
        const tk = (t.levels[k] - tMean) * step;
        pt += (points[k] - mean) * tk;
        tt += tk * tk;
      }
      if (tt > 1) gain = Math.max(0.5, Math.min(1.5, pt / tt));
    }
    let shape = 0;
    for (let k = 0; k < POINTS; k++) shape += (points[k] - mean - (t.levels[k] - tMean) * step * gain) ** 2;
    shape /= POINTS;
    const level = mid === null ? 0 : (mean - (mid + (tMean - 3) * step)) ** 2;
    const score = -(shape + rules.levelWeight * level) / (2 * rules.sigmaSt ** 2);
    if (score > scores[t.tone]) scores[t.tone] = score;
  }
  const top = Math.max(...Object.values(scores));
  let sum = 0;
  const belief = {};
  for (const tone of [1, 2, 3, 4]) sum += belief[tone] = Math.exp(scores[tone] - top);
  for (const tone of [1, 2, 3, 4]) belief[tone] /= sum;
  const tone = [1, 2, 3, 4].reduce((a, b) => (belief[b] > belief[a] ? b : a));
  return { belief, tone, levels: mid === null ? null : points.map((p) => 3 + (p - mid) / step), stepSt: step };
}

/** A pitch curve for drawing: `points` values across [startMs, endMs), in
 *  semitones above (+) or below (−) `refHz`, null where unvoiced. The same
 *  function draws the learner and the narrator, each against their own
 *  median, so a man's curve and a child's land on the same axis. */
export function pitchCurve(track, startMs, endMs, refHz, points = 16) {
  const { f0, hopMs } = track;
  const ref = hzToSt(refHz);
  const out = [];
  const a = startMs / hopMs;
  const width = (endMs - startMs) / hopMs / points;
  for (let k = 0; k < points; k++) {
    const from = Math.max(0, Math.round(a + k * width));
    const to = Math.min(f0.length, Math.max(from + 1, Math.round(a + (k + 1) * width)));
    const st = [];
    for (let i = from; i < to; i++) if (f0[i] > 0) st.push(hzToSt(f0[i]));
    out.push(st.length ? Math.round((median(st) - ref) * 10) / 10 : null);
  }
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** What per-syllable timings must look like to be used, and how they are
 *  used (scoreTones with `timings`). */
export const TIMING_RULES = Object.freeze({
  // A syllable's span: no shorter and no longer than this. Azure's spans
  // for the proof's clips run from 60 ms (a neutral 么) to 800 ms (a lone
  // syllable with the silence around it).
  minMs: 40,
  maxMs: 1500,
  // Spans come in order; neighbours may share this much, and a span may
  // pass the ends of the recording by as much.
  slackMs: 20,
  // A recogniser's spans are right to some tens of milliseconds at best,
  // and a verdict that turns on where exactly an edge was drawn is not a
  // measurement of the tone. So the syllables are read again with all the
  // spans moved this much earlier and later, and with each boundary
  // between two neighbours moved this much either way, and a verdict
  // stands only where every reading gives it, for the same tone (reason
  // "edges" otherwise). The proof's "When the spans are wrong" has what
  // that costs and what it stops.
  jitterMs: 40,
  // Spans that are not one syllable each ("lopsided"): of two neighbours
  // (no more than `neighbourMs` apart), one with hardly any voice in it, or
  // one under `sliverMs` beside one `lopsided` times its length. A
  // recogniser that drew one span over most of the next syllable leaves
  // exactly that; so does a clipped neutral syllable, which costs its
  // neighbour a verdict.
  //
  // IN-SAMPLE: `jitterMs`, `neighbourMs`, `sliverMs` and `lopsided` were
  // chosen while looking at the same synthesized clips and the same span
  // errors the proof's "When the spans are wrong" then measures them on
  // (a neighbour left 60 ms is exactly what `sliverMs` was set to catch).
  // Its off-design rows (a neighbour left 110, 130, 160 ms) are the
  // honest ones, and they are worse.
  neighbourMs: 100,
  sliverMs: 100,
  lopsided: 3,
});

/** `timings` moved about by `rules.jitterMs`: all of them earlier, all
 *  later, and each boundary between two timed neighbours earlier and
 *  later (the one's end and the other's start together). A span that the
 *  move would leave shorter than `minMs` (pushed against an end of the
 *  recording) stays where it was in that variant, so one short span
 *  doesn't take the reading away from the other syllables; a boundary
 *  move that would leave either neighbour too short is left out. For n
 *  syllables, at most 2n variants; a variant in which nothing moved is
 *  left out. scoreTones asks, per syllable, for at least one variant in
 *  which that syllable's own span moved. */
export function jitteredTimings(timings, totalMs, rules = TIMING_RULES) {
  const J = rules.jitterMs;
  const out = [];
  if (!(J > 0) || !Number.isFinite(totalMs)) return out;
  const fits = (t) => t.endMs - t.startMs >= rules.minMs;
  for (const d of [-J, J]) {
    let any = false;
    const moved = timings.map((t) => {
      if (!t) return t;
      const to = { ...t, startMs: Math.max(0, t.startMs + d), endMs: Math.min(totalMs, t.endMs + d) };
      if (!fits(to) || (to.startMs === t.startMs && to.endMs === t.endMs)) return t;
      any = true;
      return to;
    });
    if (any) out.push(moved);
  }
  for (let b = 0; b + 1 < timings.length; b++) {
    if (!timings[b] || !timings[b + 1]) continue;
    for (const d of [-J, J]) {
      const moved = timings.slice();
      moved[b] = { ...timings[b], endMs: timings[b].endMs + d };
      moved[b + 1] = { ...timings[b + 1], startMs: timings[b + 1].startMs + d };
      if (fits(moved[b]) && fits(moved[b + 1])) out.push(moved);
    }
  }
  return out;
}

/** Why `timings` can't be used for `n` syllables in a recording `totalMs`
 *  long, or null when they can. A null entry is a syllable nobody timed:
 *  allowed, and left unjudged. */
export function timingsProblem(timings, n, totalMs, rules = TIMING_RULES) {
  if (!Array.isArray(timings) || timings.length !== n) return `${Array.isArray(timings) ? timings.length : "no"} timings for ${n} syllables`;
  let prevEnd = -Infinity;
  for (const [i, t] of timings.entries()) {
    if (t === null || t === undefined) continue;
    if (!Number.isFinite(t.startMs) || !Number.isFinite(t.endMs)) return `syllable ${i + 1}: its times are not numbers`;
    const length = t.endMs - t.startMs;
    if (length < rules.minMs) return `syllable ${i + 1}: ${Math.round(length)} ms is too short to be a syllable`;
    if (length > rules.maxMs) return `syllable ${i + 1}: ${Math.round(length)} ms is too long to be a syllable`;
    if (t.startMs < -rules.slackMs || t.endMs > totalMs + rules.slackMs) return `syllable ${i + 1}: outside the recording`;
    if (t.startMs < prevEnd - rules.slackMs) return `syllable ${i + 1}: starts before the one before it ends`;
    prevEnd = t.endMs;
  }
  return null;
}

/** `track` with nothing left but the spans: pitch and loudness outside
 *  them are zero, and the pitch inside is finished again from the raw
 *  track on those frames alone (finishPitch), so the silence floor, the
 *  octave repairs and the range gate are set by the syllables and by
 *  nothing else in the recording. No margin is added: a frame's analysis
 *  window already reaches some 25 ms either side of it, and a margin's
 *  frames would have a say in the floor (a cough starting 20 ms after the
 *  last span once did). */
function focusTrack(track, spans) {
  const n = track.f0.length;
  const keep = new Uint8Array(n);
  for (const t of spans) keep.fill(1, Math.max(0, Math.floor(t.startMs / track.hopMs)), Math.min(n, Math.ceil(t.endMs / track.hopMs)));
  const raw = rawPitch(track);
  return {
    ...track,
    f0: finishPitch(raw, track.rms, keep),
    rawF0: Float32Array.from(raw, (v, i) => (keep[i] ? v : 0)),
    rms: Float32Array.from(track.rms, (v, i) => (keep[i] ? v : 0)),
  };
}

/** The syllables whose spans don't look like one syllable each next to
 *  their neighbours (indexes). */
function lopsidedSpans(timings, contours, toneRules, rules = TIMING_RULES) {
  const out = new Set();
  if (!(rules.lopsided > 0)) return out;
  const length = (t) => t.endMs - t.startMs;
  for (let i = 0; i + 1 < timings.length; i++) {
    const a = timings[i];
    const b = timings[i + 1];
    // Only neighbours in time: across a pause each span stands alone.
    if (!a || !b || b.startMs - a.endMs > rules.neighbourMs) continue;
    const short = length(a) < length(b) ? i : i + 1;
    const long = short === i ? i + 1 : i;
    // One of the two has next to no voice in its span: the syllable's
    // voice has to be somewhere, and the likeliest place is next door.
    if ((contours[short]?.points.length ?? 0) < toneRules.minFrames || (contours[long]?.points.length ?? 0) < toneRules.minFrames) {
      out.add((contours[short]?.points.length ?? 0) < toneRules.minFrames ? long : short);
      if ((contours[long]?.points.length ?? 0) < toneRules.minFrames) out.add(short);
    }
    // A sliver beside a span several times its length: one syllable has
    // most of the other's sound.
    if (length(timings[short]) < rules.sliverMs && length(timings[long]) >= rules.lopsided * length(timings[short])) {
      out.add(short);
      out.add(long);
    }
  }
  return out;
}

/** Every syllable unjudged, for one reason. */
const unjudged = (syllables, reason) => syllables.map((s) => ({
  char: s.char, pinyin: s.pinyin, baseTone: s.baseTone, expectedTone: s.expectedTone, accept: s.accept,
  heardTone: null, verdict: "unsure", confidence: 0, startMs: null, endMs: null, pitch: [], reason,
}));

/**
 * Score a recording's tones on this machine.
 *
 *   samples, sampleRate   mono PCM (parseWav)
 *   syllables             expectedSyllables(text, readings)
 *   timings               optional, one `{ startMs, endMs } | null` per
 *                         syllable, from a recogniser whose extents can be
 *                         trusted (Azure's per-syllable `Phonemes`); a null
 *                         is left unjudged, and one with `rough: true` (a
 *                         cut made by energy inside a recogniser's word)
 *                         counts for FALLBACK_TRUST
 *   track                 optional, a trackPitch() result already in hand
 *                         (with its `rawF0`; a copy is fine)
 *   anchors               optional, one time in ms (or null) per syllable
 *                         that lies inside it (Scribe's character starts,
 *                         through alignTimings): the segmenter cuts by
 *                         energy and keeps each piece on its anchor
 *   speaker               optional speakerRange() of this voice from
 *                         earlier recordings
 *   rules, timingRules    TONE_RULES and TIMING_RULES unless given (the
 *                         proof measures with a guard switched off)
 *
 * Two ways of knowing where the speech is, and they are not equals.
 *
 * **With `timings`** (the way to use this on a real microphone): pitch is
 * measured inside each syllable's span and nowhere else. The silence
 * floor, the octave repairs, the range gate and the recording's own range
 * (`speaker` in the result) are all taken from inside the spans, so
 * nothing outside the spans GIVEN can change a verdict: not a cough, a
 * knock, another voice or a hum in the lead-in. That is true by
 * construction, and it is only as good as the spans: whether a recogniser
 * draws the same spans on a noisy recording as on a clean one is a
 * separate question that nothing here answers (the proof says what was
 * and wasn't measured). So the spans are doubted too:
 *  - checked first (timingsProblem): the right number, in order, each a
 *    plausible length, inside the recording. If not, every syllable is
 *    "unsure", reason "timings", and `timingsProblem` says why: never a
 *    guess from energy;
 *  - a verdict stands only if it survives the spans moved by
 *    TIMING_RULES.jitterMs (jitteredTimings), reason "edges" otherwise;
 *  - neighbours whose spans can't both be one syllable are not judged
 *    (reason "lopsided": TIMING_RULES);
 *  - two voiced sounds with a silence between them in one span: "apart".
 * What these leave: spans wrong by more than the jitter in a way that
 * still looks like syllables (the proof's "When the spans are wrong").
 * The result's `readings` is how many times the syllables were read (one,
 * and one per moved set of spans).
 *
 * **Without** (the fallback): the speech is found by energy (speechOf),
 * which can't be done reliably, so every doubt ends in "unsure": with a
 * run that may or may not be speech the recording is read every way and a
 * verdict stands only where all readings give the same verdict and the
 * same tone (reason "trimmed" otherwise), and a recording whose speech
 * can't be placed at all is not judged (reason "scattered"). Either way,
 * a pitched background (a hum) leaves everything unjudged (reason
 * "background"). Then
 * the syllables are cut by energy (segmentSyllables), on `anchors` when
 * given.
 *
 * Verdicts: "ok" (an accepted tone fits), "off" (the contour rules out
 * every accepted tone, on a clean measurement: ruleMargins) or "unsure"
 * with a `reason`: "short", "unvoiced", "creaky", "neutral" (expected
 * neutral: not judged in v1), "untimed", "octave" (the pitch track jumps an
 * octave inside the syllable and stays there), "apart" (the syllable's
 * span holds two voiced sounds with a silence between them: a syllable is
 * one sound, so either the span is wrong or something else is in it),
 * "soft" (far softer than the loudest syllable), "timings", "edges",
 * "lopsided", "trimmed", "scattered", "background" (above), "track" (a
 * `track` without its raw pitch and no samples to track again), "unclear"
 * (nothing fits clearly). A creaky syllable can be "ok" when its voiced
 * part fits, never "off"; it carries `creaky: true`, and its ok is left
 * out of `overall`.
 * `confidence` is 0…1: how firmly the verdict stands, times how clean the
 * measurement was, times the trust in the cuts. Each judged syllable also
 * carries `margin` (semitones; 0 or more means every accepted tone is
 * ruled out), `quality` (the measurement alone) and `belief`.
 */
/** What the local scorer will take in one call. The same 30 seconds as
 *  Azure; 60 syllables is a long sentence at twice the speed of speech.
 *  That much takes about half a second (the proof's "Speed"): a route
 *  should still run it off the request thread. */
export const LOCAL_MAX_SECONDS = 30;
export const LOCAL_MAX_SYLLABLES = 60;

export function scoreTones({ samples, sampleRate, syllables, timings = null, anchors = null, speaker = null, track = null, rules = TONE_RULES, timingRules = TIMING_RULES }) {
  const n = syllables.length;
  // Refused before any work: all of it is synchronous.
  // The length comes from the samples when there are any, else from a
  // track that has its raw pitch (a track copied through JSON has arrays
  // with no length: it is not a track, and never a length of NaN that
  // every limit lets through).
  const usable = track && rawPitch(track) && track.hopMs > 0 ? track : null;
  const sampled = samples && Number.isFinite(samples.length) && sampleRate > 0 ? samples.length / sampleRate : NaN;
  const seconds = Number.isFinite(sampled) ? sampled : usable ? (usable.rawF0.length * usable.hopMs) / 1000 : NaN;
  if (seconds > LOCAL_MAX_SECONDS + 0.5) throw new Error(`the local scorer takes at most ${LOCAL_MAX_SECONDS} seconds of audio, got ${seconds.toFixed(1)}`);
  if (n > LOCAL_MAX_SYLLABLES) throw new Error(`the local scorer takes at most ${LOCAL_MAX_SYLLABLES} syllables, got ${n}`);
  // A track that lost its raw pitch on the way here (built by hand, or by
  // an older trackPitch) can't be read span by span: the recording is
  // tracked again, and without the samples nothing is judged. Never read
  // from `f0` as it stands: that pitch was finished on the whole recording,
  // and a voice in the lead-in would have had its say.
  const raw = usable ?? (Number.isFinite(sampled) ? trackPitch(samples, sampleRate) : null);
  const result = (out, more) => {
    // A creaky ok is half a measurement: it is shown, not counted.
    const judged = out.filter((s) => s.verdict !== "unsure" && !(s.creaky && s.verdict === "ok"));
    return { provider: "local", syllables: out, ...(judged.length ? { overall: Math.round((100 * judged.filter((s) => s.verdict === "ok").length) / judged.length) } : {}), ...more };
  };

  // A pitched background is under the syllables too, wherever it was
  // noticed: the one thing outside the timed spans that is looked at, and
  // it can only withhold verdicts.
  // Anything passed as timings is meant as timings: one that isn't a list
  // is a timings problem, not a quiet fall back to energy.
  const given = timings !== null && timings !== undefined;
  if (!raw) return result(unjudged(syllables, "track"), { speaker: null, timed: given ? "given" : "fallback" });
  if (pitchedBackground(raw)) return result(unjudged(syllables, "background"), { speaker: null, timed: given ? "given" : "fallback" });

  if (given) {
    const problem = timingsProblem(timings, n, seconds * 1000, timingRules);
    if (problem) return result(unjudged(syllables, "timings"), { speaker: null, timed: "given", timingsProblem: problem });
    // A span the caller marks `rough` (cut by energy inside a word the
    // recogniser timed as a whole: mergeAzure) counts for what a fallback
    // cut does.
    const trust = timings.map((t) => (t?.rough ? FALLBACK_TRUST : 1));
    const reading = (cuts) => readTones({ tr: focusTrack(raw, cuts.filter(Boolean)), syllables, cuts, trust, speaker, rules });
    const read = reading(timings);
    const lopsided = lopsidedSpans(timings, read.contours, rules, timingRules);
    // The same syllables with the spans' edges moved a little: a verdict
    // that doesn't survive that was resting on the edge (TIMING_RULES).
    const nudged = jitteredTimings(timings, seconds * 1000, timingRules);
    const others = nudged.map(reading);
    const out = read.syllables.map((s, i) => {
      if (s.verdict === "unsure") return s;
      if (lopsided.has(i)) return { ...s, verdict: "unsure", confidence: 0, reason: "lopsided" };
      // No reading in which this syllable's own span was moved (it is too
      // short to move, or fills the recording): nothing has tested its
      // edges, and agreement of no readings is not agreement.
      if (timingRules.jitterMs > 0 && !nudged.some((t) => t[i].startMs !== timings[i].startMs || t[i].endMs !== timings[i].endMs)) return { ...s, verdict: "unsure", confidence: 0, reason: "edges" };
      return others.every((o) => o.syllables[i].reason === "apart" || (o.syllables[i].verdict === s.verdict && o.syllables[i].heardTone === s.heardTone)) ? s : { ...s, verdict: "unsure", confidence: 0, reason: "edges" };
    });
    return result(out, { speaker: read.own, timed: "given", readings: 1 + others.length });
  }

  const anchored = Array.isArray(anchors) && anchors.length === n && anchors.some((a) => Number.isFinite(a));
  const timed = anchored ? "anchored" : "fallback";
  const speech = speechOf(raw, n);
  if (speech.doubt) return result(unjudged(syllables, speech.doubt), { speaker: null, timed });
  // One syllable needs no cutting: its piece is the whole of the speech.
  const reading = (tr) => readTones({ tr, syllables, cuts: segmentSyllables(tr, n, anchored ? { anchorsMs: anchors } : {}), trust: syllables.map(() => (n === 1 ? 1 : FALLBACK_TRUST)), speaker, rules });
  // A run that may or may not be speech: the recording is read every way
  // (speechOf), and a verdict stands only where all the readings give it,
  // for the same tone. A doubt can cost a verdict this way; it can never
  // make one.
  const [read, ...others] = speech.tracks.map(reading);
  const out = read.syllables.map((s, i) => (s.verdict === "unsure" || others.every((o) => o.syllables[i].verdict === s.verdict && o.syllables[i].heardTone === s.heardTone) ? s : { ...s, verdict: "unsure", confidence: 0, reason: "trimmed" }));
  return result(out, { speaker: read.own, timed });
}

/** One reading of a recording: every syllable's verdict on the track `tr`
 *  (already reduced to the speech, or to the timed spans) at `cuts`, one
 *  `{ startMs, endMs }` or null per syllable; `trust` is one number per
 *  syllable. Returns the verdicts, the track's own range and each
 *  syllable's contour. */
function readTones({ tr, syllables, cuts, trust, speaker, rules }) {
  const n = syllables.length;
  const own = speakerRange(tr);

  // The range to read heights against. A supplied one is the speaker's; the
  // recording's own is only a range once it holds enough different tones,
  // so it counts from four syllables up and for less than a supplied one.
  let range = null;
  let levelTrust = 0;
  if (speaker) {
    range = { lowSt: hzToSt(speaker.lowHz), highSt: hzToSt(speaker.highHz) };
    levelTrust = 1;
  } else if (own && n >= 4) {
    range = { lowSt: hzToSt(own.lowHz), highSt: hzToSt(own.highHz) };
    levelTrust = 0.5;
  }
  const refHz = speaker?.medianHz ?? own?.medianHz ?? 0;
  const useRules = levelTrust === 1 ? rules : { ...rules, levelWeight: rules.levelWeight * levelTrust };

  // How far into its phrase each syllable is (0 after a break).
  const place = [];
  syllables.forEach((s, i) => place.push(i === 0 || s.breakBefore ? 0 : place[i - 1] + 1));

  const contours = syllables.map((_, i) => (cuts[i] ? contourOf(tr, cuts[i].startMs, cuts[i].endMs) : null));
  const loudest = Math.max(0, ...contours.map((c) => c?.peak ?? 0));

  const out = syllables.map((s, i) => {
    const cut = cuts[i] ?? null;
    const base = {
      char: s.char,
      pinyin: s.pinyin,
      baseTone: s.baseTone,
      expectedTone: s.expectedTone,
      accept: s.accept,
      heardTone: null,
      verdict: "unsure",
      confidence: 0,
      startMs: cut ? Math.round(cut.startMs) : null,
      endMs: cut ? Math.round(cut.endMs) : null,
      pitch: cut && refHz ? pitchCurve(tr, cut.startMs, cut.endMs, refHz) : [],
    };
    if (!cut) return { ...base, reason: "untimed" };
    const c = contours[i];
    if (!c.points.length) return { ...base, reason: "unvoiced" };
    if (c.points.length < rules.minFrames) return { ...base, reason: "short" };
    const five = fivePoints(c.points);
    const { belief, tone: best, levels, stepSt } = classifyContour(five, range, useRules);
    // Height is used to rule a tone out only against a supplied range: a
    // recording's own range is too rough to hang a flag on.
    const margins = ruleMargins(five, levelTrust === 1 ? levels : null, rules, stepSt, { late: place[i] >= rules.lateFrom, hiddenOnset: c.lead >= 3 });
    // The tone heard is the best match among those the contour allows.
    const open = [1, 2, 3, 4].filter((t) => margins[t] < 0);
    const tone = open.length ? open.reduce((x, y) => (belief[y] > belief[x] ? y : x)) : best;
    // How clean: mostly voiced across its span, clearly periodic, and long
    // enough that five points mean something.
    const voicedShare = c.points.length / c.spanFrames;
    const clean = Math.min(1, c.periodicity / 0.85) * Math.min(1, c.voicedMs / 120);
    const creaky = c.creak >= 3 || voicedShare < 0.7;
    const quality = creaky ? clean * rules.creakTrust : clean * Math.min(1, voicedShare ** 2);
    const judgedTones = s.accept.filter((t) => t >= 1 && t <= 4);
    const accepted = judgedTones.reduce((sum, t) => sum + belief[t], 0);
    // How far the contour is from the nearest right answer: the smallest
    // margin among the accepted tones. At or past 0, all are ruled out.
    const margin = judgedTones.length ? Math.min(...judgedTones.map((t) => margins[t])) : -Infinity;
    const result = {
      ...base, heardTone: tone, belief: Object.fromEntries(Object.entries(belief).map(([k, v]) => [k, round3(v)])), quality: round3(quality),
      margin: Number.isFinite(margin) ? round3(margin) : null, voicedMs: c.voicedMs, ...(creaky ? { creaky: true } : {}),
    };

    // The neutral tone has no contour of its own: its pitch is set by the
    // tone before it. Not judged in v1.
    if (s.expectedTone === 0 && s.accept.length === 1) return { ...result, reason: "neutral" };
    // Two voiced sounds with a silence between them in one syllable's
    // span: a syllable is one sound (its consonant comes first, and creak
    // is loud), so the span is wrong or something else is in it (a knock
    // just after the last word, the end of the syllable before).
    if (c.quietMs >= rules.apartMs) return { ...result, reason: "apart" };
    // The recording was already loud when it began, and this syllable is
    // where it began: its onset was never recorded.
    if (cut.startMs < rules.clippedMs && Math.max(tr.rms[0] ?? 0, tr.rms[1] ?? 0) >= c.peak * rules.clippedShare) return { ...result, reason: "clipped" };
    // Far softer than the loudest syllable: its few frames over the
    // silence floor are not enough to say "ok" on, or "off".
    if (c.peak < loudest * rules.softShare) return { ...result, reason: "soft" };
    // The track jumps an octave inside the vowel and stays there: the
    // five points are partly the tracker's mistake, and nothing is read
    // off them. Before the creak rule below: a slipped stretch reads low,
    // which is just what that rule takes for a third tone.
    // The same when a glitch was taken out of the middle of a vowel that
    // is creaky as well: two signs at once that the tracker lost the
    // voice there, and too little left to say "ok" on.
    if (c.jumps || (c.mended && creaky)) return { ...result, reason: "octave" };
    // Creak in the middle of a vowel is what the bottom of a third tone
    // sounds like, so it supports an expected third tone (unless the voiced
    // part rules a third tone out).
    if (creaky && s.accept.includes(3) && margins[3] < 0) return { ...result, heardTone: 3, verdict: "ok", confidence: round3(CREAKY_OK_TRUST * quality * trust[i]) };
    // An accepted tone fits and nothing rules it out. Creak doesn't stand
    // in the way of that: a low voice creaks wherever a tone touches the
    // bottom of its range (the end of a fourth tone, the start of a
    // second), and the voiced part still shows the shape. It counts for
    // less, and creak can confirm but never flag (below).
    if (margin < 0 && (s.accept.includes(tone) || accepted >= rules.okBelief)) {
      return { ...result, verdict: "ok", confidence: round3((creaky ? CREAKY_OK_TRUST : Math.max(accepted, 0.5)) * quality * trust[i]) };
    }
    if (creaky && !rules.creakFlags) return { ...result, reason: "creaky" };
    // Off only when the contour rules out every tone that would be right,
    // by a clear margin, on a clean and long enough measurement.
    if (margin >= rules.offMarginSt + (n > 1 ? rules.phraseMarginSt : 0) && quality >= rules.offQuality && c.voicedMs >= rules.offMinMs) {
      return { ...result, verdict: "off", confidence: round3(quality * trust[i] * Math.min(1, 0.6 + 0.1 * margin)) };
    }
    return { ...result, reason: creaky ? "creaky" : "unclear" };
  });

  return { syllables: out, own, contours };
}

/**
 * How firmly a contour rules each tone out, in semitones past the bar:
 * `{ 0, 1, 2, 3, 4 }`, a tone ruled out at 0 or more, −Infinity where no
 * rule speaks. This, not the belief, is what a flag rests on, because the
 * belief always names a best match and a flag needs more than that: it
 * needs the right answer to be impossible. The number is the confidence of
 * the flag: `offMarginSt` asks for more of it.
 *
 * The features are of the shape (five medians across the voiced part):
 * the span, the biggest climb and drop, the dip before the lowest point and
 * the rise from it to the end. With the speaker's range known, heights
 * count as well (`levels`, the same contour on the Chao scale).
 *
 *  - Tone 1 is level and high: ruled out by a clear movement, by a level
 *    pitch low in the range, or by one that never leaves the lower half.
 *  - Tone 2 rises: ruled out when the pitch doesn't come up at the end and
 *    is plainly falling or level, or when it dips deep and comes back less
 *    than `riseShare` of the way.
 *  - Tone 4 falls: ruled out when the pitch doesn't come down at the end
 *    and is level or rising, or when it ends on a clear rise.
 *  - "Level" rules those two out anywhere when the range is unknown, but
 *    in a known range only high or low in it: a level pitch in the middle
 *    is a syllable squeezed flat by its neighbours, which any tone can be.
 *  - Tone 3 is low: ruled out by a high level pitch, by a fall that starts
 *    high in the range (a fourth tone; the half third starts in the
 *    middle), or by a plain rise with no dip before it that starts at
 *    mid-range or above (a second tone). All three need the range.
 *  - `late` (the syllable is well into its phrase) switches off every rule
 *    that rests on the pitch being low.
 *  - Not ruled out, so never flagged: a low fall said for a fourth tone, a
 *    dip that rises said for a second, a rise with a dip said for a third.
 *    Synthesized voices already disagree with each other on those.
 *  - The neutral tone is never ruled out.
 *
 * `five` is the contour in semitones; `levels` the same on the Chao scale,
 * or null when the speaker's range isn't known; `stepSt` one Chao step.
 */
export function ruleMargins(five, levels = null, rules = TONE_RULES, stepSt = rules.stepSt, { late = false, hiddenOnset = false } = {}) {
  let climb = 0;
  let drop = 0;
  let low = 0;
  for (let i = 0; i < five.length; i++) {
    if (five[i] < five[low]) low = i;
    for (let j = i + 1; j < five.length; j++) {
      climb = Math.max(climb, five[j] - five[i]);
      drop = Math.max(drop, five[i] - five[j]);
    }
  }
  const span = Math.max(...five) - Math.min(...five);
  // With `scaleRange`, the semitone bars stretch with a known range (they
  // are written for a ten-semitone voice).
  const k = levels && rules.scaleRange ? stepSt / rules.stepSt : 1;
  const moveSt = rules.moveSt * k;
  const stillSt = rules.stillSt * k;
  // How level it is (≥ 0: level), the dip before the lowest point, and the
  // rise from the lowest point to the end.
  const flat = rules.flatSt * k - span;
  const dip = Math.max(0, ...five.slice(0, low).map((v) => v - five[low]));
  const endRise = five[five.length - 1] - five[low];
  // …and the fall from the highest point to the end. "Never climbs" and
  // "never drops" are read off these two, not off the biggest climb or
  // drop anywhere: a second tone dips before it rises and a fourth tone
  // rises into its fall, and neither is the tone's direction.
  const endFall = Math.max(...five) - five[five.length - 1];
  const NO = -Infinity;
  const meanLevel = levels ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
  const startLevel = levels ? Math.max(levels[0], levels[1]) : null;
  // A level pitch is a first tone (high) or a half third (low). In the
  // middle of a known range it is a syllable squeezed flat by its
  // neighbours, which any tone can be: only high or low rules out a tone
  // that moves.
  // "Low" is read against the whole voice's range, and a sentence drifts
  // down as it goes (declination): by its third syllable a perfectly good
  // first tone can sit where the voice's low tones started. So late in a
  // phrase lowness rules nothing out.
  const lowOut = levels && !late;
  const levelOut = levels ? Math.min(flat, Math.max((meanLevel - rules.highLevel) * stepSt, lowOut ? (rules.lowLevel - meanLevel) * stepSt : NO)) : flat;
  // High and level is a first tone and nothing else, however the last
  // frames lean.
  const levelHigh = levels ? Math.min(flat, (meanLevel - rules.highLevel) * stepSt) : NO;
  return {
    0: NO,
    1: Math.max(
      span - moveSt,
      lowOut ? Math.min(flat, (rules.lowLevel - meanLevel) * stepSt) : NO,
      // Never out of the lower half of the range, level or not.
      lowOut ? (rules.lowTop - Math.max(...levels)) * stepSt : NO,
    ),
    2: Math.max(
      levelHigh,
      Math.min(stillSt - endRise, Math.max(levelOut, drop - moveSt)),
      // A deep dip that comes back less than part of the way: a third tone.
      Math.min(dip - moveSt, rules.riseShare * dip - endRise),
    ),
    3: Math.max(
      levelHigh,
      levels ? Math.min((startLevel - rules.highStart) * stepSt, drop - moveSt) : NO,
      // A plain rise is a second tone only if it starts where one does. A
      // third tone that starts at the floor and comes up has no fall to
      // show, so without a range to place the start, or with the start
      // hidden (`hiddenOnset`: creak or a burst before the first voiced
      // frame), the rule is silent.
      levels && !hiddenOnset ? Math.min(endRise - moveSt, rules.dipShare * endRise - dip, (levels[0] - rules.riseStart) * stepSt) : NO,
    ),
    4: Math.max(levelHigh, Math.min(stillSt - endFall, Math.max(levelOut, climb - moveSt)), endRise - moveSt),
  };
}

/** `ruleMargins` as yes or no: which tones the contour cannot be. */
export function rulesOut(five, levels = null, rules = TONE_RULES, stepSt = rules.stepSt) {
  const m = ruleMargins(five, levels, rules, stepSt);
  return Object.fromEntries(Object.entries(m).map(([tone, v]) => [tone, v >= 0]));
}

/**
 * The narrator's curves for the same text: one `pitch` array per syllable,
 * each against the narrator's own median, drawn beside the learner's by a
 * later stage. `samples` is the narrator's clip decoded to PCM (the server
 * will have to decode the cached MP3 first; this module only reads PCM).
 */
export function referenceCurves({ samples, sampleRate, count, timings = null, points = 16 }) {
  const tr = trackPitch(samples, sampleRate);
  const own = speakerRange(tr);
  const cuts = Array.isArray(timings) && timings.length === count && timings.every(Boolean) ? timings : segmentSyllables(tr, count);
  return cuts.map((c) => ({
    startMs: Math.round(c.startMs),
    endMs: Math.round(c.endMs),
    pitch: own ? pitchCurve(tr, c.startMs, c.endMs, own.medianHz, points) : [],
  }));
}

/* ----------------------------------- Azure --------------------------------- */

// Azure Speech Pronunciation Assessment over the speech-to-text REST API for
// short audio. Read 2026-11-18 from:
//   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
//   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
//   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=pronunciation-assessment
//   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/pronunciation-assessment-tool
//
// Built from those pages, then run live on 2026-11-18 (eastus, free F0
// tier, zh-CN, 316 requests over synthesized clips: the numbers are in
// docs/pronunciation-proof.md §Azure, live). What the docs say:
//  - Audio: WAV PCM 16 kHz mono (or OGG/Opus), which is exactly what the
//    browser records. At most 30 seconds with pronunciation assessment.
//  - Locales: zh-CN, zh-TW, zh-HK, es-MX and es-ES are all in the 33
//    supported for pronunciation assessment.
//  - The header is base64 of a JSON object: ReferenceText (required over
//    REST), GradingSystem, Granularity, Dimension, EnableMiscue,
//    EnableProsodyAssessment (prosody is en-US only), ScenarioId.
//  - Unscripted assessment (no reference text) is described for the Speech
//    SDK only; the REST table marks ReferenceText required, and the how-to
//    itself recommends transcribing first and then assessing scripted. So
//    for free speech the transcript is the reference text, with miscue off
//    (the transcript is what was said, so there is nothing to omit).
//  - Mandarin detail: "phoneme name" is supported for zh-CN in SAPI format;
//    syllable groups and spoken phonemes (NBestPhonemes: what was said
//    instead) are en-US only. No Chinese sample reply, no tone field.
//  - Offsets and durations are in 100-nanosecond units.
//  - The two pages disagree on where the scores sit: flat on the NBest
//    entry and the word (the REST page) or inside a `PronunciationAssessment`
//    object (the how-to). The parser reads both.
// What the live service does for zh-CN, which the docs don't say:
//  - The regional host below works with the key and region alone.
//  - Scores are flat (the REST page's layout).
//  - Words are Azure's own segmentation: 你好 and 学生 are one word each.
//  - `Phonemes` holds one entry per syllable, not per sound, named with the
//    tone as a digit ("ni 3", "hao 3"; 5 is neutral) and carrying its own
//    offset, duration and score. So Azure does give per-syllable cuts.
//  - That digit is the REFERENCE reading's dictionary tone (before sandhi;
//    for a character with several readings, one of them). It is not the
//    tone heard: the audio of 妈 assessed against 马 comes back as "ma 3"
//    with `DisplayText` "马。". Azure never says which tone was said.
//  - A wrong tone lowers the score (median 61 against 82 on single
//    syllables) and sometimes earns the word `Mispronunciation`, but the
//    ranges overlap widely: the counts are in the proof report.
//  - `Syllables` comes back with an empty `Syllable` and a `Grapheme`.
// Still unverified: zh-TW and Spanish replies, a recording near 30 s, a
// per-resource `endpoint`, and anything about a real learner's voice.

const AZURE_REGION_RE = /^[a-z0-9]+$/;
/** Whether `region` is one azurePronunciationRequest takes (a name like
 *  "eastus"): the compare route asks before counting Azure as set up. */
export function azureRegionValid(region) {
  return AZURE_REGION_RE.test(String(region ?? ""));
}

/** A locale as Azure names it (`zh-CN`, `es-MX`), from whatever the app
 *  holds, through the same parser as `scoresTones` (`parseLocale`), so the
 *  two cannot disagree: every locale `scoresTones` accepts maps to zh-TW
 *  (Taiwan, or Traditional script with no region) or zh-CN (the rest:
 *  Azure has no Mandarin model for Singapore or Malaysia). Chinese that
 *  isn't Mandarin (zh-HK) is refused, since this module's tone rules don't
 *  apply to it; any other language needs a region. Throws on anything
 *  else. */
export function azureLocale(locale) {
  const p = parseLocale(locale);
  if (!p) throw new Error(`not a locale: ${JSON.stringify(locale)}`);
  if (p.lang === "zh" || p.lang === "cmn") {
    if (!isMandarin(p)) throw new Error(`not a locale this module assesses (Mandarin only): ${JSON.stringify(locale)}`);
    return p.region === "TW" || (!p.region && p.script === "hant") ? "zh-TW" : "zh-CN";
  }
  if (!p.region) throw new Error(`not a locale Azure can assess: ${JSON.stringify(locale)}`);
  return `${p.lang}-${p.region}`;
}

/** Azure's limit for one assessed recording, and what 16 kHz 16-bit mono
 *  makes of it in bytes (plus the header). */
export const AZURE_MAX_SECONDS = 30;
export const AZURE_MAX_WAV_BYTES = 44 + AZURE_MAX_SECONDS * 16_000 * 2;

/** The `Pronunciation-Assessment` header value: base64 of the parameters
 *  as JSON. `scripted` is true when the learner was asked to say exactly
 *  `referenceText` (a drill, repeat-after-me): then words they skipped or
 *  added are reported (EnableMiscue). False when the reference is just the
 *  transcript of what they chose to say. */
export function azurePronunciationHeader({ referenceText, scripted = true }) {
  const params = {
    ReferenceText: String(referenceText ?? ""),
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    // The docs write the booleans as the strings "True" / "False".
    EnableMiscue: scripted ? "True" : "False",
  };
  return Buffer.from(JSON.stringify(params), "utf8").toString("base64");
}

/**
 * The request for one recording, in the shape of `azureTranscribeRequest`
 * in scripts/voice.mjs: `{ url, init }` for fetch.
 *
 * The docs' current endpoint is per resource
 * (`https://<resource>.cognitiveservices.azure.com/stt/speech/recognition/…`);
 * the app holds a key and a region, so this uses the regional host the same
 * API has long been served from, `<region>.stt.speech.microsoft.com`, which
 * takes `Ocp-Apim-Subscription-Key`. Pass `endpoint` (an https origin) to
 * use a resource's own host instead (that form has not been tried; the
 * regional one is verified live).
 */
export function azurePronunciationRequest({ key, region, endpoint = "", audio, locale, referenceText, scripted = true }) {
  const language = azureLocale(locale);
  if (!String(referenceText ?? "").trim()) throw new Error("Azure pronunciation assessment needs a reference text");
  // The request declares 16 kHz PCM and Azure assesses at most 30 seconds:
  // read both off the file rather than trust the caller.
  const wav = parseWav(audio);
  if (wav.sampleRate !== 16_000) throw new Error(`Azure pronunciation assessment needs 16 kHz audio, got ${wav.sampleRate} Hz`);
  if (wav.samples.length > AZURE_MAX_SECONDS * wav.sampleRate) throw new Error(`Azure pronunciation assessment takes at most ${AZURE_MAX_SECONDS} seconds, got ${(wav.samples.length / wav.sampleRate).toFixed(1)}`);
  let base;
  if (endpoint) {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") throw new Error("the Azure endpoint must be https");
    base = `${u.origin}/stt/speech/recognition/conversation/cognitiveservices/v1`;
  } else {
    if (!AZURE_REGION_RE.test(String(region ?? ""))) throw new Error(`AZURE_SPEECH_REGION must be a region name like "eastus", got ${JSON.stringify(region)}`);
    base = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
  }
  return {
    url: `${base}?language=${language}&format=detailed`,
    init: {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json",
        "Pronunciation-Assessment": azurePronunciationHeader({ referenceText, scripted }),
      },
      body: audio,
    },
  };
}

const TICKS_PER_MS = 10_000;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** A score that may sit on the object or inside its
 *  `PronunciationAssessment` (the two doc pages differ). */
function azureField(obj, name) {
  return obj?.PronunciationAssessment?.[name] ?? obj?.[name] ?? null;
}

/**
 * An Azure reply → `{ status, text, overall, accuracy, fluency,
 * completeness, words }`. `status` is the RecognitionStatus ("Success",
 * "NoMatch", "InitialSilenceTimeout", "BabbleTimeout", "Error"; the SDK's
 * JSON gives 0 for success). Each word: `{ text, startMs, endMs, score,
 * error, phonemes }` with `error` one of "None", "Omission", "Insertion",
 * "Mispronunciation" (an omitted word has no timing). A phoneme is
 * `{ name, score, startMs, endMs, tone }`; `tone` is a digit found at the
 * end of the phoneme's name, null otherwise. Live, a zh-CN "phoneme" is a
 * whole syllable and the digit is the reference reading's tone ("ma 3" for
 * 马 whatever was said): useful to line phonemes up with characters, never
 * as what was heard.
 */
export function azurePronunciationResult(json) {
  const raw = json?.RecognitionStatus;
  const status = raw === 0 ? "Success" : typeof raw === "string" ? raw : "Error";
  const best = Array.isArray(json?.NBest) ? json.NBest[0] : null;
  const time = (o) => {
    const off = num(o?.Offset);
    const dur = num(o?.Duration);
    return off === null || dur === null ? { startMs: null, endMs: null } : { startMs: off / TICKS_PER_MS, endMs: (off + dur) / TICKS_PER_MS };
  };
  const words = (Array.isArray(best?.Words) ? best.Words : [])
    .filter((w) => w && typeof w.Word === "string")
    .map((w) => ({
      text: w.Word,
      ...time(w),
      score: num(azureField(w, "AccuracyScore")),
      error: String(azureField(w, "ErrorType") ?? "None"),
      phonemes: (Array.isArray(w.Phonemes) ? w.Phonemes : []).map((p) => {
        const name = String(p?.Phoneme ?? "");
        const tone = name.match(/([0-5])\s*$/);
        return { name, score: num(azureField(p, "AccuracyScore")), ...time(p), tone: tone ? Number(tone[1]) % 5 : null };
      }),
    }));
  return {
    status,
    text: String(best?.Display ?? json?.DisplayText ?? ""),
    overall: num(azureField(best, "PronScore")),
    accuracy: num(azureField(best, "AccuracyScore")),
    fluency: num(azureField(best, "FluencyScore")),
    completeness: num(azureField(best, "CompletenessScore")),
    words,
  };
}

/** Azure's verdict threshold on its 0–100 syllable score: under it, on a
 *  word Azure marks `Mispronunciation`, the merged result flags the
 *  syllable. Set from the live run over synthesized clips; the counts at
 *  30, 40, 50 and 60 for right and wrong-tone syllables are printed in
 *  docs/pronunciation-proof.md §Azure, live. A flag has to be right, so
 *  the highest bar with no correctly said syllable under it. To be
 *  revisited with real recordings.
 *
 *  There is no "ok" threshold: a high Azure score does not make an unclear
 *  pitch reading right. In the live run that upgrade turned more
 *  wrong-tone syllables into "ok" than right ones (Azure scores the sounds,
 *  and a wrong tone often still scores above 80). */
export const AZURE_RULES = Object.freeze({ offBelow: 40 });

/**
 * Azure's reply and the local tone check, as one result.
 *
 * Azure times the words and scores how each sounded; the local scorer,
 * given those timings, says which tone it heard. Per syllable:
 *  - "off" when the local check is confident the tone is another (reason
 *    "tone"), or when Azure itself marks the word mispronounced with a low
 *    score (reason "sound": heardTone stays whatever the pitch showed);
 *  - "ok" when the local check accepts the tone and Azure doesn't object;
 *  - "unsure" otherwise (a high Azure score never settles an unclear
 *    pitch reading: wrong tones score high too), and for a word Azure says
 *    was left out (reason "omitted").
 * So adding Azure never removes a tone flag, and adds flags only where
 * Azure is explicit.
 *
 * `local` is `(timings) => scoreTones(...)`: the caller holds the audio.
 * A word of several characters with no per-syllable timing has one Azure
 * span: the fallback segmenter cuts inside that span and nowhere else
 * (`track`, a trackPitch result, is needed for that; without it, even
 * shares), and those cuts carry `rough: true` (FALLBACK_TRUST).
 */
export function mergeAzure({ azure, syllables, local, track = null }) {
  // Azure's words → one timed entry per Chinese character.
  const timed = [];
  for (const w of azure.words) {
    if (w.error === "Insertion") continue;
    const chars = [...w.text].filter((c) => HAN.test(c));
    if (!chars.length) continue;
    let cuts;
    // For zh-CN the live service returns one "phoneme" per syllable (你好 →
    // "ni 3", "hao 3"), each with its own timing and score: when the count
    // matches the characters, those are the syllables.
    const perChar = w.phonemes.length === chars.length && w.phonemes.every((ph) => ph.startMs !== null) ? w.phonemes : null;
    if (w.startMs === null) cuts = chars.map(() => null);
    else if (perChar) cuts = perChar.map((ph) => ({ startMs: ph.startMs, endMs: ph.endMs }));
    else if (chars.length === 1) cuts = [{ startMs: w.startMs, endMs: w.endMs }];
    else {
      // Azure timed the word, not its characters: the cuts inside it are
      // made by energy on the word's own span (pitch finished on that span
      // alone, like any timed span: nothing elsewhere in the recording has
      // a say in them), and they are marked `rough`, so scoreTones trusts
      // them as it does any fallback cut and not as Azure's.
      const inside = track && rawPitch(track) ? segmentSyllables(focusTrack(track, [w]), chars.length, { fromMs: w.startMs, toMs: w.endMs }) : [];
      const share = (w.endMs - w.startMs) / chars.length;
      cuts = (inside.length === chars.length ? inside : chars.map((_, i) => ({ startMs: w.startMs + i * share, endMs: w.startMs + (i + 1) * share }))).map((c) => ({ ...c, rough: true }));
    }
    chars.forEach((char, i) => timed.push({ char, word: w, cut: cuts[i], score: perChar?.[i].score ?? w.score }));
  }
  // Match in order, as alignTimings does.
  const match = syllables.map(() => null);
  let from = 0;
  for (let i = 0; i < syllables.length; i++) {
    for (let j = from; j < Math.min(timed.length, from + 4); j++) {
      if (timed[j].char === syllables[i].char) {
        match[i] = timed[j];
        from = j + 1;
        break;
      }
    }
  }
  const timings = match.map((m) => m?.cut ?? null);
  const scored = timings.some(Boolean) ? local(timings) : null;

  const out = syllables.map((s, i) => {
    const m = match[i];
    const mine = scored?.syllables[i] ?? {
      char: s.char, pinyin: s.pinyin, baseTone: s.baseTone, expectedTone: s.expectedTone, accept: s.accept,
      heardTone: null, verdict: "unsure", confidence: 0, startMs: null, endMs: null, pitch: [], reason: "untimed",
    };
    if (!m) return mine;
    const score = m.score;
    // Azure's own word-level verdict travels with the syllable, so a caller
    // can show or count it apart from the merged one.
    const withScore = { ...mine, ...(score === null ? {} : { score }), ...(m.word.error !== "None" ? { azureError: m.word.error } : {}) };
    if (m.word.error === "Omission") return { ...withScore, verdict: "unsure", confidence: 0, reason: "omitted" };
    if (mine.verdict === "off") return { ...withScore, reason: "tone" };
    if (m.word.error === "Mispronunciation" && score !== null && score < AZURE_RULES.offBelow) {
      return { ...withScore, verdict: "off", confidence: round3(1 - score / 100), reason: "sound" };
    }
    return withScore;
  });
  return {
    provider: "azure",
    syllables: out,
    ...(azure.overall !== null ? { overall: Math.round(azure.overall) } : {}),
    speaker: scored?.speaker ?? null,
    timed: "given",
  };
}
