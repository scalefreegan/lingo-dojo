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
    heard?: boolean;
    spoken?: boolean;
    /** A cloze answer: the sentence shown, its gap as "___". */
    gapped?: string | null;
    /** A cloze answer: the sentence as written, the expected answer in it. */
    full?: string | null;
  }): string;
  export function parseGraderReply(text: unknown, opts?: { strict?: boolean }): { accepted: boolean; rating_hint: "good" | "hard"; note: string } | null;
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
    duePhrases?: (string | { text: string; meaning?: string | null })[];
    /** The phrases are the review block the session offered (not just due). */
    offered?: boolean;
    kids?: boolean;
    /** revisit.mjs lastTimeSection: last attempt's corrections to judge. */
    lastTime?: string;
  }): { system: string; user: string };
  export function parseExtraction(text: unknown): { ok: true; value: Extraction; dropped: number } | { ok: false; error: string };
  /** A stored turn as the extraction helpers read it. */
  export interface StoredTurn {
    id?: string;
    role: "learner" | "master";
    text?: string | null;
    lines?: { text?: string; segments?: unknown[]; speaker?: string }[] | null;
    fromClient?: boolean;
  }
  export const MAX_TRANSCRIPT_CHARS: number;
  export const MAX_KEEP_WORDS: number;
  export const MAX_KEEP_CHARS: number;
  export function learnerSpoke(turns: StoredTurn[] | null | undefined): boolean;
  export function sessionTranscript(turns: StoredTurn[] | null | undefined, max?: number): string;
  export interface PlannedKeep { text: string; norm: string; meaning: string; meaningNorm: string | null; why: string }
  export interface PlannedEvent {
    norm: string;
    phrase: string;
    kind: EventKind;
    skill: import("*/scripts/fsrs.mjs").Skill;
    rating: import("*/scripts/fsrs.mjs").Rating;
    said: string | null;
    note: string | null;
  }
  export function planExtraction(
    value: Extraction,
    opts: { known: Set<string>; locale?: string | null },
  ): { keep: PlannedKeep[]; events: PlannedEvent[]; dropped: number };
  export function keepExample(
    text: string,
    turns: StoredTurn[] | null | undefined,
    locale?: string | null,
  ): { sentence: string; speaker: string | null; turnId: string | undefined } | null;
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
  export function modelText(v: unknown): string;
  export function isUuid(v: unknown): v is string;
  export function unspaced(locale: unknown): boolean;
  export function charCount(text: unknown): number;
  export function tooLongToCapture(text: unknown, locale?: string | null): boolean;
  export const SHOWS: import("../shared/wire.ts").PhraseShow[];
  export const SORTS: import("../shared/wire.ts").PhraseSort[];
  export function wordCount(text: unknown, locale?: string | null): number;
  export function sameLanguage(profileLanguage: unknown, session: { language?: unknown; variant?: unknown } | null | undefined): boolean;
  export function bankLocale(profileLanguage: unknown, conv: { targetLanguage?: string | null; targetVariant?: string | null }): string | null;
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
  export function phraseMetrics(cards?: CardInput[], lapses?: number): { mastery: MasteryBand; due: string | null; lapses: number; trouble: boolean; cardCount: number };
  export function isDueNow(p: PhraseSummary, now: Date | string | number): boolean;
  export function isNew(p: PhraseSummary): boolean;
  export function bankPage(
    items: PhraseSummary[],
    query?: { q?: string; show?: string; band?: string; sort?: string; offset?: number; limit?: number },
    now?: Date,
  ): Omit<import("../shared/wire.ts").PhrasesReply, "language">;
}

declare module "*/scripts/recall.mjs" {
  type PhraseSummary = import("../shared/wire.ts").PhraseSummary;
  type RecallItem = import("../shared/wire.ts").RecallItem;
  type Mode = import("../shared/wire.ts").Mode;
  type When = Date | string | number;
  export const REVIEW_MAX: { adult: number; kids: number };
  export const RETRIEVAL_MAX: { adult: number; kids: number };
  export const RETRIEVAL_THRESHOLD: number;
  export const LOOKUP_MAX: { phrases: number; conversations: number };
  export const BANK_OPEN: string;
  export const BANK_CLOSE: string;
  export const LOOKUP_OPEN: string;
  export const LOOKUP_CLOSE: string;
  export function fold(s: string): string;
  export function words(s: string): string[];
  export function grams(s: string): Set<string>;
  export function containment(needle: Set<string>, hay: Set<string>): number;
  export function bankText(s: string, max: number): string;
  export function scenarioText(scenario: unknown): string;
  export function needle(s: string): { grams: Set<string>; words: string[]; letters: number; whole: boolean };
  export function selectReview(bank: PhraseSummary[], opts: { scenario?: unknown; mode?: Mode; now: When; max?: number }): RecallItem[];
  export function reviewFromIds(bank: PhraseSummary[], ids: string[]): RecallItem[];
  export function storedReviewIds(snapshot: unknown): string[] | null;
  export const FRESH_MARK: string;
  export function renderReview(items: { text: string; meaning?: string | null; fresh?: boolean }[] | undefined): string;
  export function spokenPart(message: string): string;
  /** What matching needs of a phrase (a PhraseSummary has it all). */
  type Matchable = Pick<PhraseSummary, "id" | "text" | "meaning" | "note" | "pending" | "suspended" | "lastSeenAt" | "createdAt">;
  export function retrieve<P extends Matchable>(bank: P[], opts: { message?: string; lastLine?: string; mode?: Mode; max?: number }): P[];
  export function retrievalBlock(hits: PhraseSummary[], now: When): string;
  export interface PastSession {
    id: string;
    title: string | null;
    startedAt: When;
    summary: string | null;
  }
  export function lookupWindow(query: string, now: When): [number, number] | null;
  export function lookupTerms(query: string): string[];
  export function searchLookup<P extends Matchable, C extends PastSession>(
    rows: { phrases?: P[]; conversations?: C[] },
    query: string,
    now: When,
  ): { phrases: P[]; conversations: C[] };
  export function lookupBlock(query: string, results: { phrases?: PhraseSummary[]; conversations?: PastSession[] }, now: When, opts?: { elsewhere?: boolean }): string;
  export function lookupRecord(
    query: string,
    results: { phrases?: { id: string }[]; conversations?: { id: string }[] },
    opts?: { ms?: number | null; repeated?: boolean; elsewhere?: boolean },
  ): { query: string; phraseIds: string[]; conversationIds: string[]; ms?: number; repeated?: true; skipped?: string };
}

declare module "*/scripts/json-reply.mjs" {
  export function extractJsonObject(text: unknown): Record<string, unknown> | null;
}
