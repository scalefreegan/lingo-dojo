// The Practice tab's wire types (docs/DATA.md §Practice modes), shared by
// web/server/practice.ts and the page. Kept beside wire.ts rather than in
// it so the practice routes can grow (cloze, listening, speak-it) without
// touching the file every route shares. Times are ISO strings.

import type { MasteryBand } from "./wire.ts";

/** The skills a card exercises: recognize (see the words, give the
 *  meaning), produce (see the meaning, give the words) and listen (hear the
 *  words, give the meaning). */
export type PracticeSkill = "recognize" | "produce" | "listen";
/** How a card is asked, named as reviews.mode names it: typed flashcards
 *  (recognize or produce), the listening drill (listen), speak-it
 *  (produce, said aloud) and cloze (produce, a gap in a sentence filled by
 *  typing or saying the words). */
export type PracticeDrill = "flashcard" | "listening" | "speak" | "cloze";
/** The Practice tab's mode picker: flashcards, listening, speak-it, fill
 *  the gap (cloze), or a mix (recognize as a flashcard, listen by ear,
 *  produce aloud or, for a phrase with a sentence, every other time as a
 *  gap). */
export type PracticeMode = "flashcards" | "listening" | "speak" | "cloze" | "mixed";

/** A cloze card's sentence, around the gap. The gap's words never travel
 *  before the answer: not in `before`/`after`, not in the item's `text`. */
export interface PracticeCloze {
  /** The cloze item: the answer names it, so a sentence changed or
   *  flagged since is refused rather than graded. */
  id: string;
  before: string;
  after: string;
  /** "example": a line of the dojo master's from one of your sessions;
   *  "generated": written for practice. */
  origin: "example" | "generated";
}
/** A flashcard's example: the phrase used in a sentence, whole, its words
 *  (`blank`) to be marked. The same sentence store as cloze, so it is one
 *  of your own session lines when one fits, else one written for practice.
 *  It holds the card's words, so the page shows it only on the answer side
 *  (revealed or answered), never with the prompt. */
export interface PracticeSentence {
  /** The cloze item: POST /api/practice/cloze/:id/flag flags it. */
  id: string;
  before: string;
  blank: string;
  after: string;
  origin: "example" | "generated";
  /** What the sentence means, in the learner's native language: written
   *  with a generated sentence, or the session's own gloss of the line.
   *  Null for none (sentences from before it was kept, a line the session
   *  glossed only word by word). Shown with the sentence, so only after
   *  the answer. */
  translation: string | null;
}
/** Which flashcards a flashcard session asks: both directions, or one. */
export type PracticeDirection = "mixed" | "recognize" | "produce";
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
  drill: PracticeDrill;
  /** "new": never reviewed (its card may not exist yet); "review": due. */
  kind: "new" | "review";
  /** The words; "" on a listening card (heard, not read: they come with
   *  the answer's reply) and on a cloze card (they are the gap). */
  text: string;
  /** Mandarin: the dojo master's stored reading for `text`
   *  (phrases.reading), shown instead of the reader's; only with `text`. */
  reading?: string;
  /** The meaning; "" on a listening card (it is among `choices`). On a
   *  cloze card it is the hint for the gap. */
  meaning: string;
  /** A listening card's meanings to pick from (the right one among them),
   *  or null: the bank had too few others, so the answer is typed. */
  choices: string[] | null;
  /** A cloze card's sentence; null on every other drill. */
  cloze: PracticeCloze | null;
  /** A flashcard's phrase used in a sentence, for its answer side; null
   *  on every other drill, and for a phrase with none yet (a started
   *  flashcards session has one written for its next session). */
  sentence: PracticeSentence | null;
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
  /** Why the drills that need a voice can't run here, or null for each when
   *  they can: `audio` (listening: no voice picked for the language, no
   *  key) and `speech` (speak-it: no speech-to-text key). GET /api/practice
   *  checks; the queue reply sends null (not checked). */
  setup: { audio: string | null; speech: string | null } | null;
  /** The cloze and mixed modes: `waiting`, the cloze mode's phrases left
   *  out because they have no sentence yet; `writing`, whether a call is
   *  writing some now (the counts may be asked again; only starting a
   *  session writes more); `writable`, whether sentences are written for
   *  this language at all (not for one whose words take endings: only
   *  the learner's own session lines); `limited`, today's calls for this
   *  language are used up. Null in the other modes. */
  cloze: { waiting: number; writing: boolean; writable: boolean; limited: boolean } | null;
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
  /** The drill (the review's mode); flashcard when left out. */
  drill?: PracticeDrill;
  version: string;
  revision: string;
  /** A uuid the page makes for this answer: a resend of it (double click,
   *  retry) gets the first's review back; any other answer at the same
   *  version is a 409. */
  submitId: string;
  /** Typed, or (speak) what the recogniser heard: never empty there. */
  answer?: string;
  /** A listening card's picked meaning, instead of `answer`. */
  choice?: string;
  /** A cloze answer: the sentence it was shown (PracticeCloze.id). */
  clozeId?: string;
  /** A cloze answer said aloud: `answer` is the transcript (never empty). */
  spoken?: boolean;
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
  expected: { text: string; meaning: string; reading?: string };
  /** A cloze answer's sentence with its gap's words: the page shows it
   *  whole once answered. Null for the other drills. */
  cloze: { before: string; blank: string; after: string } | null;
  /** An answer the grader accepted was kept as another way to say it. */
  alternateAdded: boolean;
  /** This submit repeated one already recorded: nothing new was written. */
  replayed: boolean;
}

/** POST /api/practice/transcribe (a speak-it recording): what was heard,
 *  "" when nothing was (the page asks to record again; nothing is saved). */
export interface PracticeTranscribeReply {
  text: string;
}

/** POST /api/practice/cloze/:id/flag: the sentence is never shown again. */
export interface PracticeFlagReply {
  flagged: true;
}

/** POST /api/practice/reviews/:id/override */
export interface PracticeOverrideRequest {
  rating: PracticeRating;
  tz?: number;
}
