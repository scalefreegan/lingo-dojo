// Word checks for languages beyond Mandarin (ld-ne0.16; docs/VOICE.md
// §Words and sounds beyond Mandarin): the pure half. A recording of a known
// phrase is assessed by Azure Pronunciation Assessment, and its reply is
// turned into one mark per word (ok / off / unsure). There is no local
// scorer for these languages: Mandarin's is a pitch reader for tones, and
// nothing on this Mac scores consonants and vowels. Without Azure, nothing
// is shown.
//
// Every bar here comes from the proof (docs/pronunciation-proof.md §Words
// and sounds beyond Mandarin, scripts/pronunciation-proof-words.mjs) and is
// only as good as it: synthesized voices, whole words swapped.
//
// Pure ESM with no server imports, so `node --test` covers it directly.

import { azurePronunciationResult } from "./pronunciation.mjs";

// Which locales and texts: one copy for the server and the page.
export { AZURE_ASSESSMENT_LOCALES, WORD_CHECK_LANGUAGES, WORD_MAX_UNSPACED, WORD_MAX_WORDS, checksWordsHere, readWordText, wordCheckLocale } from "../web/shared/word-check.ts";
import { unspacedLocale } from "../web/shared/word-check.ts";

/* ---------------------------------- rules ---------------------------------- */

/**
 * The bars, from the proof (docs/pronunciation-proof.md §Words and sounds
 * beyond Mandarin; 366 live replies over 13 locales, synthesized voices):
 *  - `off` when Azure says the word wasn't there as itself (`Omission`:
 *    with miscue on, a word said as another word comes back as the
 *    reference word omitted and the said one inserted; no correctly said
 *    word was ever omitted in the proof), or marks it `Mispronunciation`
 *    with a score under `offBelow`. A low score without Azure's own mark is
 *    never off.
 *  - `ok` when Azure marks no error and the score is `okFrom` or more.
 *  - `unsure` otherwise, which the page shows quietly; and, whatever its
 *    score, a word beside an inserted copy of itself (`insertionGuard`).
 * At these bars: no false alarm on 391 words of correctly read phrases,
 * 2 on 144 correct words beside a swapped one, 69 of 105 wrong words
 * caught. The bars were chosen on those same clips (in-sample): `offBelow`
 * sits just under a correctly read word that scored 31.
 * `weakSounds`: locales where an off word's weakest phonemes may be shown by
 * name. None: Azure names phonemes only for en-US (SAPI), and on ten
 * one-sound swaps its lowest phoneme sat on the changed sound four times.
 */
export const WORD_RULES = Object.freeze({
  offBelow: 30,
  okFrom: 85,
  omissionOff: true,
  insertionGuard: true,
  weakSounds: Object.freeze([]),
  weakBelow: 50,
  why: "A word Azure didn't hear as itself is off: with miscue detection on, a word said as another comes back as the reference word omitted (and the other inserted), and no correctly read word was omitted here. A low score without Azure's own `Mispronunciation` is never off. A word beside an inserted copy of itself (Azure heard it, then aligned it to an extra slot: \"m'appelle\" inserted, then \"m'appelle\" 26) is unsure whatever its score (`insertionGuard`). The bars were chosen on these same clips, so this is in-sample: `offBelow` sits just under the one correctly read word that scored lowest with a `Mispronunciation` (Luciana's pão, 31).",
  soundsNote: "**Sounds: not shown.** Azure names its phonemes only for `en-US` (SAPI names: `th`, `ae`, …); in every other locale measured the `Phoneme` field is empty, so a weak sound has a score and a time but no name. And the scores don't point reliably: on the ten one-sound swaps the lowest phoneme sat on the changed sound in four. So the app shows no weakest sound; tapping a word plays the learner's own take of that word (its span in the recording) and the model phrase instead.",
});

/* --------------------------------- marking --------------------------------- */

const isGap = (c) => /[\p{P}\s]/u.test(c);

/**
 * One character's matching keys, for matching only (what is shown is the
 * phrase as written). Both are case-folded as far as matching needs (ß and
 * ẞ are "ss", so Straße matches STRASSE) and drop Arabic tatweel.
 *  - `exact` keeps every mark: schön is not schon, si is not sí.
 *  - `bare` also drops the marks (accents, Arabic harakat and shadda).
 * Live, Azure echoes the reference as written, harakat, tatweel, ß,
 * apostrophes and hyphens included (docs/pronunciation-proof.md §What Azure
 * echoes), so the exact key places every word the proof sent. The bare key
 * is a fallback for an echo that drops marks, and only where dropping them
 * can't make two words one (`BARE_LANGUAGES`): Arabic's harakat and the
 * Latin scripts' accents. Never Hindi (का, की, के, को would all be क),
 * Japanese (が would be か), Korean or Russian (й would be и).
 */
const KEYS = {
  exact: (c) => c.replace(/ـ/g, "").toLowerCase().replace(/[ßẞ]/g, "ss"),
  bare: (c) => c.normalize("NFD").replace(/[\p{M}ـ]/gu, "").toLowerCase().replace(/[ßẞ]/g, "ss"),
};
const BARE_LANGUAGES = new Set(["ar", "es", "de", "fr", "it", "pt", "nl", "sv", "en"]);
/** A character that belongs to the letter before it. */
const TRAILS = /^[\p{M}ـ]$/u;

/** The phrase under one key, with, per key unit, its place in the text
 *  (`at`: the UTF-16 offset of the character it came from, `len` that
 *  character's length) and whether a word of the phrase starts there
 *  (`starts`: after a space or a punctuation mark, apostrophes and hyphens
 *  included, so j'ai's "ai" may stand alone when Azure splits it). */
function folded(text, key) {
  let s = "";
  const at = [];
  const len = [];
  const starts = new Set();
  let gap = true;
  let pos = 0;
  for (const c of text) {
    if (isGap(c)) gap = true;
    else {
      const k = key(c);
      if (k) {
        if (gap) starts.add(s.length);
        gap = false;
        for (let i = 0; i < k.length; i++) {
          s += k[i];
          at.push(pos);
          len.push(c.length);
        }
      }
    }
    pos += c.length;
  }
  return { s, at, len, starts };
}
const fold = (t, key) => [...String(t).normalize("NFC")].filter((c) => !isGap(c)).map(key).join("");

/**
 * Azure's reply (parsed by `azurePronunciationResult`) → the marks the page
 * shows: `{ words, overall }`. Each word is Azure's own (its segmentation:
 * Japanese is split into words by Azure, as Mandarin is), placed on the
 * phrase as it was written (`start`/`end`, UTF-16 offsets into `text`, so
 * punctuation and spaces between words stay as the phrase has them, and a
 * word's trailing marks (harakat, tanween, matras) stay with it) with
 * `{ text, verdict, reason?, score?, startMs, endMs, sounds? }`. Each word
 * takes the nearest place after the last one, by either key (exact wins a
 * tie). In a spaced script a word is placed only on whole words of the
 * phrase (an "a" is never put inside "la"); in Japanese anywhere. A word
 * Azure heard but the phrase doesn't have (`Insertion`) is not shown; a
 * word it can't place on the phrase is left out.
 */
export function wordMarks(azure, text, { locale, rules = WORD_RULES } = {}) {
  const src = String(text).normalize("NFC");
  const lang = String(locale ?? "").split("-")[0];
  const keys = BARE_LANGUAGES.has(lang) ? [KEYS.exact, KEYS.bare] : [KEYS.exact];
  const refs = keys.map((key) => folded(src, key));
  const anywhere = unspacedLocale(String(locale ?? ""));
  /** Where `f` sits in `ref` at or after the text offset `from`, on whole
   *  words where the script has them, as text offsets; null if nowhere. */
  const place = (ref, f, from) => {
    let i = ref.at.findIndex((p) => p >= from);
    if (i < 0) return null;
    i = ref.s.indexOf(f, i);
    const fits = (j) => anywhere || (ref.starts.has(j) && (j + f.length === ref.s.length || ref.starts.has(j + f.length)));
    while (i >= 0 && !fits(i)) i = ref.s.indexOf(f, i + 1);
    if (i < 0) return null;
    let end = ref.at[i + f.length - 1] + ref.len[i + f.length - 1];
    // The marks after the last letter are the word's (كَتَبَ's last fatha,
    // سَلامٌ's tanween, पानी's ी), whichever key found it.
    while (end < src.length && TRAILS.test(String.fromCodePoint(src.codePointAt(end)))) end += src.codePointAt(end) > 0xffff ? 2 : 1;
    return { start: ref.at[i], end };
  };
  let cursor = 0;
  const words = [];
  const all = azure?.words ?? [];
  for (const [k, w] of all.entries()) {
    if (w.error === "Insertion") continue;
    let found = null;
    // A word Azure sent with marks (schön) is that word, never a nearer
    // one without (schon): for it the bare key is only a last resort, when
    // the exact one finds nothing (marks written differently: شكراً
    // against شُكراً).
    const marked = fold(w.text, KEYS.exact) !== fold(w.text, KEYS.bare);
    keys.forEach((key, n) => {
      if (n > 0 && marked && found) return;
      const f = fold(w.text, key);
      const at = f ? place(refs[n], f, cursor) : null;
      if (at && (!found || at.start < found.start)) found = at;
    });
    if (!found) continue;
    const { start, end } = found;
    cursor = end;
    // Azure heard this very word as an extra one beside it: its alignment
    // put the said word in the wrong slot, and this one's score is about
    // the slot, not the word (the proof's "m'appelle" beside a wrong name).
    const same = (x) => fold(x.text, KEYS.exact) === fold(w.text, KEYS.exact);
    const echoed = rules.insertionGuard && [all[k - 1], all[k + 1]].some((x) => x?.error === "Insertion" && same(x));
    const mark = echoed ? { ...markOf(w, locale, rules), verdict: "unsure", reason: "unclear", why: undefined, sounds: undefined } : markOf(w, locale, rules);
    words.push({ ...mark, text: src.slice(start, end), start, end });
  }
  return { words, overall: Number.isFinite(azure?.overall) ? Math.round(azure.overall) : null };
}

function markOf(w, locale, rules) {
  const score = Number.isFinite(w.score) ? Math.round(w.score) : null;
  const span = { startMs: Number.isFinite(w.startMs) ? w.startMs : null, endMs: Number.isFinite(w.endMs) ? w.endMs : null };
  const base = { score, azureError: w.error, ...span };
  // An omitted word has no score worth showing (Azure sends 0): it wasn't heard.
  if (w.error === "Omission") return rules.omissionOff ? { ...base, score: null, verdict: "off", why: "missing" } : { ...base, score: null, verdict: "unsure", reason: "unclear" };
  if (w.error === "Mispronunciation" && score !== null && score < rules.offBelow) {
    return { ...base, verdict: "off", why: "sound", ...weakest(w, locale, rules) };
  }
  if (w.error === "None" && score !== null && score >= rules.okFrom) return { ...base, verdict: "ok" };
  return { ...base, verdict: "unsure", reason: w.error === "None" || w.error === "Mispronunciation" ? "unclear" : "other" };
}

/** An off word's weakest named sound(s), where the locale names them. */
function weakest(w, locale, rules) {
  if (!rules.weakSounds.includes(locale)) return {};
  const named = (w.phonemes ?? []).filter((p) => p.name && Number.isFinite(p.score));
  const weak = named.filter((p) => p.score < rules.weakBelow).sort((a, b) => a.score - b.score).slice(0, 2);
  return weak.length ? { sounds: weak.map((p) => ({ name: p.name, score: Math.round(p.score) })) } : {};
}

/** Azure's answers for a take with no speech in it (documented; the probe
 *  never got one: Azure answered Success to silence and noise alike). */
const SILENT_STATUSES = new Set(["NoMatch", "InitialSilenceTimeout", "BabbleTimeout"]);

/** The loudest 50 ms of a quiet take: under this RMS (about -40 dBFS) it
 *  holds no speech. A voice near a laptop microphone is -30 to -15 dBFS at
 *  its loudest; a quiet room's hiss is under -50. */
export const QUIET_RMS = 0.01;

/** Whether the take is quiet throughout: its loudest 50 ms window is under
 *  `QUIET_RMS`. */
export function quietTake(samples, sampleRate) {
  const n = Math.max(1, Math.round(sampleRate * 0.05));
  let loudest = 0;
  for (let i = 0; i < samples.length; i += n) {
    let sum = 0;
    const end = Math.min(samples.length, i + n);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    loudest = Math.max(loudest, Math.sqrt(sum / Math.max(1, end - i)));
  }
  return loudest < QUIET_RMS;
}

/**
 * Whether the take had no speech to check: Azure says so in its status, or
 * it omitted every word, inserted none, recognised nothing (its text is
 * empty or only punctuation: live it is ".") and the take itself is quiet
 * (`quiet`, from `quietTake`). The last is needed because, live, Azure
 * answers a clearly spoken wrong word (hola assessed as gracias) exactly as
 * it answers silence or noise: Success, every word omitted, no insertion,
 * text "." (docs/pronunciation-proof.md §What Azure echoes). A loud take
 * Azure heard none of the words in is a normal reply, every word off
 * (missing): "wasn't heard as itself".
 */
export function azureHeardNothing(azure, { quiet = false } = {}) {
  if (!azure) return false;
  if (SILENT_STATUSES.has(azure.status)) return true;
  const words = azure.words ?? [];
  return (
    quiet &&
    azure.status === "Success" &&
    words.length > 0 &&
    words.every((w) => w.error === "Omission") &&
    !/[\p{L}\p{N}]/u.test(String(azure.text ?? ""))
  );
}

/** The parsed reply, re-exported so callers need one module. */
export const azureWords = azurePronunciationResult;

/**
 * The reply the page gets (wire.ts PronunciationWordsReply). Kids: each
 * word's place on the phrase only, no verdict, no score, no timing, and
 * `nudge` when something was clearly off (the page says "let's listen and
 * try again" without pointing at a word), the same gentleness as the tone
 * check's kids path. Azure's own error word stays on the server.
 */
export function wordsReply(marks, { kids, text, locale }) {
  const words = marks.words.map((w) =>
    kids
      ? { text: w.text, start: w.start, end: w.end }
      : {
          text: w.text, start: w.start, end: w.end, verdict: w.verdict,
          ...(w.why ? { why: w.why } : {}), ...(w.reason ? { reason: w.reason } : {}),
          score: w.score ?? null, startMs: w.startMs ?? null, endMs: w.endMs ?? null,
          ...(w.sounds?.length ? { sounds: w.sounds } : {}),
        },
  );
  return {
    kind: "words",
    engine: "azure",
    text,
    locale,
    words,
    overall: kids ? null : marks.overall,
    ...(kids ? { nudge: marks.words.some((w) => w.verdict === "off") } : {}),
  };
}
