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
    /** Its usable cloze sentences (the cloze and mixed modes, and a
     *  started flashcards session). */
    cloze?: { id: string; sentence: string; blankStart: number; blankEnd: number; origin: "example" | "generated" }[];
    /** No sentence yet, and one is worth a model call. */
    clozeNeeded?: boolean;
  }
  export function produceDrill(phrase: CandidatePhrase, card: { reps: number } | null | undefined): "cloze" | "speak";

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
  ): { items: PracticeItem[]; stats: PracticeStats; clozeWanted: CandidatePhrase[]; clozeWaiting: number };
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
    /** A cloze answer's sentence (a uuid), null for the other drills. */
    clozeId: string | null;
    /** The answer is a transcript (speak-it, or a cloze said aloud). */
    spoken: boolean;
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
  export function graderQuestion(input: { skill: PracticeSkill; text: string; meaning: string; drill?: PracticeDrill; spoken?: boolean; gapped?: string | null; full?: string | null }): {
    question: string;
    expected: string;
    kind: "target" | "meaning";
    heard?: boolean;
    spoken?: boolean;
    gapped?: string;
    full?: string;
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

declare module "*/scripts/cloze.mjs" {
  type Level = { words: number; chars: number };
  type Checked = { sentence: string; start: number; end: number; reason?: undefined } | { reason: string; sentence?: undefined; start?: undefined; end?: undefined };
  export const CLOZE_BATCH: number;
  export const SENTENCES_PER_PHRASE: number;
  export const MAX_GENERATED: number;
  export const MAX_BLANK_WORDS: number;
  export const MAX_BLANK_CHARS: number;
  export const MIN_CONTEXT_WORDS: number;
  export const MIN_CONTEXT_CHARS: number;
  export const LEVEL_MAX: Record<"A1" | "A2" | "B1" | "B2" | "C1" | "C2", Level>;
  export const EXAMPLE_MAX: Level;
  export const CLOZE_DAILY_CALLS: number;
  export const TRIED_DAYS: number;
  export const CLOZE_RULES_SINCE: string;
  export const UNWRITTEN: Set<string>;
  export function triedStill(createdAt: Date | string, now: Date | string): boolean;
  export function clozeWritable(locale: string | null | undefined): boolean;
  export function wrongLanguage(sentence: string, blank: { start: number; end: number }, opts: { meaning: string; nativeLanguage: string; locale: string | null | undefined }): string | null;
  export function cefr(level: unknown): "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
  export function clozeKey(phrase: { text: string | null; meaning: string | null } | null | undefined): string;
  export function scriptsFor(locale: string | null | undefined, text: string | null | undefined): string[];
  export function inScripts(sentence: string, scripts: string[]): boolean;
  export function blankCore(text: unknown): string;
  export function findBlank(sentence: string, text: string, locale: string | null | undefined): { start: number; end: number } | null;
  export function clozeable(text: string, locale: string | null | undefined): boolean;
  export function checkSentence(raw: unknown, opts: { text: string; locale: string | null | undefined; max: Level; maxChars?: number }): Checked;
  export function checkExample(
    example: { sentence: string },
    turn: { role: string; fromClient: boolean; lines: unknown } | null,
    opts: { text: string; locale: string | null | undefined; level: string },
  ): Checked;
  export function clozePrompt(opts: { phrases: { text: string; meaning: string }[]; targetVariant: string; nativeLanguage: string; level: string; locale: string }): { system: string; user: string };
  export function parseClozeReply(
    text: unknown,
    opts: { phrases: { text: string; meaning?: string }[]; locale: string; level: string; nativeLanguage?: string },
  ): { ok: true; sentences: { sentence: string; start: number; end: number }[][]; dropped: number; error?: undefined } | { ok: false; error: string };
  export function pickCloze<T extends { id: string; origin: string }>(items: T[] | null | undefined, seed: string): T | null;
  export function pickSentence<T extends { id: string; origin: string }>(items: T[] | null | undefined, seed: string): T | null;
  export function clozeView(item: { id: string; sentence: string; blankStart: number; blankEnd: number; origin: "example" | "generated" }): {
    id: string;
    before: string;
    after: string;
    origin: "example" | "generated";
  };
  export function sentenceView(item: { id: string; sentence: string; blankStart: number; blankEnd: number; origin: "example" | "generated" }): {
    id: string;
    before: string;
    blank: string;
    after: string;
    origin: "example" | "generated";
  };
  export function gapped(item: { sentence: string | null; blankStart: number | null; blankEnd: number | null }): string;
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
