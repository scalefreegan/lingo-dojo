// Declarations for the kids word game's pure half (scripts/pictures.mjs), its
// files (scripts/picture-store.mjs) and the shared stock set
// (scripts/picture-stock.mjs), in a file of their own like
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
    theme?: string | null;
    stockId?: string | null;
    restyle?: string | null;
    /** A stock picture's look-alike group (set by the server from
     *  pictures.yaml): a round never offers two of one. */
    group?: string | null;
  }
  /** A stock concept as the check is offered it. */
  interface StockOffer {
    id: string;
    description: string;
    words: string[];
  }
  export interface StockConcept extends StockOffer {
    category: string;
    group?: string;
    adults?: true;
  }
  export function stockForMode<C extends { adults?: true }>(concepts: C[], mode: string): C[];
  export interface PictureTheme {
    readonly id: string;
    readonly provider: string;
    readonly seed: number;
    readonly style: readonly string[];
  }
  export const PICTURE_THEME: PictureTheme;
  export const THEME_RE: RegExp;
  export const STOCK_ID_RE: RegExp;
  export function drawnTheme(provider: string, theme?: PictureTheme): string;
  export function currentThemes(provider: string, theme?: PictureTheme): Set<string>;
  export function stockKey(theme: string, id: string): string;
  export function readStockList(raw: unknown): { concepts: StockConcept[]; problems: { level: "error" | "warning"; message: string }[] };
  export const PICTURE_DAILY_STOCK: number;
  type NewConcept = { id: string; category: string; description: string; words: string[]; adults?: boolean };
  export function mergeStock(base: StockConcept[], custom?: NewConcept[]): { concepts: (StockConcept & { custom: boolean })[]; shadowed: (NewConcept & { adults: boolean })[]; problems: { level: "error" | "warning"; message: string }[] };
  export function stockIdFrom(name: unknown): string;
  export function readNewConcept(body: unknown, existing?: { id: string }[], names?: Iterable<string | null | undefined>): { concept: NewConcept; error?: undefined } | { error: string; concept?: undefined };
  export function restyleTargets<R extends PictureLike>(phrases: CandidatePhrase[], rows: Map<string, R>, themes: Set<string>): R[];
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
  export function picturePrompt(description: string, names?: Iterable<string | null | undefined> | Set<string>, theme?: PictureTheme): string | null;
  export function judgePrompt(input: {
    words: { text: string; meaning: string | null }[];
    targetLanguage?: string;
    nativeLanguage?: string;
    stock?: { id: string; words: string[] }[];
  }): { system: string; user: string };
  export function parseJudgeReply(
    text: string,
    count: number,
    names?: Iterable<string | null | undefined>,
    stock?: { id: string; description: string }[],
  ): { ok: true; verdicts: ({ picturable: boolean; description: string | null; stock: string | null } | undefined)[] } | { ok: false; error: string };
  export function pictureWork<P extends CandidatePhrase>(phrases: P[], rows: Map<string, PictureLike>): { judge: P[]; draw: P[]; restyleCheck: P[]; restyleDraw: P[] };
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
  export function stockDir(theme: string, opts?: { dir?: string }): string;
  export function stockVersion(theme: string, id: string, opts?: { dir?: string }): string | null;
  export function stockPicture(theme: string, id: string, opts?: { dir?: string }): { path: string; type: string } | null;
  export function readStockPicture(theme: string, id: string, opts?: { dir?: string }): { bytes: Buffer; type: string } | null;
  export function writeStockPicture(theme: string, id: string, bytes: Uint8Array, type: string, opts?: { dir?: string }): void;
  export function deleteStockPicture(theme: string, id: string, opts?: { dir?: string }): void;
}

declare module "*/scripts/picture-stock.mjs" {
  type StockConcept = import("../../scripts/pictures.mjs").StockConcept;
  type PictureTheme = import("../../scripts/pictures.mjs").PictureTheme;
  type Drawer = { draw(prompt: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string; credits?: number | null }> };
  type Custom = { id: string; category: string; description: string; words: string[]; adults?: boolean };
  export function listStock(opts?: { root?: string; theme?: string; dir?: string; custom?: Custom[] }): (StockConcept & { custom: boolean; drawn: { type: string } | null })[];
  export function drawnStock(opts?: { root?: string; theme?: string; dir?: string; custom?: Custom[] }): (StockConcept & { custom: boolean; drawn: { type: string } })[];
  export function drawStockPicture(concept: StockConcept, provider: Drawer, opts?: { theme?: PictureTheme; dir?: string; signal?: AbortSignal }): Promise<{ credits: number | null }>;
  export function removeStockPicture(id: string, opts?: { theme?: string; dir?: string }): void;
  export function addStockConcept(
    concept: { id: string; category: string; description: string; words: string[] },
    opts?: { root?: string },
  ): { concept: StockConcept; error?: undefined } | { error: string; concept?: undefined };
}
