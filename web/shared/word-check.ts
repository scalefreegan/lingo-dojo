// Which languages and phrases the word check takes (ld-ne0.16; docs/VOICE.md
// §Words and sounds beyond Mandarin). One copy for both sides: the server's
// rules (scripts/pronunciation-words.mjs re-exports these) and the page,
// which uses them only to skip a request the server would refuse. Pure and
// import-free so `node --test` runs it directly.

/** The locales Azure Pronunciation Assessment supports (Microsoft's
 *  language-support page, pronunciation assessment tab, read 2026-11-23),
 *  less Mandarin (zh-CN, zh-TW), which the tone checks own. */
export const AZURE_ASSESSMENT_LOCALES: readonly string[] = Object.freeze([
  "ar-EG", "ar-SA", "ca-ES", "da-DK", "de-DE", "en-AU", "en-CA", "en-GB", "en-IN", "en-US", "es-ES", "es-MX", "fi-FI", "fr-CA", "fr-FR",
  "hi-IN", "it-IT", "ja-JP", "ko-KR", "ms-MY", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ru-RU", "sv-SE", "ta-IN", "th-TH", "vi-VN", "zh-HK",
]);

/** The languages the proof measured (docs/pronunciation-proof.md §Words
 *  and sounds beyond Mandarin), by the language half of the locale: a
 *  variant Azure supports rides on its language's measurement (es-ES on
 *  es-MX's, fr-CA on fr-FR's). Every other supported locale (Cantonese,
 *  Polish, …) stays `not_available` until it is measured. */
export const WORD_CHECK_LANGUAGES: readonly string[] = Object.freeze(["es", "de", "fr", "ja", "it", "ko", "pt", "ru", "nl", "sv", "hi", "en", "ar"]);

const LOCALE_RE = /^([a-z]{2,3})-([A-Z]{2})$/;

/** The Azure locale a learner's locale is checked in, or null. Only an
 *  exact supported locale: Swiss German is not German German, nor
 *  Argentine Spanish Mexican, and Azure would hold the learner to the other
 *  accent. Mandarin is never here (tones: scoresTones). */
export function wordCheckLocale(locale: string | null | undefined): string | null {
  const m = LOCALE_RE.exec(String(locale ?? ""));
  if (!m || !AZURE_ASSESSMENT_LOCALES.includes(m[0])) return null;
  return WORD_CHECK_LANGUAGES.includes(m[1]) ? m[0] : null;
}

/** The script each language is written in: a phrase with letters of
 *  another (Latin in a Japanese phrase, a romanised Russian one) is refused,
 *  since Azure would assess them as the language's own words. */
const SCRIPTS: Record<string, RegExp> = {
  ja: /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々〆]$/u,
  ko: /^\p{Script=Hangul}$/u,
  ru: /^\p{Script=Cyrillic}$/u,
  hi: /^\p{Script=Devanagari}$/u,
  ar: /^\p{Script=Arabic}$/u,
};
const LATIN = /^\p{Script=Latin}$/u;
/** Languages written without spaces between words: counted in letters. */
const UNSPACED = new Set(["ja"]);

/** At most this many words in one check, or letters where words aren't
 *  spaced (Japanese): short phrases, what Practice and the bank hold and
 *  what the proof measured (one to five words). */
export const WORD_MAX_WORDS = 12;
export const WORD_MAX_UNSPACED = 30;
const WORD_MAX_LENGTH = 120;

/** The phrase to check, or why not: `{ text }` (NFC, trimmed) or
 *  `{ error }`. Letters of the language's script, combining marks, spaces
 *  and punctuation (apostrophes, hyphens, ¿…?); no digits (Azure reads "3"
 *  as it pleases) and no symbols or emoji. */
export function readWordText(raw: unknown, locale: string): { text: string; error?: undefined } | { error: string; text?: undefined } {
  const text = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!text) return { error: "say what the recording should be: text=<the phrase>" };
  const lang = locale.split("-")[0];
  const own = SCRIPTS[lang] ?? LATIN;
  const cps = [...text];
  let letters = 0;
  for (const c of cps) {
    if (/\p{L}/u.test(c)) {
      if (!own.test(c)) return { error: "the phrase has letters of another script" };
      letters++;
    } else if (!/[\p{M}\p{P}\s]/u.test(c)) return { error: "the phrase can hold only words and punctuation (no digits or symbols)" };
  }
  if (!letters) return { error: "the phrase has no words" };
  const spaced = !UNSPACED.has(lang);
  const count = spaced ? text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length : letters;
  if (cps.length > WORD_MAX_LENGTH || count > (spaced ? WORD_MAX_WORDS : WORD_MAX_UNSPACED)) {
    return { error: spaced ? `a phrase to check is at most ${WORD_MAX_WORDS} words` : `a phrase to check is at most ${WORD_MAX_UNSPACED} characters` };
  }
  return { text };
}

/** Whether the page should offer a word check: a measured locale and a
 *  phrase the route takes. The server also needs Azure's keys; without
 *  them it answers `not_available` and the page shows nothing. */
export function checksWordsHere(locale: string | null | undefined, text: string | null | undefined): boolean {
  const az = wordCheckLocale(locale);
  return !!az && readWordText(text, az).error === undefined;
}
