// Pronunciation stage 3 (ld-ne0.4; docs/VOICE.md §Tones after the session,
// docs/DATA.md §Pronunciation in sessions): the pure rules that read the
// checks stage 2 keeps (pronunciation_checks, one row per scored adult
// learner turn, scripts/pronunciation-live.mjs liveRecord) back to the
// learner, and the one way a tone check may now change a Practice grade.
//
//  - a session's tones (`sessionTones`): counts, a per-tone breakdown and
//    the flagged syllables with their line, for the recap card. No model
//    call: arithmetic over the stored rows;
//  - against the last attempt of the scene (`compareTones`), in the plain
//    style of the recap's "since last time" (revisit.mjs compareAttempts);
//  - the per-tone trend (`toneTrend`): share right per tone per day, a
//    point only where it rests on enough syllables;
//  - Practice speak-it (`practiceToneMiss`): right words with a syllable
//    flagged at the live bar count as a miss, with the grade they had kept
//    so "I said it right" can restore it.
//
// "Right" is the live verdict as stored: `ok`. A share is ok over every
// syllable of tones 1–4 (ok, off and not sure alike): a syllable the scorer
// couldn't read is not counted right, so a noisy room shows as a lower
// share rather than a better one. Neutral-tone syllables are counted and
// listed but never in a share: the engine doesn't judge them (they come
// back "not sure", reason "neutral").
//
// Pure ESM with no server imports, like pronunciation-live.mjs.

import { isUuid } from "./phrases.mjs";
import { dayStart } from "./practice.mjs";

/** The tones a breakdown lists, in the order shown: the four, then the
 *  neutral tone (expectedTone 0). */
export const TONES = [1, 2, 3, 4, 0];
/** The tones a share is taken over. */
const JUDGED = new Set([1, 2, 3, 4]);
const VERDICTS = new Set(["ok", "off", "unsure"]);

/** The flagged syllables a recap lists at most (a session keeps at most 20
 *  clips, and a long list of misses says no more than its count). */
export const MAX_FLAGGED_SHOWN = 30;

/** One stored syllable, read defensively (the row is the server's own, but
 *  a jsonb column is whatever was written): null for anything unusable. */
function syllableOf(s) {
  if (!s || typeof s !== "object") return null;
  const tone = Number.isInteger(s.expectedTone) && s.expectedTone >= 0 && s.expectedTone <= 4 ? s.expectedTone : null;
  if (tone === null || !VERDICTS.has(s.verdict)) return null;
  return {
    char: typeof s.char === "string" ? s.char : "",
    pinyin: typeof s.pinyin === "string" ? s.pinyin : "",
    tone,
    verdict: s.verdict,
    heardTone: Number.isInteger(s.heardTone) ? s.heardTone : null,
    startMs: Number.isFinite(s.startMs) ? s.startMs : null,
    endMs: Number.isFinite(s.endMs) ? s.endMs : null,
  };
}

const syllablesOf = (row) => (Array.isArray(row?.syllables) ? row.syllables : []).map(syllableOf);

const emptyCount = () => ({ checked: 0, ok: 0, off: 0, unsure: 0 });
function add(c, verdict) {
  c.checked++;
  c[verdict]++;
}

/** Counts over syllables (nulls skipped): all of them, and by tone. */
function countOf(syllables) {
  const all = emptyCount();
  const by = new Map(TONES.map((t) => [t, emptyCount()]));
  for (const s of syllables) {
    if (!s) continue;
    add(all, s.verdict);
    add(by.get(s.tone), s.verdict);
  }
  return { all, by };
}

/** ok over the syllables of tones 1–4 in `by`. */
function judgedOf(by) {
  let ok = 0;
  let checked = 0;
  for (const t of JUDGED) {
    ok += by.get(t).ok;
    checked += by.get(t).checked;
  }
  return { ok, checked };
}

/**
 * A session's tones, from its checks (oldest first), each with the line it
 * scored: `{ id, syllables, clip (whether a clip is kept), line }`. Null
 * when there is nothing to show (no checks, or none with a usable
 * syllable): the recap then has no Tones section at all.
 *
 * `flagged` lists each `off` syllable (the live bar applied when stored)
 * with its line and its place among the line's Han characters (1-based,
 * the way the dojo master was told it), its stretch of the clip, and the
 * check's id for the clip (null when none was kept).
 */
export function sessionTones(rows) {
  const flagged = [];
  const all = [];
  let turns = 0;
  for (const row of rows ?? []) {
    const syl = syllablesOf(row);
    if (!syl.some(Boolean)) continue;
    turns++;
    syl.forEach((s, i) => {
      if (!s) return;
      all.push(s);
      if (s.verdict !== "off" || flagged.length >= MAX_FLAGGED_SHOWN) return;
      flagged.push({
        checkId: row.clip ? String(row.id) : null,
        line: typeof row.line === "string" ? row.line : "",
        place: i + 1,
        char: s.char,
        pinyin: s.pinyin,
        expectedTone: s.tone,
        heardTone: s.heardTone,
        startMs: s.startMs,
        endMs: s.endMs,
      });
    });
  }
  if (!all.length) return null;
  const { all: total, by } = countOf(all);
  return {
    turns,
    ...total,
    judged: judgedOf(by),
    byTone: TONES.map((tone) => ({ tone, ...by.get(tone) })).filter((t) => t.checked > 0),
    flagged,
  };
}

/** How many syllables of a tone both sessions need before the two are
 *  compared on it: fewer, and one syllable either way swings the share. */
export const COMPARE_MIN = 3;
/** How far a share must move to be called better or worse (10 points). */
export const COMPARE_STEP = 0.1;

const moveOf = (now, was) => {
  const d = now.ok / now.checked - was.ok / was.checked;
  return d >= COMPARE_STEP - 1e-9 ? "up" : d <= -COMPARE_STEP + 1e-9 ? "down" : "same";
};

/**
 * This session's tones against the attempt it built on (both from
 * `sessionTones`), or null when either has fewer than COMPARE_MIN syllables
 * of tones 1–4. `tones`: each of tones 1–4 both sessions have at least
 * COMPARE_MIN of, with the two counts and the move; `flagged`: how many
 * syllables were flagged then and now.
 */
export function compareTones(now, was, { min = COMPARE_MIN } = {}) {
  if (!now || !was || now.judged.checked < min || was.judged.checked < min) return null;
  const pick = (s, tone) => s.byTone.find((t) => t.tone === tone);
  const tones = [];
  for (const tone of JUDGED) {
    const a = pick(now, tone);
    const b = pick(was, tone);
    if (!a || !b || a.checked < min || b.checked < min) continue;
    const n = { ok: a.ok, checked: a.checked };
    const w = { ok: b.ok, checked: b.checked };
    tones.push({ tone, now: n, was: w, move: moveOf(n, w) });
  }
  return {
    overall: { now: now.judged, was: was.judged, move: moveOf(now.judged, was.judged) },
    tones,
    flagged: { now: now.off, was: was.off },
  };
}

/** The fewest syllables of a tone a trend point rests on: a day with fewer
 *  has no point for that tone (it is still counted, and the day's number
 *  says how many there were). */
export const TREND_MIN_SYLLABLES = 10;
/** The trend's window: `?days=` within these, else the default. */
export const TREND_DAYS = Object.freeze({ min: 7, max: 180, default: 30 });

/** `?days=` → a whole number of days within TREND_DAYS, else the default. */
export function readTrendDays(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isInteger(n) && n >= TREND_DAYS.min && n <= TREND_DAYS.max ? n : TREND_DAYS.default;
}

/** A day's label, YYYY-MM-DD, in the learner's day (dayStart's: the UTC
 *  offset and the 4 a.m. rollover Practice counts in). */
function dayLabel(start, utcOffsetMinutes) {
  // dayStart is a UTC instant; shifted by the offset it reads as the local
  // date (its rollover hour is past midnight, so the date is the day's).
  return new Date(start.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The trend's window in the learner's days: the first and the last day
 *  (today) as YYYY-MM-DD, and the instant the first starts (what is read). */
export function trendWindow(now, days, utcOffsetMinutes = 0) {
  const today = dayStart(now, utcOffsetMinutes);
  const first = new Date(today.getTime() - (days - 1) * 86_400_000);
  return { from: dayLabel(first, utcOffsetMinutes), to: dayLabel(today, utcOffsetMinutes), since: first };
}

/**
 * The per-tone trend over the checks of a language (`{ createdAt,
 * syllables }`, any order): one point per day that has any, oldest first,
 * each with the counts of tones 1–4 and the share right of each tone that
 * has at least `min` syllables that day (else `share: null`: counted, not
 * drawn). `all` is the day's tones 1–4 together, under the same rule.
 */
export function toneTrend(rows, { utcOffsetMinutes = 0, min = TREND_MIN_SYLLABLES } = {}) {
  const days = new Map();
  for (const row of rows ?? []) {
    const at = row?.createdAt instanceof Date ? row.createdAt : new Date(row?.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const start = dayStart(at, utcOffsetMinutes);
    const key = start.getTime();
    let d = days.get(key);
    for (const s of syllablesOf(row)) {
      if (!s || !JUDGED.has(s.tone)) continue;
      if (!d) days.set(key, (d = { start, by: new Map([...JUDGED].map((t) => [t, { ok: 0, n: 0 }])) }));
      const c = d.by.get(s.tone);
      c.n++;
      if (s.verdict === "ok") c.ok++;
    }
  }
  const share = (c) => (c.n >= min ? c.ok / c.n : null);
  return [...days.values()]
    .sort((a, b) => a.start - b.start)
    .map((d) => {
      const all = { ok: 0, n: 0 };
      for (const c of d.by.values()) {
        all.ok += c.ok;
        all.n += c.n;
      }
      return {
        day: dayLabel(d.start, utcOffsetMinutes),
        tones: [...d.by].map(([tone, c]) => ({ tone, ok: c.ok, n: c.n, share: share(c) })),
        all: { ...all, share: share(all) },
      };
    });
}

/* ------------------------------ Practice speak-it ------------------------------ */

/**
 * A speak-it recording's tone check held for the answer it goes with
 * (`?phrase=&submit=` on the score route): both ids, or neither (no
 * hold). → `{ hold }` (null for none) or `{ error }` (one without the
 * other, or not ids: a 400).
 */
export function readToneHold(phrase, submit) {
  if (phrase == null && submit == null) return { hold: null };
  if (!isUuid(phrase) || !isUuid(submit)) return { error: "phrase and submit go together, each the id the card and its answer use" };
  return { hold: { phraseId: phrase.toLowerCase(), submitId: submit.toLowerCase() } };
}

/** The flagged syllables a Practice miss names at most. */
export const MAX_TONE_MISS = 3;

/**
 * Speak-it's grade with its tone check (stage 3): an answer graded right
 * (exact, close or accepted) whose recording had a syllable flagged at the
 * live bar (`flags`: pronunciation-live.mjs flagNote of each liveFlags
 * index, most certain first) becomes a miss (Again, verdict wrong) for the
 * card, keeping its own note. `toneMiss` keeps what it would have been
 * (rating and verdict, for "I said it right") and the syllables, for the
 * reason shown. A wrong answer, a self-graded one, or no flag: unchanged,
 * `toneMiss` null.
 *
 * Only the live bar's flags, never the engine's plain `off`: the stricter,
 * high-precision bar, because this changes a schedule and the scorer is
 * known to be wrong sometimes (an echoing room, spans in the wrong place).
 */
export function practiceToneMiss(outcome, flags) {
  if (!outcome || !Array.isArray(flags) || !flags.length) return { outcome, toneMiss: null };
  if (!["exact", "close", "accepted"].includes(outcome.verdict)) return { outcome, toneMiss: null };
  const syllables = flags.slice(0, MAX_TONE_MISS).map((f) => ({
    char: String(f.char ?? ""),
    place: Number(f.place) || 0,
    pinyin: String(f.pinyin ?? ""),
    expectedTone: Number(f.expectedTone) || 0,
    heardTone: Number.isInteger(f.heardTone) ? f.heardTone : null,
  }));
  return {
    outcome: { verdict: "wrong", rating: 1, note: outcome.note ?? null },
    toneMiss: { rating: outcome.rating, verdict: outcome.verdict, syllables },
  };
}

/** A stored tone miss (reviews.card_before.tone_miss) read back for the
 *  reply, or null. */
export function storedToneMiss(v) {
  if (!v || typeof v !== "object" || !Number.isInteger(v.rating) || v.rating < 1 || v.rating > 4) return null;
  if (!["exact", "close", "accepted"].includes(v.verdict) || !Array.isArray(v.syllables)) return null;
  return {
    rating: v.rating,
    verdict: v.verdict,
    syllables: v.syllables
      .filter((s) => s && typeof s === "object")
      .slice(0, MAX_TONE_MISS)
      .map((s) => ({ char: String(s.char ?? ""), place: Number(s.place) || 0, pinyin: String(s.pinyin ?? ""), expectedTone: Number(s.expectedTone) || 0, heardTone: Number.isInteger(s.heardTone) ? s.heardTone : null })),
  };
}
