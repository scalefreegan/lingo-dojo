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

/** A DB row (Date or string dates, extra columns ignored) back to card state. */
export function fromRow(row) {
  return {
    due: iso(row.due),
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    scheduled_days: Number(row.scheduled_days),
    learning_steps: Number(row.learning_steps ?? 0),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    state: Number(row.state),
    last_review: iso(row.last_review),
  };
}

/* -------------------------------- review --------------------------------- */

/** Apply a 1-4 rating (Again, Hard, Good, Easy) at `now`. Returns the next card
 *  and a log entry (the review as ts-fsrs saw it, with ISO dates). Reviewing
 *  early or very late is fine: the library measures real elapsed time from
 *  `last_review`, so `due` is a suggestion, not a gate. */
export function review(card, rating, now = new Date()) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new RangeError(`rating must be 1-4, got ${rating}`);
  }
  const out = scheduler.next(toLib(card), new Date(now), rating);
  const l = out.log;
  return {
    card: fromLib(out.card),
    log: {
      rating: l.rating,
      state: l.state,
      due: iso(l.due),
      stability: l.stability,
      difficulty: l.difficulty,
      scheduled_days: l.scheduled_days,
      learning_steps: l.learning_steps,
      review: iso(l.review),
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
