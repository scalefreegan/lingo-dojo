// The phrase bank: the pure half (docs/DATA.md §Phrase bank, §Phrase
// capture, §Metrics). What a voice turn's glosses and a scenario's lists put
// into the bank, how a phrase's metrics are worked out from its cards and
// reviews, and how the bank view filters and sorts. No I/O and no clock
// reads (every function that needs the time takes `now`), so `node --test`
// pins it directly; scripts/db/phrases.ts does the writes.

import { BANDS, fromRow, phraseMastery } from "./fsrs.mjs";
import { normKey } from "./match.mjs";
import { languageOf, localeFor, replayReading } from "./voice.mjs";

/** The longest target form, meaning and note the bank keeps (a gloss term
 *  is already cut to 200, its meaning to 300, by the turn route). */
export const LIMITS = { text: 200, meaning: 300, note: 1000, sentence: 400 };
/** A phrase keeps at most this many example lines: enough to show it in
 *  use and to make cloze items from later, without one everyday word
 *  growing a row per turn for ever. */
export const MAX_EXAMPLES = 10;
/** "Trouble" (DATA.md §Metrics): lapses in the last 30 days. One lapse is
 *  ordinary forgetting; this many in a month is a phrase that keeps
 *  slipping. */
export const TROUBLE_LAPSES = 2;
export const TROUBLE_DAYS = 30;
/** More words than this and a gloss is a translation of a sentence, not a
 *  phrase to learn: the transcript shows it as a line's translation, not
 *  as a word (web/src/gloss.ts isSentence, the same count), and the turn
 *  doesn't put it in the bank. Starring it by hand still does. */
export const MAX_CAPTURE_WORDS = 3;
/** The same limit for a language written without spaces (Japanese,
 *  Chinese, Thai, …), in characters (letters and digits, punctuation not
 *  counted): a word segmenter splits their particles and endings off as
 *  words, so "いくらですか" would be three and "ありがとうございます" more. Twelve
 *  holds the everyday phrases of those languages (お願いします, 请再说一遍,
 *  ขอบคุณครับ) and stops at a clause. */
export const MAX_CAPTURE_CHARS = 12;
/** Languages written without spaces between words (ISO 639-1). */
const UNSPACED = new Set(["ja", "zh", "th", "lo", "km", "my", "bo"]);

/** A canonical uuid (8-4-4-4-12 hex): an id from a request that isn't one
 *  never reaches Postgres (whose uuid cast would fail as a 500). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

/** Control and invisible characters a phrase never needs: C0 (but tab and
 *  newline, which oneLine folds or a note keeps), DEL, NEL (U+0085, a line
 *  break to some readers), the zero-width space, word joiner and BOM, and
 *  the bidi marks, embeddings, overrides and isolates (U+200E, U+200F,
 *  U+061C, U+202A–U+202E, U+2066–U+2069), which can make text read
 *  differently from what it is. ZWNJ and ZWJ (U+200C, U+200D) stay: some
 *  scripts (Persian, Hindi, emoji sequences) spell with them. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
/** `s` as text a phrase may hold: the controls above removed. */
export const clean = (s) => String(s ?? "").replace(CONTROLS, "");
/** Lone UTF-16 surrogates (half an emoji, say): not text, and Postgres
 *  refuses them in jsonb. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Model- or learner-written text made safe to store or to put in a
 *  prompt: well-formed, with none of the characters `clean` drops. */
export const modelText = (v) => clean(String(v ?? "").replace(LONE_SURROGATES, ""));
const oneLine = (s) => clean(s).replace(/\s+/g, " ").trim();
/** A note: its own line breaks kept (CR LF as LF), other controls gone. */
const noteText = (s) => clean(String(s ?? "").replace(/\r\n?/g, "\n")).replace(/\r/g, "").trim();

/* --------------------------------- language -------------------------------- */

/** Words in `text`, by the language's own rules, so Chinese, Japanese and
 *  Thai (no spaces) count too. Falls back to spaces. */
export function wordCount(text, locale) {
  const s = String(text ?? "");
  try {
    let n = 0;
    for (const w of new Intl.Segmenter(locale || undefined, { granularity: "word" }).segment(s)) if (w.isWordLike) n++;
    return n;
  } catch {
    return s.trim() ? s.trim().split(/\s+/).length : 0;
  }
}

/** Whether `locale`'s language is written without spaces between words. */
export const unspaced = (locale) => {
  try {
    return UNSPACED.has(new Intl.Locale(String(locale)).language);
  } catch {
    return false;
  }
};

/** Letters and digits in `text` (graphemes, so a Thai vowel mark or an
 *  accent isn't a second character). */
export function charCount(text) {
  let n = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(text ?? ""))) if (/[\p{L}\p{N}]/u.test(segment)) n++;
  return n;
}

/** Too long to be a phrase the turn captures: more than MAX_CAPTURE_WORDS
 *  words, or MAX_CAPTURE_CHARS characters in a language without spaces. */
export const tooLongToCapture = (text, locale) => (unspaced(locale) ? charCount(text) > MAX_CAPTURE_CHARS : wordCount(text, locale) > MAX_CAPTURE_WORDS);

const langKey = (language, variant = "") => {
  const locale = localeFor(language, variant);
  return locale ? languageOf(locale) : String(language ?? "").trim().toLowerCase().replace(/\s+/g, " ");
};

/**
 * Whether a session in `session` (its target language and variant, as the
 * conversation saved them) practises the language of the profile whose bank
 * it would write to. A pack can override the target language: a German
 * scene played from the Spanish profile must not fill the Spanish bank with
 * German. Compared by ISO language where both are known (Mexican and
 * Castilian Spanish are one bank), else by name; a blank side (a profile
 * with no target language yet, a session that names none) can't disagree.
 */
export function sameLanguage(profileLanguage, session) {
  const p = String(profileLanguage ?? "").trim();
  const s = String(session?.language ?? "").trim();
  if (!p || !s) return true;
  return langKey(p) === langKey(s, session?.variant ?? "");
}

/** The session's target locale (es-MX), as the conversation saved it
 *  (`targetLanguage`, `targetVariant`), when it practises the language of
 *  the profile whose bank it would write to; null when a pack moved it to
 *  another (nothing goes into that bank then). "" for a language with no
 *  known locale. The turn's capture, the scene lists and the post-session
 *  extraction all ask this. */
export function bankLocale(profileLanguage, conv) {
  if (!sameLanguage(profileLanguage, { language: conv?.targetLanguage, variant: conv?.targetVariant })) return null;
  return localeFor(conv?.targetLanguage, conv?.targetVariant) ?? "";
}

/* --------------------------------- capture --------------------------------- */

/** A gloss term's letters, for finding the line it came from. */
const bare = (s) => oneLine(s).normalize("NFC").toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");

/** `s`'s words, lowercased, by the language's segmenter (spaces without one). */
function words(s, locale) {
  const t = oneLine(s).normalize("NFC").toLowerCase();
  try {
    return [...new Intl.Segmenter(locale || undefined, { granularity: "word" }).segment(t)].filter((w) => w.isWordLike).map((w) => w.segment);
  } catch {
    return t.split(/[\s\p{P}]+/u).filter(Boolean);
  }
}

/** Whether `sentence` has `term` in it as whole words ("mar" is not in "el
 *  mercado"). A language without spaces has no word edges to trust (its
 *  segmenter may cut the term differently inside a sentence), so there it is
 *  found as text. */
function holds(sentence, term, locale) {
  if (unspaced(locale)) return sentence.normalize("NFC").toLowerCase().includes(bare(term));
  const hay = words(sentence, locale);
  const needle = words(term, locale);
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true;
  return false;
}

/** The line of a reply that holds `term` as whole words: its
 *  target-language words (the line's text when it has no segments), and who
 *  said it. null when no line has it (a gloss of a word the reply only
 *  implied), or when the only such line is the term itself, which shows
 *  nothing of how it is used. */
export function exampleFor(term, lines, locale) {
  const needle = bare(term);
  if (!needle) return null;
  for (const l of lines ?? []) {
    const target = Array.isArray(l?.segments) && l.segments.length ? l.segments.filter((g) => g?.lang === "target").map((g) => g.text).join(" ") : l?.text;
    const sentence = oneLine(target);
    if (!sentence || bare(sentence) === needle || !holds(sentence, term, locale)) continue;
    return { sentence: sentence.slice(0, LIMITS.sentence), speaker: typeof l.speaker === "string" ? l.speaker : null };
  }
  return null;
}

/**
 * What a dojo-master reply's glosses put into the bank: one item per
 * distinct target form (its match key), with its meaning and the line that
 * holds it. Sentence-length glosses (tooLongToCapture: more than
 * MAX_CAPTURE_WORDS words, or MAX_CAPTURE_CHARS characters in a language
 * without spaces) are translations and left out. Sorted by key, so two writers that touch the
 * same phrases lock their rows in the same order and can't deadlock.
 */
export function glossCaptures(glosses, lines, locale) {
  const out = new Map();
  for (const g of glosses ?? []) {
    const text = oneLine(g?.term).slice(0, LIMITS.text);
    const norm = normKey(text);
    if (!norm || out.has(norm)) continue;
    if (tooLongToCapture(text, locale)) continue;
    const meaning = oneLine(g?.meaning).slice(0, LIMITS.meaning) || null;
    // A kept reading hint (ld-op2) goes with the phrase, only when the bank
    // keeps the term whole (the hint counts out to its characters).
    const reading = typeof g?.reading === "string" && text === oneLine(g.term) && replayReading(g.reading) ? g.reading : null;
    out.set(norm, { text, norm, meaning, meaningNorm: meaning ? normKey(meaning) || null : null, example: exampleFor(text, lines, locale), ...(reading ? { reading } : {}) });
  }
  return [...out.values()].sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
}

/**
 * A scenario's lists, as bank entries: `vocab` (target term and gloss)
 * complete, `phrases` (English meanings, no target words yet) pending. A
 * scenario written for another language (`language: es-MX` played in
 * German) adds no vocab: those words aren't this bank's. Each list deduped
 * by its key and sorted by it (the lock order, as glossCaptures).
 */
export function scenarioEntries(scenario, sessionLocale) {
  if (!scenario) return { complete: [], pending: [] };
  const own = !scenario.language || !sessionLocale || languageOf(scenario.language) === languageOf(sessionLocale);
  const complete = new Map();
  if (own) {
    for (const v of Array.isArray(scenario.vocab) ? scenario.vocab : []) {
      const text = oneLine(v?.term).slice(0, LIMITS.text);
      const norm = normKey(text);
      if (!norm || complete.has(norm)) continue;
      const meaning = oneLine(v?.gloss).slice(0, LIMITS.meaning) || null;
      complete.set(norm, { text, norm, meaning, meaningNorm: meaning ? normKey(meaning) || null : null });
    }
  }
  const pending = new Map();
  for (const p of Array.isArray(scenario.phrases) ? scenario.phrases : []) {
    const meaning = oneLine(p).slice(0, LIMITS.meaning);
    const meaningNorm = normKey(meaning);
    if (!meaningNorm || pending.has(meaningNorm)) continue;
    pending.set(meaningNorm, { meaning, meaningNorm });
  }
  const by = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
  return { complete: [...complete.values()].sort(by("norm")), pending: [...pending.values()].sort(by("meaningNorm")) };
}

/* ---------------------------------- input ---------------------------------- */

/** Why `input` can't be a phrase's text/meaning/note, or null. */
function badString(v, field, max, required) {
  if (v === undefined) return required ? `${field} is required` : null;
  if (v === null) return required ? `${field} is required` : null;
  if (typeof v !== "string") return `${field} must be a string`;
  if (v.includes("\u0000")) return `${field} can't contain a NUL character`;
  // Measured as it would be stored: one line, or a note's own lines.
  const stored = field === "note" ? noteText(v) : oneLine(v);
  if (required && !stored) return `${field} can't be blank`;
  if (stored.length > max) return `${field} is longer than ${max} characters`;
  return null;
}

/**
 * A phrase add (`create`) or edit body, checked and trimmed: `{ value }`,
 * or `{ error }` for a 400. text and meaning are one line; a note keeps its
 * line breaks. Control characters (C0 but newlines, bidi overrides) are
 * dropped from all three, and the lengths are those of what is stored. An edit takes any of text, meaning, note, starred,
 * suspended, alternates (the ones to keep) or removeAlternates (the ones to drop); null or "" clears meaning and note. Unknown keys are ignored.
 */
export function readPhraseInput(body, { create = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const value = {};
  const textError = badString(body.text, "text", LIMITS.text, create);
  if (textError) return { error: textError };
  if (body.text !== undefined) {
    if (body.text === null || !oneLine(body.text)) return { error: "a phrase needs its words: text can't be blank" };
    value.text = oneLine(body.text);
    if (!normKey(value.text)) return { error: "text needs at least one letter or digit" };
  }
  for (const [key, max] of [["meaning", LIMITS.meaning], ["note", LIMITS.note]]) {
    const err = badString(body[key], key, max, false);
    if (err) return { error: err };
    if (body[key] !== undefined) {
      const v = key === "note" ? noteText(body[key]) : oneLine(body[key]);
      value[key] = v || null;
    }
  }
  // The alternates the grader accepted, as the learner wants to keep them:
  // only removal is possible (the write keeps those already there).
  if (body.alternates !== undefined) {
    if (!Array.isArray(body.alternates) || body.alternates.length > 50 || body.alternates.some((a) => typeof a !== "string" || a.length > LIMITS.text)) {
      return { error: `alternates must be a list of the phrase's alternates (at most ${LIMITS.text} characters each)` };
    }
    value.alternates = body.alternates;
  }
  // Or only the ones to remove (the bank's ×): one the grader saved after
  // the learner's page loaded is kept, where a full list would drop it.
  if (body.removeAlternates !== undefined) {
    if (!Array.isArray(body.removeAlternates) || body.removeAlternates.length > 50 || body.removeAlternates.some((a) => typeof a !== "string" || a.length > LIMITS.text)) {
      return { error: `removeAlternates must be a list of alternates to remove (at most ${LIMITS.text} characters each)` };
    }
    value.removeAlternates = body.removeAlternates;
  }
  for (const key of ["starred", "suspended"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { error: `${key} must be true or false` };
    value[key] = body[key];
  }
  if (!create && !Object.keys(value).length) return { error: "nothing to change: send text, meaning, note, alternates, removeAlternates, starred or suspended" };
  return { value };
}

/* --------------------------------- metrics --------------------------------- */

const ms = (d) => (d == null ? null : new Date(d).getTime());
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/** A card never reviewed: FSRS state New (0), no reps. */
const unreviewed = (c) => c.state === 0 || !c.reps;

/**
 * One phrase's metrics (DATA.md §Metrics) from its cards (rows of `cards`,
 * any shape fromRow takes) and its lapses in the last TROUBLE_DAYS: the
 * mastery band of its weakest card (New when none has been reviewed), the
 * earliest due of the cards that have been reviewed (a card never reviewed
 * is new, waiting to be learned, not due: counting it would make every
 * phrase met in a session due at once), and whether it is in trouble.
 */
export function phraseMetrics(cards = [], lapses = 0) {
  const states = cards.map((c) => fromRow(c));
  const dues = states.filter((c) => !unreviewed(c)).map((c) => ms(c.due)).filter((t) => t != null);
  return {
    mastery: phraseMastery(states),
    due: dues.length ? iso(Math.min(...dues)) : null,
    lapses,
    trouble: lapses >= TROUBLE_LAPSES,
    cardCount: cards.length,
  };
}

/* ------------------------------ the bank's list ----------------------------- */

export const SHOWS = ["all", "starred", "new", "due", "trouble", "pending", "suspended", "pictures"];
export const SORTS = ["recent", "due", "weakest", "alpha", "added"];

/** Lowercased, accent-folded text for the bank's search box: "cafe" finds
 *  "café", and case never matters. */
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether a phrase is due for practice at `now`: a card of it that has
 *  been reviewed is due, and it is neither pending nor suspended. */
export const isDueNow = (p, now) => !p.pending && !p.suspended && p.due != null && ms(p.due) <= ms(now);
/** Whether a phrase is new: never practised (mastery New: no card of it
 *  reviewed, or no cards yet), and neither pending nor suspended. */
export const isNew = (p) => !p.pending && !p.suspended && p.mastery === "New";
/** Whether a phrase counts in the Mastery filter: not pending (no words to
 *  know yet) and not suspended (left out of practice, like new and due), so
 *  the "New" band and the "new" filter always give the same number. */
const banded = (p) => !p.pending && !p.suspended;

/** What each "show" filter keeps. */
const SHOW = {
  all: () => true,
  starred: (p) => p.starred,
  new: (p) => isNew(p),
  due: (p, now) => isDueNow(p, now),
  trouble: (p) => p.trouble,
  pending: (p) => p.pending,
  suspended: (p) => p.suspended,
  // A ready picture, drawn or shared stock (hasPicture is set by the list query).
  pictures: (p) => p.hasPicture === true,
};

const byLabel = (a, b) => (a.text ?? a.meaning ?? "").localeCompare(b.text ?? b.meaning ?? "", undefined, { sensitivity: "base" });
const newestFirst = (k) => (a, b) => (ms(b[k]) ?? -Infinity) - (ms(a[k]) ?? -Infinity);
const SORT = {
  // Most recently met first; never-seen ones (scenario lists, added by
  // hand) by when they were added.
  recent: (a, b) => (ms(b.lastSeenAt ?? b.createdAt) ?? 0) - (ms(a.lastSeenAt ?? a.createdAt) ?? 0) || byLabel(a, b),
  // Soonest due first; no cards (nothing to practise yet) last.
  due: (a, b) => (ms(a.due) ?? Infinity) - (ms(b.due) ?? Infinity) || byLabel(a, b),
  // Weakest band first, then the most lapses, then the soonest due.
  weakest: (a, b) => BANDS.indexOf(a.mastery) - BANDS.indexOf(b.mastery) || b.lapses - a.lapses || (ms(a.due) ?? Infinity) - (ms(b.due) ?? Infinity) || byLabel(a, b),
  alpha: byLabel,
  added: (a, b) => newestFirst("createdAt")(a, b) || byLabel(a, b),
};

/**
 * The bank view's list: `items` (phrases with their metrics, the wire's
 * PhraseSummary) searched (`q`, in the target form, meaning and note),
 * filtered (`show`, `band`), sorted and paged. Also the counts the filter
 * chips show, over the whole bank. Unknown filter values read as their
 * default.
 */
export function bankPage(items, { q = "", show = "all", band = "", sort = "recent", offset = 0, limit = 50 } = {}, now = new Date()) {
  const counts = { all: items.length, starred: 0, new: 0, due: 0, trouble: 0, pending: 0, suspended: 0, pictures: 0, bands: Object.fromEntries(BANDS.map((b) => [b, 0])) };
  for (const p of items) {
    for (const k of SHOWS.slice(1)) if (SHOW[k](p, now)) counts[k]++;
    if (banded(p)) counts.bands[p.mastery]++;
  }
  const needle = fold(q).trim();
  const keep = SHOW[SHOWS.includes(show) ? show : "all"];
  const wantBand = BANDS.includes(band) ? band : "";
  const hits = items.filter(
    (p) =>
      keep(p, now) &&
      (!wantBand || (banded(p) && p.mastery === wantBand)) &&
      (!needle || [p.text, p.meaning, p.note].some((s) => fold(s).includes(needle))),
  );
  hits.sort(SORT[SORTS.includes(sort) ? sort : "recent"]);
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  return { phrases: hits.slice(start, start + size), total: hits.length, nextOffset: start + size < hits.length ? start + size : null, counts };
}
