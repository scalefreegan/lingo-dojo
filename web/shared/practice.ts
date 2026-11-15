// The Practice tab's wire types (docs/DATA.md §Practice modes), shared by
// web/server/practice.ts and the page. Kept beside wire.ts rather than in
// it so the practice routes can grow (cloze, listening, speak-it) without
// touching the file every route shares. Times are ISO strings.

import type { MasteryBand } from "./wire.ts";

/** The two flashcard directions: recognize (see the words, give the
 *  meaning) and produce (see the meaning, give the words). */
export type PracticeSkill = "recognize" | "produce";
/** Which cards a session asks: both directions, or one. */
export type PracticeDirection = "mixed" | PracticeSkill;
export type PracticeLength = 5 | 10 | 20;
/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type PracticeRating = 1 | 2 | 3 | 4;
/** How an answer was graded: matched exactly, nearly (an accent, one
 *  letter), accepted by the model check, wrong, or the learner's own grade
 *  (Reveal, or an override). */
export type PracticeVerdict = "exact" | "close" | "accepted" | "wrong" | "self";

/** One card of a session. Both sides travel (it is the learner's own bank);
 *  the page shows one and keeps the other until it is answered. */
export interface PracticeItem {
  phraseId: string;
  skill: PracticeSkill;
  /** "new": never reviewed (its card may not exist yet); "review": due. */
  kind: "new" | "review";
  text: string;
  meaning: string;
  /** The variant the phrase was first met in (BCP-47), "" when unknown. */
  lang: string;
  starred: boolean;
  /** The card's version (reviews and last review time) to answer against. */
  version: string;
  /** The phrase's revision as shown (its words, meaning and alternates): an
   *  edit since makes the answer a 409 before any grading. */
  revision: string;
}

/** What is waiting, and today's progress. The day turns over at 4 a.m. in
 *  the learner's own time (the `tz` the page sends). */
export interface PracticeStats {
  /** Reviewed cards due now (one per phrase). */
  due: number;
  /** Cards never reviewed that could be introduced (one per phrase). */
  new: number;
  /** Today's practice: first reviews of cards, and the other reviews. */
  done: { new: number; reviews: number };
  limits: { new: number; reviews: number };
  left: { new: number; reviews: number };
  /** How many cards a session started now could ask, within the limits. */
  ready: number;
}

/** GET /api/practice?tz= */
export interface PracticeStatsReply {
  stats: PracticeStats;
  /** The language: the bank's target language and variant, and the native one. */
  language: { targetLanguage: string; targetVariant: string; locale: string | null; nativeLanguage: string };
}

/** GET /api/practice/queue?length=&direction=&tz= */
export interface PracticeQueueReply extends PracticeStatsReply {
  items: PracticeItem[];
}

/** POST /api/practice/answer. `reveal` with `rating`: Reveal then the
 *  learner's own grade; otherwise `answer` is graded. `tz`: the browser's
 *  UTC offset in minutes (local minus UTC). */
export interface PracticeAnswerRequest {
  phraseId: string;
  skill: PracticeSkill;
  version: string;
  revision: string;
  /** A uuid the page makes for this answer: a resend of it (double click,
   *  retry) gets the first's review back; any other answer at the same
   *  version is a 409. */
  submitId: string;
  answer?: string;
  reveal?: boolean;
  rating?: PracticeRating;
  durationMs?: number;
  tz?: number;
}

/** An answer as recorded: the review, the card after it, both sides of the
 *  card, and whether this was a repeat of a submit already recorded. */
export interface PracticeAnswerReply {
  review: {
    id: number;
    rating: PracticeRating;
    verdict: PracticeVerdict;
    /** What to check (close), or the grader's sentence (accepted, wrong). */
    note: string | null;
    answer: string | null;
  };
  card: { version: string; due: string; mastery: MasteryBand; state: number; reps: number; lapses: number };
  expected: { text: string; meaning: string };
  /** An answer the grader accepted was kept as another way to say it. */
  alternateAdded: boolean;
  /** This submit repeated one already recorded: nothing new was written. */
  replayed: boolean;
}

/** POST /api/practice/reviews/:id/override */
export interface PracticeOverrideRequest {
  rating: PracticeRating;
  tz?: number;
}
