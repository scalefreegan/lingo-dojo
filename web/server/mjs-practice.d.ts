// Declarations for scripts/practice.mjs (the Practice tab's pure half), in
// a file of its own like mjs-memory.d.ts. It must sort before mjs.d.ts (its
// catch-all `*.mjs`), which "mjs-practice" does.

declare module "*/scripts/practice.mjs" {
  type PracticeItem = import("../shared/practice.ts").PracticeItem;
  type PracticeStats = import("../shared/practice.ts").PracticeStats;
  type PracticeSkill = import("../shared/practice.ts").PracticeSkill;
  type PracticeDirection = import("../shared/practice.ts").PracticeDirection;
  type PracticeVerdict = import("../shared/practice.ts").PracticeVerdict;
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
    cards: { skill: string; due: Date | string; reps: number; state: number; last_review?: Date | string | null }[];
  }

  export const PRACTICE_SKILLS: PracticeSkill[];
  export const DIRECTIONS: PracticeDirection[];
  export const SESSION_LENGTHS: number[];
  export const DEFAULT_LENGTH: number;
  export const DAILY_LIMITS: { new: number; reviews: number };
  export const ROLLOVER_HOUR: number;
  export const MAX_ANSWER: number;
  export const MAX_ALTERNATES: number;
  export const MAX_UTC_OFFSET: number;
  export function dayStart(now: Date | string | number, utcOffsetMinutes?: number, rolloverHour?: number): Date;
  export function readUtcOffset(v: unknown): number;
  export function cardVersion(card: { reps: number; last_review?: Date | string | null } | null | undefined): string;
  export function isVersion(v: unknown): v is string;
  export function practisable(p: { text: string | null; meaning: string | null; suspended?: boolean }): boolean;
  export function remaining(done: { new: number; reviews: number }, limits?: { new: number; reviews: number }): { new: number; reviews: number };
  export function readLength(v: unknown): number;
  export function readDirection(v: unknown): PracticeDirection;
  export function buildQueue(
    phrases: CandidatePhrase[],
    opts: { now: Date; done?: { new: number; reviews: number }; length?: number; direction?: PracticeDirection; limits?: { new: number; reviews: number } },
  ): { items: PracticeItem[]; stats: PracticeStats };
  export interface AnswerInput {
    phraseId: string;
    skill: PracticeSkill;
    version: string;
    answer: string;
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
  }): { verdict: "exact" | "close" | "miss"; note?: string };
  export function graderQuestion(input: { skill: PracticeSkill; text: string; meaning: string }): { question: string; expected: string; kind: "target" | "meaning" };
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
