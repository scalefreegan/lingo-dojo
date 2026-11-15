// The phrase bank: the pure half (docs/DATA.md §Phrase bank, §Phrase
// capture, §Metrics). What a voice turn's glosses and a scenario's lists put
// into the bank, how a phrase's metrics are worked out from its cards and
// reviews, and how the bank view filters and sorts. No I/O and no clock
// reads (every function that needs the time takes `now`), so `node --test`
// pins it directly; scripts/db/phrases.ts does the writes.

import { BANDS, fromRow, phraseMastery } from "./fsrs.mjs";
import { normKey } from "./match.mjs";
import { languageOf, localeFor } from "./voice.mjs";

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

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

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

/* --------------------------------- capture --------------------------------- */

/** A gloss term's letters, for finding the line it came from. */
const bare = (s) => oneLine(s).normalize("NFC").toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");

/** The line of a reply that holds `term`: its target-language words (the
 *  line's text when it has no segments), and who said it. null when no line
 *  has it (a gloss of a word the reply only implied). */
export function exampleFor(term, lines) {
  const needle = bare(term);
  if (!needle) return null;
  for (const l of lines ?? []) {
    const target = Array.isArray(l?.segments) && l.segments.length ? l.segments.filter((g) => g?.lang === "target").map((g) => g.text).join(" ") : l?.text;
    const sentence = oneLine(target);
    if (sentence && sentence.normalize("NFC").toLowerCase().includes(needle)) {
      return { sentence: sentence.slice(0, LIMITS.sentence), speaker: typeof l.speaker === "string" ? l.speaker : null };
    }
  }
  return null;
}

/**
 * What a dojo-master reply's glosses put into the bank: one item per
 * distinct target form (its match key), with its meaning and the line that
 * holds it. Sentence-length glosses (more than MAX_CAPTURE_WORDS words) are
 * translations and left out. Sorted by key, so two writers that touch the
 * same phrases lock their rows in the same order and can't deadlock.
 */
export function glossCaptures(glosses, lines, locale) {
  const out = new Map();
  for (const g of glosses ?? []) {
    const text = oneLine(g?.term).slice(0, LIMITS.text);
    const norm = normKey(text);
    if (!norm || out.has(norm)) continue;
    if (wordCount(text, locale) > MAX_CAPTURE_WORDS) continue;
    const meaning = oneLine(g?.meaning).slice(0, LIMITS.meaning) || null;
    out.set(norm, { text, norm, meaning, meaningNorm: meaning ? normKey(meaning) || null : null, example: exampleFor(text, lines) });
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
  if (required && !oneLine(v)) return `${field} can't be blank`;
  if (oneLine(v).length > max) return `${field} is longer than ${max} characters`;
  return null;
}

/**
 * A phrase add (`create`) or edit body, checked and trimmed: `{ value }`,
 * or `{ error }` for a 400. text and meaning are one line; a note keeps its
 * line breaks. An edit takes any of text, meaning, note, starred,
 * suspended; null or "" clears meaning and note. Unknown keys are ignored.
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
      const v = key === "note" ? String(body[key] ?? "").trim() : oneLine(body[key]);
      value[key] = v || null;
    }
  }
  for (const key of ["starred", "suspended"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { error: `${key} must be true or false` };
    value[key] = body[key];
  }
  if (!create && !Object.keys(value).length) return { error: "nothing to change: send text, meaning, note, starred or suspended" };
  return { value };
}

/* --------------------------------- metrics --------------------------------- */

const ms = (d) => (d == null ? null : new Date(d).getTime());
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/**
 * One phrase's metrics (DATA.md §Metrics) from its cards (rows of `cards`,
 * any shape fromRow takes) and its lapses in the last TROUBLE_DAYS:
 * the mastery band of its weakest card (New with none), its earliest due,
 * and whether it is in trouble.
 */
export function phraseMetrics(cards = [], lapses = 0) {
  const states = cards.map((c) => fromRow(c));
  const dues = states.map((c) => ms(c.due)).filter((t) => t != null);
  return {
    mastery: phraseMastery(states),
    due: dues.length ? iso(Math.min(...dues)) : null,
    lapses,
    trouble: lapses >= TROUBLE_LAPSES,
    cardCount: cards.length,
  };
}

/* ------------------------------ the bank's list ----------------------------- */

export const SHOWS = ["all", "starred", "due", "trouble", "pending", "suspended"];
export const SORTS = ["recent", "due", "weakest", "alpha", "added"];

/** Lowercased, accent-folded text for the bank's search box: "cafe" finds
 *  "café", and case never matters. */
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether a phrase is due for practice at `now`: it has a card due, and is
 *  neither pending nor suspended. */
export const isDueNow = (p, now) => !p.pending && !p.suspended && p.due != null && ms(p.due) <= ms(now);

/** What each "show" filter keeps. */
const SHOW = {
  all: () => true,
  starred: (p) => p.starred,
  due: (p, now) => isDueNow(p, now),
  trouble: (p) => p.trouble,
  pending: (p) => p.pending,
  suspended: (p) => p.suspended,
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
  const counts = { all: items.length, starred: 0, due: 0, trouble: 0, pending: 0, suspended: 0, bands: Object.fromEntries(BANDS.map((b) => [b, 0])) };
  for (const p of items) {
    for (const k of SHOWS.slice(1)) if (SHOW[k](p, now)) counts[k]++;
    if (!p.pending) counts.bands[p.mastery]++;
  }
  const needle = fold(q).trim();
  const keep = SHOW[SHOWS.includes(show) ? show : "all"];
  const wantBand = BANDS.includes(band) ? band : "";
  const hits = items.filter(
    (p) =>
      keep(p, now) &&
      (!wantBand || (!p.pending && p.mastery === wantBand)) &&
      (!needle || [p.text, p.meaning, p.note].some((s) => fold(s).includes(needle))),
  );
  hits.sort(SORT[SORTS.includes(sort) ? sort : "recent"]);
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  return { phrases: hits.slice(start, start + size), total: hits.length, nextOffset: start + size < hits.length ? start + size : null, counts };
}
