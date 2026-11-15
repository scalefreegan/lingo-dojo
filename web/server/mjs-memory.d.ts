// Declarations for the pure memory modules (scripts/fsrs.mjs, match.mjs, phrases.mjs,
// extraction.mjs, json-reply.mjs). Same pattern as mjs.d.ts, in its own file so
// the two can change independently. The catch-all `*.mjs` in mjs.d.ts is
// declared in a file that sorts after this one, so these specific patterns
// win the tie; if a type here ever shows as `any`, check that order first.

declare module "*/scripts/fsrs.mjs" {
  export type Skill = "recognize" | "listen" | "produce";
  /** 1 Again, 2 Hard, 3 Good, 4 Easy. */
  export type Rating = 1 | 2 | 3 | 4;
  export type MasteryBand = "New" | "Learning" | "Familiar" | "Mastered";
  /** The ts-fsrs Card with dates as ISO-8601 strings. `state`: 0 New, 1 Learning,
   *  2 Review, 3 Relearning. */
  export interface CardState {
    due: string;
    stability: number;
    difficulty: number;
    scheduled_days: number;
    learning_steps: number;
    reps: number;
    lapses: number;
    state: number;
    last_review: string | null;
  }
  /** CardState with Date objects, the shape of a timestamptz column. */
  export type CardRow = Omit<CardState, "due" | "last_review"> & { due: Date; last_review: Date | null };
  export interface ReviewLog {
    rating: Rating;
    state: number;
    due: string;
    stability: number;
    difficulty: number;
    scheduled_days: number;
    learning_steps: number;
    review: string;
  }
  export type EventKind = "produced" | "produced_with_help" | "corrected" | "understood" | "confused";
  export const SKILLS: Skill[];
  export const RATINGS: { again: 1; hard: 2; good: 3; easy: 4 };
  export const SESSION_EVENT_KINDS: EventKind[];
  export const BANDS: MasteryBand[];
  export const FAMILIAR_DAYS: number;
  export const MASTERED_DAYS: number;
  export function newCard(now?: Date | string | number): CardState;
  export function toRow(card: CardState): CardRow;
  export function fromRow(row: {
    due: Date | string;
    stability: number | string;
    difficulty: number | string;
    scheduled_days: number | string;
    learning_steps: number | string;
    reps: number | string;
    lapses: number | string;
    state: number | string;
    last_review?: Date | string | null;
  }): CardState;
  export function review(card: CardState, rating: Rating, now?: Date | string | number, opts?: { utcOffsetMinutes?: number; rolloverHour?: number }): { card: CardState; log: ReviewLog };
  export function isDue(card: CardState, now?: Date | string | number): boolean;
  export function ratingForVerdict(verdict: string, hint?: string): Rating | null;
  export function ratingForSessionEvent(kind: string): { skill: Skill; rating: Rating } | null;
  export function masteryBand(card: CardState): MasteryBand;
  export function phraseMastery(cards: CardState[] | undefined): MasteryBand;
}

declare module "*/scripts/match.mjs" {
  export type Verdict = "exact" | "close" | "miss";
  export const MIN_TYPO_LENGTH: number;
  export function normKey(text: unknown): string;
  export function normalizeAnswer(text: unknown, lang?: string): string;
  export function stripAccents(text: string): string;
  export function matchAnswer(input: {
    answer: string | null | undefined;
    expected: string;
    alternates?: string[];
    lang?: string;
    spoken?: boolean;
  }): { verdict: Verdict; note?: string };
  export function graderPrompt(input: {
    question: string;
    expected: string;
    answer: string;
    nativeLanguage: string;
    targetVariant: string;
    kind?: "target" | "meaning";
  }): string;
  export function parseGraderReply(text: unknown): { accepted: boolean; rating_hint: "good" | "hard"; note: string } | null;
}

declare module "*/scripts/extraction.mjs" {
  type EventKind = import("*/scripts/fsrs.mjs").EventKind;
  export interface KeepItem { text: string; meaning: string; example: string; why: string }
  export interface EventItem { phrase: string; kind: EventKind; said?: string; note?: string }
  export interface CorrectionItem { said: string; better: string; note: string }
  export interface Extraction { summary: string; keep: KeepItem[]; events: EventItem[]; corrections: CorrectionItem[] }
  export const LIMITS: Record<"summary" | "keep" | "events" | "corrections" | "text" | "meaning" | "example" | "why" | "note", number>;
  export function extractionPrompt(input: {
    transcript: string | { role?: string; speaker?: string; text: string }[];
    nativeLanguage: string;
    targetVariant: string;
    duePhrases?: (string | { text: string; meaning?: string })[];
  }): { system: string; user: string };
  export function parseExtraction(text: unknown): { ok: true; value: Extraction; dropped: number } | { ok: false; error: string };
}

declare module "*/scripts/phrases.mjs" {
  type PhraseSummary = import("../shared/wire.ts").PhraseSummary;
  type MasteryBand = import("*/scripts/fsrs.mjs").MasteryBand;
  type CardInput = Parameters<typeof import("*/scripts/fsrs.mjs").fromRow>[0];
  /** A target form to put in the bank, with its match key. */
  export interface Capture {
    text: string;
    norm: string;
    meaning: string | null;
    meaningNorm: string | null;
  }
  export interface Example {
    sentence: string;
    speaker: string | null;
  }
  export const LIMITS: { text: number; meaning: number; note: number; sentence: number };
  export const MAX_EXAMPLES: number;
  export const TROUBLE_LAPSES: number;
  export const TROUBLE_DAYS: number;
  export const MAX_CAPTURE_WORDS: number;
  export const MAX_CAPTURE_CHARS: number;
  export function clean(s: unknown): string;
  export function unspaced(locale: unknown): boolean;
  export function charCount(text: unknown): number;
  export function tooLongToCapture(text: unknown, locale?: string | null): boolean;
  export const SHOWS: import("../shared/wire.ts").PhraseShow[];
  export const SORTS: import("../shared/wire.ts").PhraseSort[];
  export function wordCount(text: unknown, locale?: string | null): number;
  export function sameLanguage(profileLanguage: unknown, session: { language?: unknown; variant?: unknown } | null | undefined): boolean;
  export function exampleFor(term: unknown, lines: unknown[] | null | undefined, locale?: string | null): Example | null;
  export function glossCaptures(
    glosses: { term?: unknown; meaning?: unknown }[] | null | undefined,
    lines: unknown[] | null | undefined,
    locale?: string | null,
  ): (Capture & { example: Example | null })[];
  export function scenarioEntries(
    scenario: { language?: string | null; vocab?: unknown; phrases?: unknown } | null | undefined,
    sessionLocale?: string | null,
  ): { complete: Capture[]; pending: { meaning: string; meaningNorm: string }[] };
  export function readPhraseInput(
    body: unknown,
    opts?: { create?: boolean },
  ): { value: import("../shared/wire.ts").PhraseInput & { text?: string }; error?: undefined } | { error: string; value?: undefined };
  export function phraseMetrics(cards?: CardInput[], lapses?: number): { mastery: MasteryBand; due: string | null; newCards: number; lapses: number; trouble: boolean; cardCount: number };
  export function isDueNow(p: PhraseSummary, now: Date | string | number): boolean;
  export function isNew(p: PhraseSummary): boolean;
  export function bankPage(
    items: PhraseSummary[],
    query?: { q?: string; show?: string; band?: string; sort?: string; offset?: number; limit?: number },
    now?: Date,
  ): Omit<import("../shared/wire.ts").PhrasesReply, "language">;
}

declare module "*/scripts/json-reply.mjs" {
  export function extractJsonObject(text: unknown): Record<string, unknown> | null;
}
