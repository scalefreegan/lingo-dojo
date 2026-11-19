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
  export function scoreSyllables(text: string, readings: (string | null)[]): { syllables: ExpectedSyllable[]; error?: undefined } | { error: string; syllables?: undefined };
  export function readScoreAudio(u8: Uint8Array): { seconds: number; error?: undefined; status?: undefined } | { error: string; status: number; seconds?: undefined };
  export function scoringEngine(input: { mode: string; keys: { azureKey?: string; azureRegion?: string } | null }): { engine: "azure" | "local"; why: null | "kids" | "no_keys" };
  export function azureLimiter(perMinute?: number, windowMs?: number): { take(userId: string, now?: number): boolean };
  export function azureUsable(parsed: AzureAssessment | null | undefined): boolean;
  export function scoreReply(
    result: ScoreResult,
    syllables: ExpectedSyllable[],
    opts: { engine: Reply["engine"]; fallback?: Reply["fallback"]; kids?: boolean; text: string; locale: string },
  ): Reply;
}
