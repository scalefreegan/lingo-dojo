// Declarations for scripts/practice.mjs (the Practice tab's pure half), in
// a file of its own like mjs-memory.d.ts. It must sort before mjs.d.ts (its
// catch-all `*.mjs`), which "mjs-practice" does.

declare module "*/scripts/practice.mjs" {
  type PracticeItem = import("../shared/practice.ts").PracticeItem;
  type PracticeStats = import("../shared/practice.ts").PracticeStats;
  type PracticeSkill = import("../shared/practice.ts").PracticeSkill;
  type PracticeDirection = import("../shared/practice.ts").PracticeDirection;
  type PracticeVerdict = import("../shared/practice.ts").PracticeVerdict;
  type PracticeDrill = import("../shared/practice.ts").PracticeDrill;
  type PracticeMode = import("../shared/practice.ts").PracticeMode;
  type Rating = 1 | 2 | 3 | 4;

  /** A phrase with its cards, as the queue reads it. */
  export interface CandidatePhrase {
    id: string;
    text: string | null;
    meaning: string | null;
    lang?: string;
    starred?: boolean;
    suspended?: boolean;
    lastSeenAt?: Date | string | null;
    createdAt?: Date | string | null;
    alternates?: string[];
    cards: { skill: string; due: Date | string; reps: number; state: number; last_review?: Date | string | null }[];
  }

  export const PRACTICE_SKILLS: PracticeSkill[];
  export const DIRECTIONS: PracticeDirection[];
  export const DRILLS: PracticeDrill[];
  export const DRILL_SKILLS: Record<PracticeDrill, PracticeSkill[]>;
  export const PRACTICE_MODES: PracticeMode[];
  export const CHOICES: number;
  export function drillsFor(mode?: PracticeMode, direction?: PracticeDirection): [PracticeSkill, PracticeDrill][];
  export function readMode(v: unknown): PracticeMode;
  export function listenChoices(phrase: CandidatePhrase, bank: CandidatePhrase[], opts?: { nativeLocale?: string; seed?: string; rand?: () => number }): string[] | null;
  export function offeredChoices(phrase: CandidatePhrase, bank: CandidatePhrase[], opts: { version: string; nativeLocale?: string }): string[] | null;
  export function sameChoice(meaning: string | null | undefined, pick: string): boolean;
  export function seededRand(seed: string): () => number;
  export function choiceSeed(phraseId: string, version: string, revision: string): string;
  export const SESSION_LENGTHS: number[];
  export const DEFAULT_LENGTH: number;
  export const DAILY_LIMITS: { new: number; reviews: number };
  export const ROLLOVER_HOUR: number;
  export const MAX_ANSWER: number;
  export const MAX_ALTERNATES: number;
  export const MAX_UTC_OFFSET: number;
  export function dayStart(now: Date | string | number, utcOffsetMinutes?: number, rolloverHour?: number): Date;
  export function readUtcOffset(v: unknown): number;
  export function phraseRevision(phrase: { text: string | null; meaning: string | null; alternates?: unknown }): string;
  export const ALTERNATE_RATIO: number;
  export const ALTERNATE_SLACK: number;
  export function keepable(answer: unknown, text?: string): boolean;
  export function cardVersion(card: { reps: number; last_review?: Date | string | null } | null | undefined): string;
  export function isVersion(v: unknown): v is string;
  export function practisable(p: { text: string | null; meaning: string | null; suspended?: boolean }): boolean;
  export function remaining(done: { new: number; reviews: number }, limits?: { new: number; reviews: number }): { new: number; reviews: number };
  export function readLength(v: unknown): number;
  export function readDirection(v: unknown): PracticeDirection;
  export function buildQueue(
    phrases: CandidatePhrase[],
    opts: {
      now: Date;
      done?: { new: number; reviews: number };
      length?: number;
      direction?: PracticeDirection;
      mode?: PracticeMode;
      limits?: { new: number; reviews: number };
      nativeLocale?: string;
    },
  ): { items: PracticeItem[]; stats: PracticeStats };
  export interface AnswerInput {
    phraseId: string;
    skill: PracticeSkill;
    drill: PracticeDrill;
    version: string;
    revision: string;
    submitId: string;
    /** The typed answer, the transcript (speak), or the picked choice. */
    answer: string;
    /** `answer` is a listening card's picked choice. */
    choice: boolean;
    reveal: boolean;
    rating: Rating | null;
    durationMs: number | null;
    utcOffsetMinutes: number;
  }
  export function readAnswerInput(body: unknown): { value: AnswerInput; error?: undefined } | { error: string; value?: undefined };
  export function readOverrideInput(body: unknown): { value: { rating: Rating; utcOffsetMinutes: number }; error?: undefined } | { error: string; value?: undefined };
  export function localMatch(input: {
    skill: PracticeSkill;
    answer: string;
    text: string;
    meaning: string;
    alternates?: string[];
    targetLocale?: string;
    nativeLocale?: string;
    spoken?: boolean;
  }): { verdict: "exact" | "close" | "miss"; note?: string };
  export function listenMatch(input: {
    answer: string;
    text: string;
    meaning: string;
    alternates?: string[];
    targetLocale?: string;
    nativeLocale?: string;
  }): { verdict: "exact" | "close" | "miss"; note?: string; as: "words" | "meaning" };
  export function choiceMatch(input: { choice: string; meaning: string; nativeLocale?: string }): { verdict: "exact" | "miss" };
  export function graderQuestion(input: { skill: PracticeSkill; text: string; meaning: string; drill?: PracticeDrill }): {
    question: string;
    expected: string;
    kind: "target" | "meaning";
    heard?: boolean;
    spoken?: boolean;
  };
  export interface Outcome {
    verdict: PracticeVerdict;
    rating: Rating;
    note: string | null;
  }
  export function gradeOutcome(input: {
    reveal?: boolean;
    rating?: Rating | null;
    match?: { verdict: string; note?: string } | null;
    grader?: { accepted: boolean; rating_hint: string; note: string } | null;
    graderFailed?: boolean;
    answer?: string;
  }): Outcome;
  export function needsGrader(match: { verdict: string } | null | undefined, answer: unknown): boolean;
  export function withAlternate(alternates: unknown, answer: string, opts?: { text?: string; lang?: string }): string[];
  export function withoutAlternate(alternates: unknown, answer: string, lang?: string): string[];
}

declare module "*/scripts/audio-cache.mjs" {
  export const DEFAULT_CACHE_MB: number;
  export function audioDir(env?: Record<string, string | undefined>): string;
  export function cacheLimitBytes(env?: Record<string, string | undefined>): number;
  export function audioKey(input: { owner?: string; provider: string; voice: string; model?: string; format?: string; locale?: string; speed?: number; text: string }): string;
  export function readCached(key: string, opts?: { dir?: string }): { audio: Buffer; type: string } | null;
  export function writeCached(key: string, audio: Buffer | Uint8Array, type: string, opts?: { dir?: string; limit?: number }): boolean;
  export function evict(opts?: { dir?: string; limit?: number; keep?: string | null; now?: number }): string[];
  export function cachedAudio(
    key: string,
    make: () => Promise<{ audio: Buffer; type: string }>,
    opts?: { dir?: string; limit?: number },
  ): Promise<{ audio: Buffer; type: string; cached: boolean }>;
}
