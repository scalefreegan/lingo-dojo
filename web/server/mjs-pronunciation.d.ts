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
