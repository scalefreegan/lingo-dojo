// Declarations for the pronunciation engine (scripts/pronunciation.mjs) and
// its app half (scripts/pronunciation-app.mjs), in a file of its own like
// mjs-practice.d.ts. It must sort before mjs.d.ts (its catch-all `*.mjs`),
// which "mjs-pronunciation" does. Only what the server imports.

declare module "*/scripts/pronunciation.mjs" {
  /** One expected syllable (expectedSyllables). */
  export interface ExpectedSyllable {
    char: string;
    pinyin: string;
    baseTone: number;
    expectedTone: number;
    accept: number[];
    half: boolean;
    breakBefore: boolean;
  }
  /** One scored syllable, either engine. */
  export interface ScoredSyllable {
    char: string;
    pinyin: string;
    baseTone: number;
    expectedTone: number;
    accept: number[];
    heardTone: number | null;
    verdict: "ok" | "off" | "unsure";
    confidence: number;
    reason?: string;
    score?: number;
    startMs: number | null;
    endMs: number | null;
    pitch: (number | null)[];
  }
  export interface ScoreResult {
    provider: "azure" | "local";
    syllables: ScoredSyllable[];
    overall?: number;
  }
  /** An Azure reply, parsed (azurePronunciationResult). */
  export interface AzureAssessment {
    status: string;
    text: string;
    overall: number | null;
    words: unknown[];
  }
  export function scoresTones(locale: unknown): boolean;
  export function azureRegionValid(region: unknown): boolean;
  export function parseWav(buffer: Uint8Array | ArrayBuffer): { sampleRate: number; samples: Float32Array };
  export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array;
  export function azurePronunciationRequest(input: {
    key: string;
    region: string;
    endpoint?: string;
    audio: Uint8Array;
    locale: string;
    referenceText: string;
    scripted?: boolean;
  }): { url: string; init: RequestInit };
  export function azurePronunciationResult(json: unknown): AzureAssessment;
}

declare module "*/scripts/pronunciation-app.mjs" {
  type ExpectedSyllable = import("../../scripts/pronunciation.mjs").ExpectedSyllable;
  type ScoreResult = import("../../scripts/pronunciation.mjs").ScoreResult;
  type AzureAssessment = import("../../scripts/pronunciation.mjs").AzureAssessment;
  type Reply = import("../shared/wire.ts").PronunciationScoreReply;
  export const SCORE_MAX_CHARS: number;
  export const SCORE_MAX_SECONDS: number;
  export const SCORE_MAX_BYTES: number;
  export const AZURE_PER_MINUTE: number;
  export function readScoreText(raw: unknown): { text: string; error?: undefined } | { error: string; text?: undefined };
  export function scoreSyllables(text: string, readings: (string | null)[], opts?: { alternatives?: string[] | null }): { syllables: ExpectedSyllable[]; error?: undefined } | { error: string; syllables?: undefined };
  export function readScoreAudio(u8: Uint8Array): { seconds: number; error?: undefined; status?: undefined } | { error: string; status: number; seconds?: undefined };
  export function scoringEngine(input: { keys: { azureKey?: string; azureRegion?: string } | null }): { engine: "azure" | "local"; why: null | "no_keys" };
  export function azureLimiter(perMinute?: number, windowMs?: number): { take(userId: string, now?: number): boolean };
  export function azureUsable(parsed: AzureAssessment | null | undefined): boolean;
  export function scoreReply(
    result: ScoreResult,
    syllables: ExpectedSyllable[],
    opts: { engine: Reply["engine"]; fallback?: Reply["fallback"]; kids?: boolean; text: string; locale: string; frames?: Reply["frames"] },
  ): Reply;
}

declare module "*/scripts/pronunciation-words.mjs" {
  type AzureAssessment = import("../../scripts/pronunciation.mjs").AzureAssessment;
  type Word = import("../shared/wire.ts").PronunciationWord;
  type Reply = import("../shared/wire.ts").PronunciationWordsReply;
  /** One word's mark as the engine makes it (the reply strips it for kids). */
  export type WordMark = Word & { azureError?: string };
  export const WORD_RULES: Readonly<Record<string, unknown>>;
  export function wordCheckLocale(locale: string | null | undefined): string | null;
  export function readWordText(raw: unknown, locale: string): { text: string; error?: undefined } | { error: string; text?: undefined };
  export function wordMarks(azure: AzureAssessment, text: string, opts?: { locale?: string }): { words: WordMark[]; overall: number | null; heard?: "none" };
  export function heardNoneOf(azure: AzureAssessment | null | undefined): boolean;
  export function azureHeardNothing(azure: AzureAssessment | null | undefined, opts?: { quiet?: boolean }): boolean;
  export function quietTake(samples: Float32Array, sampleRate: number): boolean;
  export function wordsReply(marks: { words: WordMark[]; overall: number | null; heard?: "none" },opts: { kids: boolean; text: string; locale: string }): Reply;
}

declare module "*/scripts/pronunciation-compare.mjs" {
  type Frames = import("../shared/wire.ts").PronunciationFrames;
  type ModelSyllable = import("../shared/wire.ts").PronunciationModelSyllable;
  type ExpectedSyllable = import("../../scripts/pronunciation.mjs").ExpectedSyllable;
  type ScoreResult = import("../../scripts/pronunciation.mjs").ScoreResult;
  export type TakeFrames = Frames;
  /** A cached model clip's analysis (model-analysis.mjs). */
  export interface ModelRecord {
    v: number;
    engine: "azure" | "local";
    azure: "used" | "spent" | "skipped";
    durationMs: number;
    frames: Frames;
    syllables: ModelSyllable[];
    /** A skipped record refused by the cap or a busy slot: not retried before. */
    retryAt?: number;
    /** Read again on an older record's Azure spans (that record's version): no call made for it. */
    spansFrom?: number;
  }
  /** Syllable spans on a clip's own times. */
  type Span = { startMs: number; endMs: number };
  export type ModelDraft = Omit<ModelRecord, "azure">;
  export const LEVEL_FLOOR_DB: number;
  export const MODEL_RECORD_VERSION: number;
  export function modelRecord(input: { result: ScoreResult; frames: Frames; syllables: ExpectedSyllable[]; durationMs: number }): ModelDraft;
  export function isModelRecord(r: unknown): r is ModelRecord;
  export function speakerCentre(f0: ArrayLike<number>, hopMs: number, spans: { startMs: number; endMs: number }[]): number;
  export const MODEL_PAD_MS: number;
  export function padSamples(samples: Float32Array, sampleRate: number, ms?: number): Float32Array;
  export function unpadRecord<T extends ModelDraft>(record: T, ms?: number): T;
  export function priorAzureSpans(r: unknown, chars: string[]): { v: number; spans: Span[]; real: boolean[] } | null;
  export function padSpans(spans: Span[], ms?: number): Span[];
  export function reusedRecord<T extends ModelDraft>(record: T, prior: { v: number; real: boolean[] }): T & { azure: "used"; spansFrom: number };
}

declare module "*/scripts/audio-decode.mjs" {
  export function isScoreWav(u8: Uint8Array): boolean;
  export const MAX_OUTPUT_BYTES: number;
  export function decodeTo16k(audio: Uint8Array, type: string, opts?: { converter?: unknown; timeoutMs?: number; maxOutputBytes?: number; tmp?: string }): Promise<Uint8Array | null>;
  export function sweepStaleDirs(opts?: { tmp?: string; now?: number; staleMs?: number }): number;
}

declare module "*/scripts/model-analysis.mjs" {
  type ModelRecord = import("../../scripts/pronunciation-compare.mjs").ModelRecord;
  type ModelDraft = import("../../scripts/pronunciation-compare.mjs").ModelDraft;
  type AzureAssessment = import("../../scripts/pronunciation.mjs").AzureAssessment;
  export function analysisDir(env?: Record<string, string | undefined>): string;
  export const RETRY_MS: number;
  export function modelAnalysis(input: {
    key: string;
    audio: Uint8Array;
    type: string;
    /** The clip's characters, one per syllable. */
    chars?: string[];
    decode: (audio: Uint8Array, type: string) => Promise<Uint8Array | null>;
    azureReady: boolean;
    assess: (wav: Uint8Array, claim: () => boolean) => Promise<{ azure?: AzureAssessment; spent?: boolean }>;
    analyse: (wav: Uint8Array, azure: AzureAssessment | null, spans: { startMs: number; endMs: number }[] | null) => Promise<ModelDraft>;
    dir?: string;
    now?: number;
  }): Promise<{ record: ModelRecord; cached: boolean } | { unavailable: "no_decoder" | "unreadable" }>;
}

declare module "*/scripts/pronunciation-live.mjs" {
  type ScoreResult = import("../../scripts/pronunciation.mjs").ScoreResult;
  type Reply = import("../shared/wire.ts").PronunciationScoreReply;
  type Coaching = import("../shared/wire.ts").Coaching;
  /** One flagged syllable as the dojo master is told it. */
  export interface FlagNote {
    char: string;
    place: number;
    pinyin: string;
    expectedTone: number;
    heardTone: number | null;
  }
  export const COACHING: readonly Coaching[];
  export const DEFAULT_COACHING: Coaching;
  export function coachingOf(v: unknown): Coaching | null;
  export function hanOf(text: unknown): string;
  export function liveTarget(raw: unknown): { text: string; skip?: undefined } | { skip: "no_han" | "mixed" | "long"; text?: undefined };
  export const LIVE_RULES: Readonly<{ minMarginSt: number; minConfidence: number; minQuality: number; minVoicedMs: number; maxOffShare: number; quiet: string }>;
  export function liveFlags(result: ScoreResult, rules?: typeof LIVE_RULES): number[];
  export function flagNote(result: ScoreResult, i: number): FlagNote;
  export function liveReply(reply: Reply, flags: number[]): Reply;
  export function liveRecord(result: ScoreResult, flags: number[]): Record<string, unknown>[];
  type WordsReply = import("../shared/wire.ts").PronunciationWordsReply;
  type WordMarks = { words: import("../../scripts/pronunciation-words.mjs").WordMark[]; overall: number | null; heard?: "none" };
  export interface WordNote {
    word: string;
    place?: number;
  }
  export function wordsKey(text: unknown): string;
  export function liveWordTarget(raw: unknown, locale: string): { text: string; locale: string; skip?: undefined } | { skip: "locale" | "text"; text?: undefined; locale?: undefined };
  export const LIVE_WORD_RULES: Readonly<{ flagBelow: number; maxOffShare: number }>;
  export function liveWordFlags(marks: WordMarks, azure: import("../../scripts/pronunciation.mjs").AzureAssessment, rules?: typeof LIVE_WORD_RULES): number[];
  export function liveWordNote(marks: WordMarks, i: number, locale?: string): WordNote;
  export function liveWordsReply(reply: WordsReply, flags: number[]): WordsReply;
}

declare module "*/scripts/pronunciation-review.mjs" {
  type SessionTones = import("../shared/wire.ts").SessionTones;
  type ToneVsLast = import("../shared/wire.ts").ToneVsLast;
  type TrendPoint = import("../shared/wire.ts").ToneTrendReply["points"][number];
  type ToneMiss = import("../shared/practice.ts").PracticeToneMiss;
  type FlagNote = import("../../scripts/pronunciation-live.mjs").FlagNote;
  type Outcome = import("../../scripts/practice.mjs").Outcome;
  export const TONES: readonly number[];
  export const MAX_FLAGGED_SHOWN: number;
  export function sessionTones(rows: { id: string; syllables: unknown; clip: boolean; line: string }[]): SessionTones | null;
  export const COMPARE_MIN: number;
  export const COMPARE_STEP: number;
  export function compareTones(now: SessionTones | null, was: SessionTones | null, opts?: { min?: number }): Omit<ToneVsLast, "from" | "startedAt"> | null;
  export const TREND_MIN_SYLLABLES: number;
  export const TREND_DAYS: Readonly<{ min: number; max: number; default: number }>;
  export function readTrendDays(v: unknown): number;
  export function trendWindow(now: Date, days: number, utcOffsetMinutes?: number): { from: string; to: string; since: Date };
  export function toneTrend(rows: { createdAt: Date | string; syllables: unknown }[], opts?: { utcOffsetMinutes?: number; min?: number }): TrendPoint[];
  export function readToneHold(phrase: unknown, submit: unknown): { hold: { phraseId: string; submitId: string } | null; error?: undefined } | { error: string; hold?: undefined };
  export const MAX_TONE_MISS: number;
  export function practiceToneMiss(outcome: Outcome, flags: FlagNote[] | null, said?: { answer?: string | null; text?: string | null }): { outcome: Outcome; toneMiss: ToneMiss | null };
  export function settledPlaces(text: string, entries: { word: string; key?: string; reading: string }[], scored: Map<number, string>): Set<number>;
  export function leadingPlaces(text: string): Set<number>;
  export interface SettleOpts { readingsOf: (char: string) => string[]; text: string; settled?: Set<number>; readings?: (string | null)[]; tw?: boolean }
  export function settleFlags(flags: FlagNote[], opts: SettleOpts): FlagNote[];
  export function doubtfulFlags(flags: FlagNote[], opts: SettleOpts): boolean;
  export function storedToneMiss(v: unknown): ToneMiss | null;
}

declare module "*/scripts/pronunciation-clips.mjs" {
  export function clipsDir(env?: NodeJS.ProcessEnv): string;
  export function writeClip(conversationId: string, id: string, bytes: Uint8Array, opts?: { dir?: string }): string;
  export function readClip(conversationId: string, file: string, opts?: { dir?: string }): Buffer | null;
  export function removeClip(conversationId: string, file: string, opts?: { dir?: string }): void;
  export function removeConversationClips(conversationId: string, opts?: { dir?: string }): void;
}
