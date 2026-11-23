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
 *  - `exact` keeps every mark: schön is not schon.
 *  - `bare` also drops the marks (accents, Arabic harakat and shadda), so a
 *    phrase written with harakat matches Azure's bare word. Tried only
 *    where the exact key finds no place.
 */
const KEYS = {
  exact: (c) => c.replace(/ـ/g, "").toLowerCase().replace(/[ßẞ]/g, "ss"),
  bare: (c) => c.normalize("NFD").replace(/[\p{M}ـ]/gu, "").toLowerCase().replace(/[ßẞ]/g, "ss"),
};

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
 * punctuation and spaces between words stay as the phrase has them) with
 * `{ text, verdict, reason?, score?, startMs, endMs, sounds? }`. In a spaced
 * script a word is placed only on whole words of the phrase (an "a" is
 * never put inside "la"); in Japanese anywhere after the last one. A word
 * Azure heard but the phrase doesn't have (`Insertion`) is not shown; a
 * word it can't place on the phrase is left out.
 */
export function wordMarks(azure, text, { locale, rules = WORD_RULES } = {}) {
  const src = String(text).normalize("NFC");
  const refs = [folded(src, KEYS.exact), folded(src, KEYS.bare)];
  const anywhere = unspacedLocale(String(locale ?? ""));
  /** Where `f` sits in `ref` at or after the text offset `from`, on whole
   *  words where the script has them; -1 if nowhere. */
  const place = (ref, f, from) => {
    let i = ref.at.findIndex((p) => p >= from);
    if (i < 0) return -1;
    i = ref.s.indexOf(f, i);
    const fits = (j) => anywhere || (ref.starts.has(j) && (j + f.length === ref.s.length || ref.starts.has(j + f.length)));
    while (i >= 0 && !fits(i)) i = ref.s.indexOf(f, i + 1);
    return i;
  };
  let cursor = 0;
  const words = [];
  const all = azure?.words ?? [];
  for (const [k, w] of all.entries()) {
    if (w.error === "Insertion") continue;
    let found = null;
    for (const [n, key] of [KEYS.exact, KEYS.bare].entries()) {
      const f = fold(w.text, key);
      const i = f ? place(refs[n], f, cursor) : -1;
      if (i >= 0) {
        found = { start: refs[n].at[i], end: refs[n].at[i + f.length - 1] + refs[n].len[i + f.length - 1] };
        break;
      }
    }
    if (!found) continue;
    const { start, end } = found;
    cursor = end;
    // Azure heard this very word as an extra one beside it: its alignment
    // put the said word in the wrong slot, and this one's score is about
    // the slot, not the word (the proof's "m'appelle" beside a wrong name).
    const same = (x) => fold(x.text, KEYS.bare) === fold(w.text, KEYS.bare);
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

/** Azure's answers for a take with no speech in it. */
const SILENT_STATUSES = new Set(["NoMatch", "InitialSilenceTimeout", "BabbleTimeout"]);

/**
 * Whether Azure heard no speech in the take: a silent or noise-only
 * recording (its status says so, or, the check being scripted, it omitted
 * every word). Not an outage, and no marks: the learner is told to try
 * louder. Every word "off" here would blame the learner for the microphone.
 */
export function azureHeardNothing(azure) {
  if (!azure) return false;
  if (SILENT_STATUSES.has(azure.status)) return true;
  return azure.status === "Success" && azure.words.length > 0 && azure.words.every((w) => w.error === "Omission");
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
