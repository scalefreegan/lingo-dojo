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
import { parsePinyin } from "./pronunciation.mjs";
import { hanOf } from "./pronunciation-live.mjs";

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
 * COMPARE_MIN of, with the two counts and the move; `flagged`: the share of
 * tone 1–4 syllables flagged then and now ("up": fewer now).
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
    // A rate, not a count: a shorter session has fewer flags without being
    // any better. Flags are only ever on tones 1–4 (the live bar), so the
    // rate is over the same syllables as the shares, under the same minimum
    // (checked above) and the same step; `move` "up" is fewer flagged.
    flagged: {
      now: { off: now.off, checked: now.judged.checked },
      was: { off: was.off, checked: was.judged.checked },
      move: moveOf({ ok: now.judged.checked - now.off, checked: now.judged.checked }, { ok: was.judged.checked - was.off, checked: was.judged.checked }),
    },
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
export function practiceToneMiss(outcome, flags, { answer, text } = {}) {
  if (!outcome || !Array.isArray(flags) || !flags.length) return { outcome, toneMiss: null };
  // The tones were scored against the phrase's own characters: they say
  // something about this answer only when it *is* those characters. A saved
  // alternate graded exact (帮助 for 帮忙) or a synonym the grader accepted
  // is other words, and its recording was never these syllables.
  const said = hanOf(answer);
  if (!said || said !== hanOf(text)) return { outcome, toneMiss: null };
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

/* ----------------------- characters read more than one way ----------------------- */

const samePinyin = (a, b) => String(a ?? "").normalize("NFC").trim().toLowerCase() === String(b ?? "").normalize("NFC").trim().toLowerCase();

/**
 * The places (1-based, among `text`'s Han characters) whose reading is
 * settled for this learner as the score read it: an entry (`{ word, key,
 * reading }`: the learner's own correction or an active shared reading,
 * one syllable per character) found in the text that gives the character
 * at that place the very syllable it was scored as (`scored`: place →
 * pinyin). An entry that reads it otherwise doesn't settle it: the score
 * was then against a reading the learner was told is wrong.
 */
export function settledPlaces(text, entries, scored) {
  const cps = [...String(text ?? "")];
  const placeAt = [];
  let n = 0;
  for (const c of cps) placeAt.push(/\p{Script=Han}/u.test(c) ? ++n : 0);
  const out = new Set();
  for (const e of entries ?? []) {
    const syl = String(e?.reading ?? "").trim().split(/\s+/).filter(Boolean);
    for (const form of new Set([e?.word, e?.key].filter((f) => typeof f === "string" && f))) {
      const f = [...form];
      if (f.length !== syl.length || !f.every((c) => /\p{Script=Han}/u.test(c))) continue;
      for (let i = 0; i + f.length <= cps.length; i++) {
        if (!f.every((c, j) => cps[i + j] === c)) continue;
        f.forEach((_, j) => {
          const place = placeAt[i + j];
          if (scored.has(place) && samePinyin(scored.get(place), syl[j])) out.add(place);
        });
      }
    }
  }
  return out;
}

/** Sentence punctuation, the only marks that start a new leading place:
 *  brackets, quotes, …, / and 、 don't break the engine's sandhi context
 *  (快（一）点儿, 一、两个). */
const SENTENCE_PUNCT = new Set([..."，。！？；：,.!?;:"]);

/**
 * The places (1-based, among `text`'s Han characters) that may fail a
 * speak-it answer by position: the phrase's first Han character, and a Han
 * character directly after sentence punctuation (，。！？；： or , . ! ? ; :,
 * spaces between allowed). Any other
 * syllable may be said in the neutral tone or changed by its neighbours
 * (听听 tīng ting, 东西 dōng xi, 医生 yī sheng, 只买 zhí mǎi), and no word
 * table says which, so none of them can make a miss. Deliberately narrow.
 */
export function leadingPlaces(text) {
  const out = new Set();
  let place = 0;
  let prev = null;
  for (const c of String(text ?? "")) {
    if (/\s/u.test(c)) continue;
    if (/\p{Script=Han}/u.test(c)) {
      place++;
      if (place === 1 || SENTENCE_PUNCT.has(prev)) out.add(place);
    }
    prev = c;
  }
  return out;
}

/**
 * The flags that may fail a Practice answer; when in doubt, no miss. The
 * rule is deliberately narrow:
 *  - Position: only a leading place (leadingPlaces) can fail.
 *  - Context: never a syllable whose expected tone isn't its own citation
 *    tone (sandhi or context set it: 一路 yí, 请倒茶 qíng), nor a third tone
 *    whose next syllable is read third (the half-third and 3-3 cases rest
 *    on the neighbour's reading, which may be wrong), settled or not.
 *    `readings`: the reader's syllable at each Han place (index = place).
 *  - Taiwan (`tw`): only a settled reading; the reader's tables give many
 *    characters the mainland tone only (播 bō, Taiwan bò) and no
 *    machine-readable Taiwan source exists.
 *  - Readings: a character with more than one reading tone (neutral
 *    included: 空 kōng/kòng, 只 zhī/zhǐ, 么 me/mó) fails nothing unless
 *    that place's reading is settled (`settled`, settledPlaces over the
 *    learner's own choices by hand, else the shared list's active entries;
 *    never a reading the page sent, a recap's guess or a GLOSS hint).
 * So a miss needs a first syllable whose character has one reading tone (妈
 * mā said falling), or a settled one.
 * `readingsOf(char)`: every reading of the character (zh.ts charReadings).
 */
export function settleFlags(flags, { readingsOf, text, settled = new Set(), readings = [], tw = false }) {
  const leading = leadingPlaces(text);
  return (flags ?? []).filter((f) => {
    if (!leading.has(f.place)) return false;
    // 一 and 不: their tone always rests on the neighbour.
    if (f.char === "一" || f.char === "不") return false;
    const own = parsePinyin(f.pinyin).tone;
    if (f.expectedTone !== own) return false;
    const next = readings[f.place + 1];
    if (own === 3 && next && parsePinyin(next).tone === 3) return false;
    if (settled.has(f.place)) return true;
    if (tw) return false;
    const tones = new Set([f.pinyin, ...(readingsOf(f.char) ?? [])].map((r) => parsePinyin(r).tone));
    return tones.size === 1;
  });
}

/** Whether a settled reading could change settleFlags' answer (so the
 *  settling entries need reading at all). */
export function doubtfulFlags(flags, opts) {
  return settleFlags(flags, opts).length !== settleFlags(flags, { ...opts, settled: new Set((flags ?? []).map((f) => f.place)) }).length;
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

/* --------------------------- a session's tone misses --------------------------- */

/** How many tone misses a recap records at most (a long list says the
 *  recording was bad, not the learner). */
export const MAX_SESSION_TONE_MISSES = 10;

/**
 * A stored check as the session rule reads it (ld-ne0.18): the flagged
 * syllables as notes (pronunciation-live.mjs flagNote's shape, before
 * settleFlags) and the places judged right. Null when the line isn't the
 * text that was scored (its Han characters must be the syllables', one for
 * one), so a place always names the same character in both.
 */
export function storedFlags(row) {
  const syl = syllablesOf(row);
  const line = typeof row?.line === "string" ? row.line : "";
  if (!syl.length || syl.some((s) => !s) || [...hanOf(line)].join("") !== syl.map((s) => s.char).join("")) return null;
  const flags = [];
  const ok = [];
  syl.forEach((s, i) => {
    if (s.verdict === "ok") ok.push(i + 1);
    if (s.verdict === "off") flags.push({ char: s.char, place: i + 1, pinyin: s.pinyin, expectedTone: s.tone, heardTone: s.heardTone });
  });
  return { line, flags, ok };
}

/** The places (counted in Han characters) where a word of `line` ends, by
 *  Intl.Segmenter; a sentence mark or the end of the line is one too. */
function wordEnds(line) {
  const out = new Set();
  let place = 0;
  for (const { segment } of new Intl.Segmenter("zh", { granularity: "word" }).segment(line)) {
    place += hanOf(segment).length;
    out.add(place);
  }
  return out;
}

/** A phrase's Han characters and leading places, or null for one that
 *  isn't Mandarin alone (a pattern with Latin letters, a digit). */
function phraseShape(text) {
  const t = String(text ?? "");
  const han = hanOf(t);
  return han && /^[\p{Script=Han}\p{P}\s]+$/u.test(t) ? { han, leading: leadingPlaces(t) } : null;
}

/** Whether the phrase `shape` was said in `line` from the Han place `start`,
 *  as words of its own: the same characters; no sentence mark inside it that
 *  the phrase doesn't have; ending where a word ends; and one character only
 *  when it is the whole clause (他 isn't 他们's, nor a sentence's subject). */
function saidAt(shape, { han, leading, ends }, start) {
  const n = [...shape.han].length;
  const end = start + n - 1;
  if (han.slice(start - 1, end).join("") !== shape.han) return false;
  for (let p = start + 1; p <= end; p++) if (leading.has(p) && !shape.leading.has(p - start + 1)) return false;
  if (n === 1) return end === han.length || leading.has(end + 1);
  return end === han.length || leading.has(end + 1) || ends.has(end);
}

/** Whether a line says the missed syllable (`place` of the phrase `shape`)
 *  right again, for "what was said last decides": the whole phrase anywhere
 *  in it (我妈妈很忙 for 妈妈很忙; one character only as a whole clause), or a
 *  clause that is the phrase's own words from that syllable on (strict
 *  coaching asks for "just that word": 妈妈). Wider than what makes a miss:
 *  when in doubt, none. */
function saidRight(shape, place, { han, leading }, ok) {
  const want = [...shape.han];
  for (const at of ok) {
    if (han[at - 1] !== want[place - 1]) continue;
    const start = at - place + 1;
    if (want.length > 1 && start >= 1 && han.slice(start - 1, start - 1 + want.length).join("") === shape.han) return true;
    if (!leading.has(at)) continue;
    let end = at;
    while (end < han.length && !leading.has(end + 1)) end++;
    const clause = han.slice(at - 1, end).join("");
    if (clause && want.slice(place - 1).join("").startsWith(clause)) return true;
  }
  return false;
}

/**
 * The bank phrases a session's flagged syllables fail (ld-ne0.18;
 * docs/VOICE.md §Tones after the session). `lines`: the session's checks in
 * order, `{ line, flags, ok }` (storedFlags, with `flags` already through
 * settleFlags: the same narrow rule as Practice, over the line as said);
 * `phrases`: the bank's, `{ norm, text, late }`; `late`: not in the bank
 * when the session ended (this recap kept it), taken only where no other
 * fits, so a sentence the model happens to keep never takes a miss from the
 * phrase the learner is practising.
 *
 * A flag belongs to the longest phrase that starts at a leading place of
 * the line and holds the flag at a leading place of its own; at most one.
 * What the learner did last decides: the syllable judged right later, in
 * the phrase or in the part of it said again (saidRight), clears it (they
 * were coached and fixed it); "not sure" changes nothing.
 * → `[{ norm, text, line, syllables, flags }]` in the order said (the caller
 * caps them: MAX_SESSION_TONE_MISSES); a syllable's `place` is its place in
 * the phrase; `flags`: every flag behind the miss, `{ line, place }` with
 * the place in the line. With `fixed`, the phrases whose every flag was
 * cleared come too, marked `fixed: true`, as they were when last flagged:
 * what a recap that failed one anyway is undone by (ld-ne0.20).
 */
export function sessionToneMisses(lines, phrases, { fixed = false } = {}) {
  const shapes = [];
  for (const p of phrases ?? []) {
    const shape = p?.norm ? phraseShape(p.text) : null;
    if (shape) shapes.push({ ...shape, norm: p.norm, text: p.text, late: !!p.late });
  }
  // The learner's own before the recap's, then the longest first, so the
  // first that fits is the one.
  shapes.sort((a, b) => Number(a.late) - Number(b.late) || b.han.length - a.han.length || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
  const misses = new Map();
  const cleared = new Map();
  for (const l of lines ?? []) {
    const ctx = { han: [...hanOf(l.line)], leading: leadingPlaces(l.line), ends: wordEnds(l.line) };
    const ok = new Set(l.ok ?? []);
    for (let start = 1; start <= ctx.han.length; start++) {
      if (ok.has(start)) {
        for (const miss of [...misses.values()]) {
          const was = new Map(miss.syllables);
          for (const place of [...miss.syllables.keys()]) if (saidRight(miss.shape, place, ctx, [start])) miss.syllables.delete(place);
          if (!miss.syllables.size) {
            misses.delete(miss.shape.norm);
            cleared.set(miss.shape.norm, { ...miss, syllables: was, fixed: true });
          }
        }
      }
      // The flag at this place: the first phrase, from any leading place up
      // to it, that holds it. Chosen per flag, so a phrase that only starts
      // the line takes nothing from the one the flag is in.
      const f = ctx.leading.has(start) ? (l.flags ?? []).find((x) => x.place === start) : undefined;
      const from = f ? [...ctx.leading].filter((p) => p <= start) : [];
      const at = (x) => from.find((p) => x.leading.has(start - p + 1) && saidAt(x, ctx, p));
      const shape = from.length ? shapes.find((x) => at(x) !== undefined) : undefined;
      if (!shape) continue;
      const place = start - at(shape) + 1;
      const miss = misses.get(shape.norm) ?? { shape, line: l.line, syllables: new Map(), flags: [] };
      miss.line = l.line;
      miss.flags.push({ line: l.line, place: start });
      miss.syllables.set(place, { char: f.char, place, pinyin: f.pinyin, expectedTone: f.expectedTone, heardTone: Number.isInteger(f.heardTone) ? f.heardTone : null });
      misses.set(shape.norm, miss);
    }
  }
  const all = [...misses.values(), ...(fixed ? [...cleared.values()].filter((m) => !misses.has(m.shape.norm)) : [])];
  return all.map((m) => ({ norm: m.shape.norm, text: m.shape.text, line: m.line, syllables: [...m.syllables.values()].slice(0, MAX_TONE_MISS), flags: m.flags, ...(m.fixed ? { fixed: true } : {}) }));
}

/** Whether what the recap says the learner said holds the phrase as words
 *  of its own (saidAt: 妈 isn't in 妈妈, nor 好吃 in 好。吃。): its words were right, so a correction beside a tone flag can
 *  only be the tone's. Nothing recorded, or other words: not known. */
export function saidItsWords(said, phrase) {
  const shape = phraseShape(phrase);
  if (!shape) return false;
  const line = String(said ?? "");
  const ctx = { han: [...hanOf(line)], leading: leadingPlaces(line), ends: wordEnds(line) };
  // From a leading place, as a miss does: a word inside another isn't it.
  return [...ctx.leading].some((p) => saidAt(shape, ctx, p));
}
