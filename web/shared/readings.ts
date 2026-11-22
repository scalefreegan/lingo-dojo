// The wire shapes of the Mandarin readings routes (web/server/readings.ts,
// docs/DATA.md §Reading corrections and §Shared readings, bead ld-4i2).

/** One of the shared list's active entries, as every browser gets it:
 *  words and readings only. */
export interface SharedReadingEntry {
  word: string;
  /** The word's simplified spelling (zh.ts correctionKey). */
  key: string;
  /** One tone-marked syllable per character, space separated. */
  reading: string;
  scope: "all" | "tw";
}

/** GET /api/readings/shared (ETag: the version). */
export interface SharedReadingsReply {
  version: string;
  entries: SharedReadingEntry[];
}

/** One of the active language's own readings. */
export interface MyReading {
  word: string;
  reading: string;
  /** corrected / confirmed: the learner's by hand (or the recap agreeing:
   *  confirmed); suggested: the recap's, still to check. */
  kind: "corrected" | "confirmed" | "suggested";
  /** user: by hand (ranks as the learner's own); recap: the recap's (a
   *  suggestion, or its agreement with the reader, which only clears the
   *  mark). */
  source: "user" | "recap";
}

/** GET /api/readings */
export interface MyReadingsReply {
  readings: MyReading[];
}

/** A bank word waiting for a pronunciation check (ld-0mn): a kids
 *  learner's word whose reading is still uncertain, kept out of the game
 *  until it is settled. `text` is the bank phrase it is in, `at` its UTF-16
 *  offset there, `reading` what the reader shows now. */
export interface WaitingWord {
  word: string;
  reading: string[];
  text: string;
  at: number;
  phraseId: string;
}

/** A word whose reading a model settled for a kids learner (ld-0mn): the
 *  grown-up sees it and may confirm it, correct it, or send it back to
 *  waiting (POST /api/readings/back). */
export interface CheckedWord {
  word: string;
  /** One tone-marked syllable per character, space separated. */
  reading: string;
  /** session: the background check during a session; recap: the recap. */
  by: "session" | "recap";
  /** When it was settled (ISO). */
  at: string;
}

/** GET /api/readings/waiting: a kids learner's (an adult's is empty). */
export interface WaitingWordsReply {
  words: WaitingWord[];
  checked: CheckedWord[];
}

/** POST /api/readings */
export interface ReadingSaveRequest {
  word: string;
  /** One tone-marked syllable per character, space separated. */
  reading: string;
  /** corrected: "This reading is wrong" and the learner's choice;
   *  confirmed: "This is right". */
  kind: "corrected" | "confirmed";
}

export interface ReadingSaveReply {
  reading: MyReading;
  /** What the shared list made of it: active (an admin's, or two users'
   *  with one chosen by hand), suggested, limited (this user's votes for
   *  the day are used up: kept for them, not sent), or null (a
   *  confirmation of the reader's own reading, not sent). */
  shared: "active" | "suggested" | "limited" | null;
  /** Bank phrases of this language whose stored reading changed. */
  phrases: number;
}

/** One row of the admin view. */
export interface SharedReadingAdminRow extends SharedReadingEntry {
  id: string;
  status: "active" | "suggested";
  source: "admin" | "user" | "recap";
  byUser: boolean;
  byRecap: boolean;
  /** How many different users stand behind it (a recap counts as its
   *  session owner's): two activate a suggestion. */
  votes: number;
  /** Usernames, for the admin only. */
  suggestedBy: string | null;
  confirmedBy: string | null;
  updatedAt: string;
}

/** GET /api/readings/admin */
export interface SharedReadingsAdminReply {
  rows: SharedReadingAdminRow[];
  /** Readings the active list changed in the sessions recapped in the
   *  last 30 days, and how many such sessions. */
  changed30d: { changed: number; sessions: number };
}
