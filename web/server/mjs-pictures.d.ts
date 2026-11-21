// Declarations for the kids word game's pure half (scripts/pictures.mjs) and
// its files (scripts/picture-store.mjs), in a file of their own like
// mjs-practice.d.ts. It must sort before mjs.d.ts (its catch-all `*.mjs`),
// which "mjs-pictures" does.

declare module "*/scripts/pictures.mjs" {
  type CandidatePhrase = import("../../scripts/practice.mjs").CandidatePhrase;
  /** The picture row fields the pure rules read. */
  interface PictureLike {
    id: string;
    phraseKey: string;
    status: string;
    description: string | null;
    file: string | null;
  }
  export const PICTURE_DAILY_IMAGES: number;
  export const PICTURE_DAILY_JUDGES: number;
  export const JUDGE_BATCH: number;
  export const GAME_ROUNDS: number;
  export const MIN_PICTURED: number;
  export const GAME_CHOICES: number;
  export const DESCRIPTION_MAX: number;
  export const DESCRIPTION_WORDS: number;
  export function nameWords(names: Iterable<string | null | undefined>): Set<string>;
  export const PICTURE_STATUSES: readonly string[];
  export function pictureKey(phrase: { text: string | null; meaning: string | null }): string;
  export function isCurrent(row: PictureLike | undefined | null, phrase: { text: string | null; meaning: string | null }): boolean;
  export function cleanDescription(v: unknown, names?: Iterable<string | null | undefined> | Set<string>): string | null;
  export function grownUpDescription(v: unknown, names?: Iterable<string | null | undefined> | Set<string>): { description: string; error?: undefined } | { error: "name" | "nothing" };
  export function picturePrompt(description: string, names?: Iterable<string | null | undefined> | Set<string>): string | null;
  export function judgePrompt(input: { words: { text: string; meaning: string | null }[]; targetLanguage?: string; nativeLanguage?: string }): { system: string; user: string };
  export function parseJudgeReply(
    text: string,
    count: number,
    names?: Iterable<string | null | undefined>,
  ): { ok: true; verdicts: ({ picturable: boolean; description: string | null } | undefined)[] } | { ok: false; error: string };
  export function pictureWork<P extends CandidatePhrase>(phrases: P[], rows: Map<string, PictureLike>): { judge: P[]; draw: P[] };
  export function readyPicture<R extends PictureLike>(phrase: CandidatePhrase, rows: Map<string, R>): R | null;
  export function pictureBank<R extends PictureLike>(phrases: CandidatePhrase[], rows: Map<string, R>): { phrase: CandidatePhrase; picture: R }[];
  export function gameRounds(
    phrases: CandidatePhrase[],
    rows: Map<string, PictureLike>,
    opts: { now: Date; rounds?: number },
  ): { ready: boolean; pictured: number; rounds: { phraseId: string; version: string; revision: string; choices: string[] | null }[] };
  export function roundSeed(phraseId: string, version: string, revision: string, file: string): string;
  export function roundChoices(phrase: CandidatePhrase, bank: { phrase: CandidatePhrase; picture: PictureLike }[], version: string): string[] | null;
  export function readGameAnswer(body: unknown):
    | {
        value: { phraseId: string; version: string; revision: string; submitId: string; pictureId: string; durationMs: number | null; utcOffsetMinutes: number };
        error?: undefined;
      }
    | { error: string; value?: undefined };
}

declare module "*/scripts/picture-store.mjs" {
  export const PICTURE_TYPES: Record<string, string>;
  export const MAX_PICTURE_BYTES: number;
  export function imagesDir(env?: NodeJS.ProcessEnv): string;
  export function newPictureKey(): string;
  export function sniffPicture(bytes: Uint8Array): string | null;
  export function writePicture(key: string, bytes: Uint8Array, type: string, opts?: { dir?: string }): void;
  export function readPicture(key: string, type: string, opts?: { dir?: string }): Buffer | null;
  export function deletePicture(key: string, opts?: { dir?: string }): void;
}
