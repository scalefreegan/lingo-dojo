// The server middleware reuses the repo-root .mjs modules (shared with the
// export CLI and the tests). They are plain JS, so tsc knows nothing of them
// beyond what this file says. Copied in shape from Atlas.
//
// Each module the server imports is declared precisely, against
// shared/wire.ts, so a route handler holds a typed value instead of casting an
// `any`, and a change to a wire type reaches every call site. These are still
// a promise about untyped code: scripts/tests/ (the loader, assembler and
// http tests) are what check that the .mjs half keeps it. Each block declares
// only what the server imports, so a new import fails to compile until it is
// declared here.
//
// ORDER MATTERS. The modules are matched by pattern (an ambient declaration
// cannot name a relative path), and tsc settles a tie between patterns with
// the same prefix in favour of the one declared first. The specific modules
// must stay above the catch-all, or it wins and types them all as `any`.
//
// Types come in through `import("…")` type queries rather than an `import`
// statement: a top-level import would make this file a module, and a pattern
// declaration inside a module is an augmentation, which tsc refuses.

declare module "*/scripts/content.mjs" {
  /** One kebab-case segment: the guard on export ids and folder names. */
  export const ID_RE: RegExp;
  /** `<stem>` or `<folder>/<stem>`: the guard on pack ids from a request. */
  export const PACK_ID_RE: RegExp;
  /** Absolute path of the repo (from import.meta.url, never process.cwd()). */
  export const REPO_ROOT: string;
  export function contentRoot(): string;
  export function exportsDir(): string;
  export function packsDir(root?: string): string;
  /** The two libraries, "adult" and "kids" (shared/wire.ts Mode). */
  export const MODES: import("../shared/wire.ts").Mode[];
  export function isMode(v: unknown): v is import("../shared/wire.ts").Mode;
  /** content/ for adult, content/kids for kids; throws EINVAL otherwise. */
  export function modeRoot(mode?: import("../shared/wire.ts").Mode): string;
  /** exports/ for adult, exports/kids for kids; throws EINVAL otherwise. */
  export function exportsDirFor(mode?: import("../shared/wire.ts").Mode): string;
  /** A pack from a file or a request body, with every field in its shape. */
  export function normalizePack(pack: unknown): import("../shared/wire.ts").PackInput & { overrides: Record<string, unknown> };
  /** A units entry saying a `backfill` slot was emptied on purpose ("-recall"). */
  export function slotOptOut(slotId: string): string;
  /** The units a pack plays: its own, opt-outs dropped, plus each `backfill`
   *  slot's default unit when the pack has none of it and no opt-out. */
  export function packUnits(
    content: { schema?: { slots?: import("../shared/wire.ts").Slot[] }; units?: import("../shared/wire.ts").Unit[] } | null | undefined,
    units: unknown,
  ): string[];
  /** The level picker's options per mode. */
  export const LEVELS_BY_MODE: Record<import("../shared/wire.ts").Mode, string[]>;
  /** Never throws; bad files land in `problems`. The mode and its levels are
   *  the route's to add (content.ts contentReply). */
  export function loadContent(root?: string): Omit<import("../shared/wire.ts").ContentReply, "mode" | "levels">;
  /** A tree's pack files (seed content and the export CLI's input; the app's
   *  saved packs are in the database): the packs that load, every folder
   *  under packs/, and the problems of the pack files that did not load. */
  export function loadPackFiles(root?: string): {
    packs: import("../shared/wire.ts").Pack[];
    folders: string[];
    problems: import("../shared/wire.ts").Problem[];
  };
  /** `folder/stem` → {folder, stem}; a top-level id has folder "". */
  export function splitPackId(id: string): { folder: string; stem: string };
  /** A pack-shaped value with every field present and of its type; unknown
   *  keys ride along. */
  export function normalizePack(raw: unknown, id?: string): import("../shared/wire.ts").PackInput & Record<string, unknown>;
  /** `<date>-<slug of title>`, the date kept from the stem, else `created`,
   *  else today. */
  export function renamedStem(stem: string, created: string, title: string): string;
  /** Merges the patch into content/profile.yaml in place (a blank value
   *  removes the key). Throws when the existing file is not a YAML mapping. */
  export function saveProfile(patch: import("../shared/wire.ts").ProfileRequest, root?: string): string;
  /** Throws on an id ID_RE rejects or a path outside exports/. */
  export function writeExport(id: string, markdown: string, dir?: string): string;
}

declare module "*/scripts/assemble.mjs" {
  /** A random scene's title before its scene is drawn ("Random scene"). */
  export const RANDOM_SCENE_TITLE: string;
  /** Pure and deterministic; never throws on a malformed pack. A random
   *  scene's pack assembles with a placeholder for the scene (the pool's
   *  size taken from `languages`, when given). */
  export function assemble(
    content: Pick<import("../shared/wire.ts").ContentReply, "schema" | "frame" | "profile" | "units" | "scenarios"> & { languages?: import("../shared/wire.ts").Language[] },
    pack: unknown,
    /** Which tree `content` is (the Time budget splits that mode's parts),
     *  or that and the review block's phrases (none: units using
     *  {{phrase_review}} drop out). */
    options?: import("../shared/wire.ts").Mode | { mode?: import("../shared/wire.ts").Mode; review?: { text: string; meaning?: string | null }[] },
  ): import("../shared/wire.ts").AssembleResult;
  /** The learner's profile under the pack's overrides, as the prompt sees it. */
  export function effectiveProfile(profile: Record<string, unknown> | null | undefined, overrides?: Record<string, unknown> | null): Record<string, unknown>;
}

declare module "*/scripts/claude.mjs" {
  export const AGENT_MODELS: import("../shared/wire.ts").AgentModel[];
  export const DEFAULT_MODEL: string;
  export function isAgentModel(id: unknown): id is string;
  /** An agent model or a voice-turn model. */
  export function isKnownModel(id: unknown): id is string;
  /** A sentence for a known headless-CLI failure (sign-in, usage limit,
   *  overload), or null. */
  export function failureHint(text: string): string | null;
  /** The agent's final reply plus the envelope's accounting. */
  export interface ClaudeResult {
    text: string;
    costUsd: number | null;
    numTurns: number | null;
    durationMs: number | null;
    usage: Record<string, unknown> | null;
    permissionDenials: unknown[];
    raw: Record<string, unknown>;
  }
  /** Spawns `claude -p` in the sandbox buildArgs() pins (see the test).
   *  `kill()` and `signal` both SIGKILL the process group. */
  export function startClaude(opts: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    cwd?: string;
    signal?: AbortSignal;
    maxTurns?: number;
    timeoutSec?: number;
    /** "content" (the editing agent's sandbox, the default) or "none" (a
     *  voice turn: no tools at all). */
    tools?: "content" | "none";
    /** The --mcp-config file's servers (none by default). */
    mcpServers?: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }>;
    /** Their tools the run may call, each by its full mcp__server__tool name. */
    mcpTools?: string[];
  }): { result: Promise<ClaudeResult>; kill: () => void };
}

declare module "*/scripts/voice.mjs" {
  type Mode = import("../shared/wire.ts").Mode;
  type TtsProvider = import("../shared/wire.ts").TtsProvider;
  type SttProvider = import("../shared/wire.ts").SttProvider;
  type VoiceChoice = import("../shared/wire.ts").VoiceChoice;
  type VoiceLine = import("../shared/wire.ts").VoiceLine;
  type VoiceSpeaker = import("../shared/wire.ts").VoiceSpeaker;
  type Req = { url: string; init: RequestInit };
  export const TTS_PROVIDERS: TtsProvider[];
  export const STT_PROVIDERS: SttProvider[];
  export const SPEECH_FORMATS: Readonly<Record<import("../shared/wire.ts").TtsProvider, string>>;
  export const ELEVEN_MODELS: import("../shared/wire.ts").VoiceOption[];
  export const VOICE_MODELS: import("../shared/wire.ts").VoiceOption[];
  export const SILENCE_MS: { min: number; max: number; default: number };
  export const SPEAKERS_BY_MODE: Record<Mode, VoiceSpeaker[]>;
  export const AZURE_VOICE_RE: RegExp;
  export const SESSION_START: string;
  export function speakersFor(mode: Mode): VoiceSpeaker[];
  export function localeFor(language: unknown, variant?: unknown): string | null;
  export function envFile(): string;
  export function voiceKeys(): { elevenlabs: string; azureKey: string; azureRegion: string };
  export function configuredProviders(keys: { elevenlabs: string; azureKey: string; azureRegion: string }): Record<TtsProvider, boolean>;
  export function voiceSystemPrompt(markdown: string, mode: Mode): string;
  /** `notes`: recall's delimited blocks (bank retrieval, LOOKUP results), after the clock. */
  export function voiceTurnPrompt(history: import("../shared/wire.ts").VoiceHistoryItem[], message: string, clock?: string, notes?: string[]): string;
  /** The query of a reply's first LOOKUP line, or null. */
  export function parseLookup(text: string): string | null;
  /** The "How long do you have?" choices per mode, in minutes. */
  export const MINUTE_CHOICES: Record<Mode, number[]>;
  /** The time-budget line for a turn's prompt; "" without a budget. */
  export function clockLine(o: { minutes: unknown; elapsedMs: unknown; plan: import("../shared/wire.ts").VoicePlanItem[]; stage: string | null | undefined; mode?: Mode }): string;
  export function parseVoiceReply(text: string, mode: Mode): VoiceLine[];
  export const MAX_GLOSSES: number;
  export const MAX_CHOICES: number;
  export function parseChoices(text: string): string[];
  export function parseStage(text: string, ids: string[]): string | null;
  export function oneLine(s: string): string;
  export const REPLAY_MAX_CHARS: number;
  export function replayLine(s: string): string;
  export function replayStage(v: unknown): string;
  export function poolFor(list: { id: string; name: string; gender: string; match: boolean; home?: boolean; premade?: boolean; age?: string }[], gender: string, skip?: Set<string>, age?: string): { id: string; name: string; age: string }[];
  export function retryInOtherVoice(status: number): boolean;
  export function ageOf(label: unknown): import("../shared/wire.ts").VoiceAge | "";
  export function parseCast(text: string, mode?: Mode): import("../shared/wire.ts").VoiceCastNote[];
  export function speechVoices(o: { set?: Record<string, string | undefined>; speaker: string; gender: string | null; cast: string | null; fallback?: string; refused?: Set<string> }): { first: string; retry: string };
  export function replayCastNotes(raw: unknown): { slot: string; age: "child" | "young" | "middle" | "old"; who: string }[];
  export function castFallbacks(
    own: { id: string; gender: string; match: boolean; home?: boolean; premade?: boolean; age?: string }[],
    slots: string[],
    set?: Record<string, string | undefined>,
    o?: { all?: string[]; ages?: Record<string, string>; taken?: string[] },
  ): Record<string, string>;
  export function castPools(o: {
    slots: string[];
    set?: Record<string, string | undefined>;
    ages?: Record<string, string>;
    library?: Record<string, { id: string; name: string; age?: string; exact?: boolean }[] | null>;
    aged?: Record<string, { id: string; name: string; age?: string; exact?: boolean }[] | null>;
    own?: { id: string; name: string; gender: string; match: boolean; home?: boolean; premade?: boolean; age?: string }[];
    recast?: boolean;
    avoid?: string[];
  }): { pools: Record<string, { id: string; name: string; age?: string; exact?: boolean }[]>; omitted: string[] };
  export function sessionPlan(content: unknown, pack: unknown, mode?: Mode): import("../shared/wire.ts").VoicePlanItem[];
  export function planDirective(plan: import("../shared/wire.ts").VoicePlanItem[]): string;
  export function parseGlosses(text: string): import("../shared/wire.ts").VoiceGloss[];
  export function splitSegments(text: string): import("../shared/wire.ts").VoiceSegment[];
  export function voiceSlots(mode: Mode): import("../shared/wire.ts").VoiceSlot[];
  /** The voice id for a speaker and gender from one locale's slot map; "" if none. */
  export function voiceFor(set: Record<string, string> | undefined, speaker: VoiceSpeaker, gender: import("../shared/wire.ts").VoiceGender | null | undefined): string;
  export const LIBRARY_SORTS: import("../shared/wire.ts").LibrarySort[];
  export function elevenLibraryRequest(o: { key: string; locale?: string; gender?: string; age?: string; search?: string; sort?: string; page?: number; pageSize?: number; anyLocale?: boolean }): Req;
  export function elevenLibraryLocale(locale: string): string;
  export function elevenLibrarySearchable(locale: string): boolean;
  export function pinnedNarratorGender(units: unknown): import("../shared/wire.ts").VoiceGender | null;
  export function narratorDirective(gender: unknown): string;
  export function pickCast(o: {
    slots: string[];
    set?: Record<string, string | undefined>;
    pools?: Record<string, { id: string; name: string; age?: string; exact?: boolean }[]>;
    names?: Record<string, string>;
    ages?: Record<string, string>;
    avoid?: string[];
    rand?: () => number;
  }): Record<string, { id: string; name: string; age?: import("../shared/wire.ts").VoiceAge }>;
  export function elevenLibrary(json: unknown): import("../shared/wire.ts").LibraryReply;
  /** Throws on an id that isn't an ElevenLabs id. */
  export function elevenAddRequest(o: { key: string; ownerId: string; voiceId: string; name: string }): Req;
  export function elevenSpeechRequest(o: { key: string; voice: string; text: string; model?: string; locale?: string }): Req;
  export function elevenVoicesRequest(o: { key: string }): Req;
  export function elevenTranscribeRequest(o: { key: string; audio: Uint8Array; mime?: string; language?: string; keyterms?: string[] }): Req;
  export const MAX_KEYTERMS: number;
  export function keytermsFrom(phrases: unknown, max?: number): string[];
  export function azureSpeechRequest(o: { key: string; region: string; voice: string; text: string; locale?: string }): Req;
  export function azureVoicesRequest(o: { key: string; region: string }): Req;
  export function azureTranscribeRequest(o: { key: string; region: string; audio: Uint8Array; locales: string[]; mime?: string }): Req;
  export function elevenVoices(json: unknown, locale: string, nativeLocale?: string): VoiceChoice[];
  export function azureVoices(json: unknown, locale: string): VoiceChoice[];
  export function systemVoices(text: string, locale: string): VoiceChoice[];
  export function transcriptText(provider: SttProvider, json: unknown): string;
  export function normalizeVoiceSettings(raw: unknown): import("../shared/wire.ts").VoiceSettings;
}

declare module "*/scripts/auth.mjs" {
  export const MIN_PASSWORD: number;
  export const MAX_PASSWORD: number;
  export function hashPassword(password: string): Promise<string>;
  /** False (never a throw) for a wrong password or a malformed hash. */
  export function verifyPassword(password: unknown, stored: unknown): Promise<boolean>;
  export function passwordProblem(password: unknown): string | null;
  export const USERNAME_RE: RegExp;
  export function normalizeUsername(name: unknown): string;
  export function usernameProblem(name: unknown): string | null;
  export function newSessionToken(): string;
  /** SHA-256 hex: what auth_sessions.id stores. */
  export function tokenHash(token: string): string;
  export const SESSION_COOKIE: string;
  export const SESSION_DAYS: number;
  export const SESSION_MS: number;
  export const SLIDE_EVERY_MS: number;
  export function parseCookies(header: string | undefined): Record<string, string>;
  export function serializeCookie(
    name: string,
    value: string,
    opts?: { path?: string; maxAge?: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None"; secure?: boolean },
  ): string;
  export function isSecureRequest(headers: Record<string, string | string[] | undefined>): boolean;
  /** Loopback peer, no X-Forwarded-* headers, localhost Host: a request made on this machine. */
  export function isDirectLocalRequest(headers: Record<string, string | string[] | undefined>, remoteAddress: string | undefined): boolean;
  export function sessionCookie(token: string, opts?: { secure?: boolean }): string;
  export function clearSessionCookie(opts?: { secure?: boolean }): string;
  export interface LoginThrottle {
    /** Milliseconds this key must still wait; 0 when it may try. */
    wait(key: string): number;
    /** The wait (> 0: refused), or 0 with the attempt counted as a failure until succeed(). */
    attempt(key: string): number;
    succeed(key: string): void;
    clear(): void;
  }
  export function createLoginThrottle(opts?: { max?: number; windowMs?: number; waitMs?: number; now?: () => number }): LoginThrottle;
  /** The client for the throttle: X-Forwarded-For's last hop behind a loopback proxy, else the socket address. */
  export function clientAddress(headers: Record<string, string | string[] | undefined>, remoteAddress: string | undefined): string;
  export function throttleKey(username: string, address: string): string;
  export const LEARNER_COLUMNS: Record<"learner_name" | "native_language", string>;
  export const LANGUAGE_COLUMNS: Record<"target_language" | "target_variant" | "level" | "goals" | "notes", string>;
  export const PROFILE_COLUMNS: Record<import("../shared/wire.ts").PickerKey | "goals" | "notes", string>;
  /** A learner's and its first language's values (column keys, one object) from a profile.yaml mapping. */
  export function learnerFromProfile(profile: unknown, mode: import("../shared/wire.ts").Mode, fallbackName: string): Record<string, string>;
  /** A learner row and its language profile row as the assembler's profile (blanks left out). */
  export function profileFromLearner(
    learner: Record<string, unknown> | null | undefined,
    language: Record<string, unknown> | null | undefined,
  ): import("../shared/wire.ts").Profile;
}

declare module "*/scripts/db/config.mjs" {
  export const DEFAULT_DATABASE_URL: string;
  export const MIGRATIONS_DIR: string;
  export function isLinkedWorktree(root?: string): boolean;
  /** The shell's DATABASE_URL, else .env.local's, else the default; throws
   *  in a linked worktree with neither. */
  export function databaseUrl(env?: Record<string, string | undefined>, file?: string, root?: string): string;
  /** Throws when the URL names no database. */
  export function databaseName(url: string): string;
  /** The URL with any password masked. */
  export function redact(url: string): string;
  /** The content agent's read-only role: LINGO_READER_ROLE, else lingo_reader. */
  export const READER_ROLE: string;
  export function readerRole(env?: Record<string, string | undefined>, file?: string, root?: string): string;
}

declare module "*/scripts/db/migrations.mjs" {
  type Migration = { sql: string[]; folderMillis: number; hash: string };
  type MigrationState = {
    status: "current" | "behind" | "skipped" | "ahead" | "diverged";
    total: number;
    applied: number;
    missing: Migration[];
    skipped: Migration[];
    unknown: { hash: string; createdAt: number | null }[];
  };
  type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** Read-only: the database's recorded migrations against the files, by hash. */
  export function migrationState(query: Query, disk?: Migration[]): Promise<MigrationState>;
  export function describeMigrations(state: MigrationState): string;
  /** Read-only: what is missing of 0005's reader (policies, RLS, grants), or null. */
  export function bankReaderProblem(query: Query, role?: string): Promise<string | null>;
}

// Everything else: untyped.
declare module "*/scripts/plan.mjs" {
  /** A pack's `overrides.minutes` as a budget: null is no limit. */
  export function readMinutes(v: unknown): { minutes: number | null; invalid: boolean; rounded: boolean };
}

declare module "*/scripts/conversations.mjs" {
  type VoiceHistoryItem = import("../shared/wire.ts").VoiceHistoryItem;
  type PackInput = import("../shared/wire.ts").PackInput;
  /** A turn row's transcript columns (scripts/db/schema.ts turns). */
  export interface TurnColumns {
    role: "learner" | "master";
    text: string | null;
    lines: import("../shared/wire.ts").VoiceLine[] | null;
    glosses: import("../shared/wire.ts").VoiceGloss[] | null;
    choices: string[] | null;
    stage: string | null;
    castNotes: import("../shared/wire.ts").VoiceCastNote[] | null;
    /** A master row whose words came from the browser's history. */
    fromClient: boolean;
  }
  export const IDLE_END_MS: number;
  export const CONVERSATION_ID_RE: RegExp;
  export const PAGE_SIZE: number;
  export const MAX_PAGE: number;
  export const TURN_PAGE: number;
  export const MAX_TURN_PAGE: number;
  export const MAX_START: number;
  export function turnKey(t: { role: string; text?: string | null; lines?: { text: string }[] | null }): string;
  export function rowFromItem(item: VoiceHistoryItem, fromClient?: boolean): TurnColumns;
  export function itemFromRow(row: TurnColumns): VoiceHistoryItem;
  export function planTurnWrite(o: {
    stored: { role: string; text?: string | null; lines?: { text: string }[] | null }[];
    screen: VoiceHistoryItem[];
    message: string;
    master: VoiceHistoryItem & { durationMs?: number | null; costUsd?: number | null };
  }): { keep: number; covered: boolean; insert: (TurnColumns & { idx: number; durationMs?: number | null; costUsd?: number | null })[] };
  export function conversationTitle(o: { title?: unknown; pack?: Partial<PackInput> | null; scenarioTitle?: string | null }): string;
  export function readPage(params: URLSearchParams, o: { size: number; max: number; key?: string }): { limit: number; start: number };
}

declare module "*.mjs";

declare module "*/scripts/public-host.mjs" {
  export function isPlainHostname(h: string): boolean;
  /** LINGO_PUBLIC_HOST: the plain hostnames, and the entries that were not. */
  export function parsePublicHosts(value: unknown): { hosts: string[]; rejected: string[] };
  export function publicHosts(env?: Record<string, string | undefined>, file?: string): { hosts: string[]; rejected: string[] };
}
