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
    /** The look-alike group a round plays it under (set by the server:
     *  a stock picture's concept's, a word's own drawing's ownLookAlike): a
     *  round never offers two of one. */
    group?: string | null;
    /** The picturable check's look-alike group for a word's own drawing
     *  (phrase_pictures.look_alike, migration 0021). */
    lookAlike?: string | null;
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
  export const LOOK_ALIKE_RULE_GROUPS: string[];
  export function isRound(choices: string[] | null | undefined): boolean;
  export function lookAlikeOf(description: string | null | undefined): string | null;
  export function ownLookAlike(row: { lookAlike?: string | null; description?: string | null } | null | undefined): string | null;
  export function lookAlikeGroups(concepts: { group?: string | null; drawing?: true; description: string }[], perGroup?: number): { id: string; shows: string[] }[];
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
  type NewConcept = { id: string; category: string; description: string; words: string[]; adults?: boolean; group?: string | null; origin?: "admin" | "drawing"; kidsSafe?: boolean | null };
  export function mergeStock(base: StockConcept[], custom?: NewConcept[], adultsOverrides?: { id: string; adults: boolean }[]): { concepts: (StockConcept & { custom: boolean; drawing?: true; kidsChecked?: boolean })[]; shadowed: (NewConcept & { adults: boolean; group: string | null })[]; problems: { level: "error" | "warning"; message: string }[] };
  export function stockIdFrom(name: unknown): string;
  export function readNewConcept(body: unknown, existing?: { id: string }[], names?: Iterable<string | null | undefined>): { concept: NewConcept; error?: undefined } | { error: string; concept?: undefined };
  export function readStockGroup(value: unknown): { group: string | null; error?: undefined } | { error: string; group?: undefined };
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
  export function namesALearner(text: string | null | undefined, names?: Iterable<string | null | undefined> | Set<string>): boolean;
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
    groups?: { id: string; shows: string[] }[];
  }): { system: string; user: string };
  export function parseJudgeReply(
    text: string,
    count: number,
    names?: Iterable<string | null | undefined>,
    stock?: { id: string; description: string }[],
    groups?: ({ id: string } | string)[],
  ): { ok: true; verdicts: ({ picturable: boolean; description: string | null; stock: string | null; kidsSafe?: boolean | null; lookAlike: string | null } | undefined)[] } | { ok: false; error: string };
  export function pictureWork<P extends CandidatePhrase>(phrases: P[], rows: Map<string, PictureLike>): { judge: P[]; draw: P[]; restyleCheck: P[]; restyleDraw: P[] };
  export function readyPicture<R extends PictureLike>(phrase: CandidatePhrase, rows: Map<string, R>): R | null;
  export function pictureBank<R extends PictureLike>(phrases: CandidatePhrase[], rows: Map<string, R>): { phrase: CandidatePhrase; picture: R }[];
  export function gameRounds(
    phrases: CandidatePhrase[],
    rows: Map<string, PictureLike>,
    opts: { now: Date; rounds?: number; seed?: string },
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
  type Custom = { id: string; category: string; description: string; words: string[]; adults?: boolean; origin?: "admin" | "drawing"; kidsSafe?: boolean | null };
  export function listStock(opts?: { root?: string; theme?: string; dir?: string; custom?: Custom[]; adultsOverrides?: { id: string; adults: boolean }[] }): (StockConcept & { custom: boolean; drawing?: true; kidsChecked?: boolean; drawn: { type: string } | null })[];
  export function drawnStock(opts?: { root?: string; theme?: string; dir?: string; custom?: Custom[] }): (StockConcept & { custom: boolean; drawn: { type: string } })[];
  export function drawStockPicture(concept: StockConcept, provider: Drawer, opts?: { theme?: PictureTheme; dir?: string; signal?: AbortSignal }): Promise<{ credits: number | null }>;
  export function removeStockPicture(id: string, opts?: { theme?: string; dir?: string }): void;
  export function addStockConcept(
    concept: { id: string; category: string; description: string; words: string[] },
    opts?: { root?: string },
  ): { concept: StockConcept; error?: undefined } | { error: string; concept?: undefined };
}

declare module "*/scripts/picture-pool.mjs" {
  type CandidatePhrase = import("../../scripts/practice.mjs").CandidatePhrase;
  type Entry = { level: string; words: Record<string, string> };
  type Row = {
    id: string; phraseId: string; phraseKey: string; status: "pending" | "ready" | "none" | "failed" | "removed"; description: string | null; file: string | null;
    contentType: string | null; theme: string | null; stockId: string | null; restyle: "check" | "draw" | null; group?: string; kidsSafe?: boolean | null;
    createdAt?: Date; updatedAt?: Date; learnerId?: string; languageProfileId?: string;
  };
  export const POOL_LANGS: readonly string[];
  export const POOL_VARIANTS: readonly string[];
  export const POOL_LEVELS: readonly ("A1" | "A2" | "B1" | "B2")[];
  export const POOL_WORD_MAX: number;
  export const POOL_WORDS_BATCH: number;
  export const POOL_DAILY_CALLS: number;
  export const KIDS_CHECK_BATCH: number;
  export const SHARED_CATEGORY: string;
  export function poolKey(locale: string | null | undefined): string | null;
  export function isPoolKey(key: string): boolean;
  export function isPoolLevel(v: unknown): v is "A1" | "A2" | "B1" | "B2";
  export function withinLevel(level: string, cap: string): boolean;
  export function checkPoolWord(key: string, text: unknown, names?: Iterable<string | null | undefined> | Set<string>): string | null;
  export function wordFor(words: Record<string, string> | null | undefined, locale: string): string | null;
  export function levelCap(mode: string, level: string | null | undefined): "A1" | "A2" | "B1" | "B2";
  export function readPoolLevel(v: unknown): { level: "A1" | "A2" | "B1" | "B2" | undefined; error?: undefined } | { error: string; level?: undefined };
  export function readPoolWords(raw: unknown, stock?: string[] | null): { entries: Map<string, Entry>; problems: { level: "error" | "warning"; message: string }[] };
  export function poolWordsYaml(entries: Map<string, Entry>, order: string[], header?: string): string;
  export function poolWordsPrompt(concepts: { id: string; words: string[]; description: string }[]): { system: string; user: string };
  export function parsePoolWordsReply(
    text: string,
    concepts: { id: string }[],
    names?: Iterable<string | null | undefined>,
  ): { ok: true; items: { id: string; level: string; words: Record<string, string> }[] } | { ok: false; error: string };
  export function poolId(kind: "phrase" | "picture", profileId: string, conceptId: string): string;
  export function poolWords(input: {
    concepts: { id: string; description: string; group?: string }[];
    entry: (id: string) => Entry | null;
    locale: string;
    nativeLocale?: string;
    taken?: Set<string>;
    ownIds?: Set<string>;
    ownRows?: Map<string, { stockId?: string | null }>;
    cap?: string;
    profileId: string;
    theme: string;
    contentTypeOf?: (id: string) => string;
  }): { phrases: (CandidatePhrase & { pool: { conceptId: string; level: string } })[]; rows: Map<string, Row>; byLevel: Record<"A1" | "A2" | "B1" | "B2", number> };
  export function sharedConceptId(file: string): string;
  export function sharedWords(meaning: string | null | undefined, description: string | null | undefined): string[];
  export function shareable<R extends { file: string | null; contentType: string | null; description: string | null; status: string; stockId?: string | null; phraseKey: string; theme?: string | null; kidsSafe?: boolean | null; createdAt?: Date }>(
    phrases: CandidatePhrase[],
    rows: Map<string, R>,
    opts: { shared: Set<string>; themes: Set<string>; names?: Iterable<string | null | undefined> | Set<string> },
  ): { phrase: CandidatePhrase; row: R }[];
  export function kidsCheckPrompt(items: { words: string[]; description: string }[]): { system: string; user: string };
  export function parseKidsCheckReply(text: string, count: number): { ok: true; verdicts: (boolean | undefined)[] } | { ok: false; error: string };
}
