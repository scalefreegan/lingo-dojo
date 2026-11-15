// Spaced repetition: the pure half. Wraps ts-fsrs so the rest of the app deals
// in plain JSON card state, 1-4 ratings and a mastery band, and never imports
// the library. No I/O and no clock reads (every function takes `now`), so
// `node --test` pins the scheduling directly. Design: docs/DATA.md, "Phrase
// bank" and "Post-session extraction".
//
// Why the legacy `fsrs()` entry point: ts-fsrs 6 marks it deprecated in favour
// of an async `DefaultScheduler` (FSRS-7 by default). A synchronous call is
// what a request handler and a unit test want, and the Card shape is the same.
// `fsrs()` is FSRS-6 with fuzzing off, so the same card and time always give
// the same result, which the tests rely on. If the library drops it, this file
// is the only place to change.

import { fsrs, createEmptyCard, State } from "ts-fsrs";

/** The three memories kept per phrase (docs/DATA.md "Three cards per phrase"). */
export const SKILLS = ["recognize", "listen", "produce"];

export const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

/** One scheduler for the process. Default parameters, 90% desired retention. */
const scheduler = fsrs();

/* ------------------------------ card state ------------------------------- */

// Card state is a plain object with exactly the fields of ts-fsrs 6's `Card`
// (due, stability, difficulty, scheduled_days, learning_steps, reps, lapses,
// state, last_review). `elapsed_days`, which docs/DATA.md lists, no longer
// exists in the library: it is derived from `last_review` at review time.
// Dates are ISO-8601 strings in UTC, so a card survives JSON.stringify, a jsonb
// column or a fetch body unchanged. `toRow` / `fromRow` convert to and from
// Date objects for a timestamptz column (what a Postgres driver returns).

const iso = (d) => (d == null ? null : new Date(d).toISOString());

function fromLib(c) {
  return {
    due: iso(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: iso(c.last_review),
  };
}

function toLib(card) {
  return { ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined };
}

/** A card never reviewed, due immediately. */
export function newCard(now = new Date()) {
  return fromLib(createEmptyCard(new Date(now)));
}

/** Card state to a DB row's values: the two date fields become Date objects. */
export function toRow(card) {
  return { ...card, due: new Date(card.due), last_review: card.last_review == null ? null : new Date(card.last_review) };
}

/** learning_steps has no safe default: a card round-tripped without it loses
 *  its place in the learning ladder and never graduates out of Learning, so a
 *  missing column must fail loudly, not read as 0. */
function requireNumber(row, key) {
  const v = row[key];
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`fromRow: ${key} is required and must be a number (got ${v === undefined ? "undefined" : JSON.stringify(v)})`);
  }
  return n;
}

/** A DB row (Date or string dates, extra columns ignored) back to card state.
 *  Throws if learning_steps is missing or not a number. */
export function fromRow(row) {
  return {
    due: iso(row.due),
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    scheduled_days: Number(row.scheduled_days),
    learning_steps: requireNumber(row, "learning_steps"),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    state: Number(row.state),
    last_review: iso(row.last_review),
  };
}

/* -------------------------------- review --------------------------------- */

/** Apply a 1-4 rating (Again, Hard, Good, Easy) at `now`. Returns the next card
 *  and a log entry (the review as ts-fsrs saw it, with ISO dates).
 *
 *  Days: ts-fsrs counts elapsed days between UTC midnights, not 24-hour spans,
 *  so two reviews minutes apart across a midnight would count as a day apart
 *  and inflate stability. To put the day boundary where the learner's day
 *  really turns over, times are shifted before they reach ts-fsrs so its
 *  midnight falls at `rolloverHour` local time (Anki's 4am rule), and shifted
 *  back in the result, so stored dates are real instants. The module reads
 *  neither the clock nor the machine's timezone: the caller passes
 *  `utcOffsetMinutes` (local minus UTC, e.g. -420 for US Mountain daylight
 *  time) and `now`. Within a day the review is still graded by how early or
 *  late it is, so out-of-schedule reviews work; "due" is a suggestion.
 *
 *  If `now` is earlier than the card's `last_review` (a recap retried after a
 *  later practice review), `now` is clamped up to `last_review`: ts-fsrs
 *  rejects a negative interval, and the review still counts. */
export function review(card, rating, now = new Date(), { utcOffsetMinutes = 0, rolloverHour = 4 } = {}) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new RangeError(`rating must be 1-4, got ${rating}`);
  }
  if (!Number.isFinite(utcOffsetMinutes) || !Number.isFinite(rolloverHour)) {
    throw new RangeError("utcOffsetMinutes and rolloverHour must be numbers");
  }
  const shift = utcOffsetMinutes * 60_000 - rolloverHour * 3_600_000;
  let at = new Date(now).getTime();
  if (card.last_review) at = Math.max(at, new Date(card.last_review).getTime());
  const fwd = (d) => new Date(new Date(d).getTime() + shift);
  const back = (d) => iso(new Date(new Date(d).getTime() - shift));
  const lib = toLib(card);
  lib.due = fwd(lib.due);
  if (lib.last_review) lib.last_review = fwd(lib.last_review);
  const out = scheduler.next(lib, new Date(at + shift), rating);
  const l = out.log;
  const next = fromLib(out.card);
  next.due = back(next.due);
  next.last_review = next.last_review && back(next.last_review);
  return {
    card: next,
    log: {
      rating: l.rating,
      state: l.state,
      due: back(l.due),
      stability: l.stability,
      difficulty: l.difficulty,
      scheduled_days: l.scheduled_days,
      learning_steps: l.learning_steps,
      review: back(l.review),
    },
  };
}

/** Whether the card is due at `now` (a new card always is). */
export function isDue(card, now = new Date()) {
  return new Date(card.due).getTime() <= new Date(now).getTime();
}

/* ------------------------------- grading --------------------------------- */

/** docs/DATA.md "Grading": exact -> Good, close -> Hard, accepted (the model
 *  check took a valid alternative) -> Good unless its hint says Hard, wrong
 *  (or the matcher's "miss") -> Again. `hint` is the grader's rating_hint.
 *  Unknown verdicts return null so a caller cannot record a made-up rating. */
export function ratingForVerdict(verdict, hint) {
  switch (verdict) {
    case "exact": return RATINGS.good;
    case "close": return RATINGS.hard;
    case "accepted": return String(hint).toLowerCase() === "hard" ? RATINGS.hard : RATINGS.good;
    case "wrong":
    case "miss": return RATINGS.again;
    default: return null;
  }
}

/** docs/DATA.md event table: what a post-session event does to which card. */
const EVENTS = {
  produced: { skill: "produce", rating: RATINGS.good },
  produced_with_help: { skill: "produce", rating: RATINGS.hard },
  corrected: { skill: "produce", rating: RATINGS.again },
  understood: { skill: "listen", rating: RATINGS.good },
  confused: { skill: "listen", rating: RATINGS.again },
};
export const SESSION_EVENT_KINDS = Object.keys(EVENTS);

export function ratingForSessionEvent(kind) {
  const e = Object.hasOwn(EVENTS, kind) ? EVENTS[kind] : null;
  return e ? { ...e } : null;
}

/* -------------------------------- mastery -------------------------------- */

export const BANDS = ["New", "Learning", "Familiar", "Mastered"];
/** Stability (days until recall drops to the target) at which a card moves up.
 *  21 days is Anki's "mature" line. */
export const FAMILIAR_DAYS = 3;
export const MASTERED_DAYS = 21;

export function masteryBand(card) {
  if (card.state === State.New || !card.reps) return "New";
  if (card.stability < FAMILIAR_DAYS) return "Learning";
  if (card.stability < MASTERED_DAYS) return "Familiar";
  return "Mastered";
}

/** A phrase is only as known as its weakest card that exists, so understanding
 *  a phrase you cannot say is not "Mastered". No cards at all is New. */
export function phraseMastery(cards) {
  if (!cards || cards.length === 0) return "New";
  return cards.map(masteryBand).reduce((a, b) => (BANDS.indexOf(b) < BANDS.indexOf(a) ? b : a));
}
