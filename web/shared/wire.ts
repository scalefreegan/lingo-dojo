/* The wire: every request and response shape the server and the client both
 * name, declared ONCE. The field names follow docs/CONTENT.md (the file
 * format contract); scripts/content.mjs and scripts/assemble.mjs produce
 * them, and web/server/mjs.d.ts types those modules against this file.
 *
 * Why a third directory rather than the client importing server/*.ts (the
 * Atlas pattern): src/ and server/ are separate tsc projects (tsconfig.app
 * has DOM and vite types, tsconfig.node has node's), so importing a server
 * module from src/ would drag node:http and the untyped .mjs scripts into the
 * app program. Both configs include shared/, so this file must stay types
 * only: no imports, and no runtime values. */

/* -------------------------------- content -------------------------------- */

export type Pick = "one" | "any";

/** One entry of content/schema.yaml `slots`, in prompt order. */
export interface Slot {
  id: string;
  title: string;
  pick: Pick;
  /** Defaults to false when the schema omits it. */
  required: boolean;
  /** "" when the schema omits it. */
  description: string;
  /** Display heading the UI clusters slots under on the Customize tab
   *  (Voices, Teaching style, …); undefined when the schema omits it — the
   *  UI then groups the slot under "Other". */
  group?: string;
}

export interface Schema {
  version?: number;
  slots: Slot[];
}

/** content/units/<id>.md. Unknown frontmatter keys ride along untyped. */
export interface Unit {
  id: string;
  /** A slot id; may name a slot that is not in the schema (an "unslotted"
   *  unit, reported as a warning and never assembled). */
  slot: string;
  title: string;
  summary: string;
  tags: string[];
  /** Preselected in a new pack. */
  default: boolean;
  /** CEFR hint for a badge; never a filter. [] when absent. */
  level: string[];
  body: string;
  /** Repo-relative file path (absolute when outside the repo). */
  path: string;
}

export interface VocabItem {
  term: string;
  gloss: string;
}

/** content/scenarios/<id>.md. Only id/title/summary are required on disk;
 *  the loader fills the rest with empty values. */
export interface Scenario {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** Suggested target variant, e.g. "es-MX"; the profile can override. */
  language: string | null;
  /** Grouping on the Scene tab, e.g. "Oaxaca trip"; null = ungrouped. */
  collection: string | null;
  /** Filter chip on the Scene tab, e.g. "Food & drink"; null = uncategorized. */
  category: string | null;
  /** role key (dojo_master, learner, …) → description */
  roles: Record<string, string>;
  beats: string[];
  vocab: VocabItem[];
  /** English meanings for a scenario written for every language; the dojo
   *  master says them in the learner's variant. [] when absent. */
  phrases: string[];
  /** Optional complications a variation unit may pick from. */
  twists: string[];
  body: string;
  path: string;
  /** True when roles, twists or the body use {{location}}: the scene is set
   *  wherever the session says (overrides.location), or in a city the dojo
   *  master picks. False for a fixed setting like the Oaxaca trip. */
  uses_location: boolean;
}

/** A learner profile: content/profile.yaml's keys. In the app it is the
 *  active learner's row (its name and native language, LearnerInfo) with
 *  its active language profile's (the rest, LanguageInfo); the file is read
 *  only by the offline
 *  export CLI and as the first run's seed. The keys below are the contract's;
 *  any other key is allowed and rendered in the Learner block. */
export interface Profile {
  learner_name?: string;
  native_language?: string;
  target_language?: string;
  target_variant?: string;
  level?: string;
  goals?: string;
  notes?: string;
  [key: string]: unknown;
}

/** One entry of content/languages.yaml: what the native/target pickers
 *  offer. `variants` is [] when the language has none. */
export interface Language {
  name: string;
  variants: string[];
  /** ISO 639 code ("es"), matched against a scenario's `language` prefix
   *  ("es-MX"); null when languages.yaml gives none. */
  code: string | null;
}

/** A file the loader could not use (`error`: left out of the library) or
 *  used with a caveat (`warning`). Never thrown, always listed. */
export interface Problem {
  file: string;
  level: "error" | "warning";
  message: string;
}

/** The two libraries: "adult" is content/, "kids" is content/kids/ (its own
 *  schema, frame, profile, units, scenarios and packs). A learner is one or
 *  the other, and the pack, profile, assemble, export and voice routes work
 *  in the active learner's mode: a `?mode=` (or body `mode`) they are sent
 *  must match it or the reply is a 400. */
export type Mode = "adult" | "kids";

/** GET /api/content?mode= — the loader's result minus packs (they have their
 *  own routes), re-read from disk on every call so an agent or editor change
 *  shows up without a restart. Either mode may be asked for (the active
 *  learner's when absent); `profile` is the active learner's in its own mode
 *  and {} in the other. */
export interface ContentReply {
  mode: Mode;
  /** The level picker's options for this mode (CEFR for adult, a child-sized
   *  scale for kids); a profile level outside the list is still shown. */
  levels: string[];
  root: string;
  schema: Schema;
  frame: string;
  profile: Profile;
  /** [] when content/languages.yaml is missing; the UI then shows free text. */
  languages: Language[];
  units: Unit[];
  scenarios: Scenario[];
  problems: Problem[];
}

/* -------------------------------- profile -------------------------------- */

/** The profile keys the UI's pickers can write ("Save as my defaults"). */
export type PickerKey = "learner_name" | "native_language" | "target_language" | "target_variant" | "level";

/** PUT /api/profile — any subset of the picker keys, strings of at most 80
 *  characters: the name and native language are written to the active
 *  learner's row, the target language, variant and level to its active
 *  language profile's; a blank value clears the key (not the name, which a
 *  learner needs). Goals and notes are edited with PATCH
 *  /api/learners/:id/languages/:languageId. */
export type ProfileRequest = Partial<Record<PickerKey, string>>;

/** The learner's profile (learner and active language) as stored after the write. */
export interface ProfileReply {
  profile: Profile;
}

/* --------------------------------- packs --------------------------------- */

/** The profile keys a pack may override from the UI. Overrides may carry any
 *  profile key. */
export type Overrides = Partial<Record<PickerKey, string>> & Record<string, unknown>;

/** A pack's content: a row of the `packs` table (docs/DATA.md §Packs), the
 *  shape of a seed file (content/packs/<id>.yaml), and the body of PUT
 *  /api/packs/:id and POST /api/assemble. */
export interface PackInput {
  title: string;
  /** ISO timestamp with offset, e.g. 2026-10-19T09:30:00-06:00. */
  created: string;
  /** A scenario id, or "" when quick_scenario is used. */
  scenario: string;
  quick_scenario: string;
  /** Unit ids; order within a slot follows this list. */
  units: string[];
  overrides: Overrides;
  notes: string;
}

/** A saved pack, the active learner's: its content plus its id — `<slug>`
 *  or `<folder>/<slug>`, the path its seed file would have under packs/
 *  without .yaml — and the folder it is in ("" at the top level). */
export interface Pack extends PackInput {
  id: string;
  folder: string;
}

/** GET /api/packs — the active learner's packs sorted by id (top-level ones
 *  first, by date); `folders` is every folder it has, an empty one
 *  included, sorted. `problems` is always empty now that packs are rows, not
 *  files that can fail to load; kept so the Library's list stays one shape. */
export interface PacksReply {
  packs: Pack[];
  folders: string[];
  problems: Problem[];
}

/** GET /api/packs/:id */
export interface PackReply {
  pack: Pack;
}

/** PUT /api/packs/:id, POST /api/packs/:id/move and /rename: the pack as
 *  stored (after a move or rename, `pack.id` is the new id). Every write is
 *  also a revision (GET /api/pack-revisions). */
export type PackWriteReply = PackReply;

/** DELETE /api/packs/:id — a soft delete: the pack is listed under
 *  GET /api/pack-revisions/deleted until it is restored. */
export interface PackDeleteReply {
  ok: true;
}

/** POST /api/packs/:id/move — "" moves the pack to the top level. 409 when
 *  the destination already has a pack with that slug. */
export interface PackMoveRequest {
  folder: string;
}

/** POST /api/packs/:id/rename — the new title; the slug becomes
 *  `<its date>-<slug of title>` too. 409 when that id is taken. */
export interface PackRenameRequest {
  title: string;
}

/** POST /api/folders — a kebab-case name; 409 when it exists. */
export interface FolderRequest {
  name: string;
}

export interface FolderReply {
  folder: string;
  folders: string[];
}

/** DELETE /api/folders/:name — only a folder with no packs; 409 otherwise. */
export interface FolderDeleteReply {
  ok: true;
  folders: string[];
}

/** What a revision recorded: each write of a pack, and its import. */
export type PackAction = "create" | "update" | "move" | "rename" | "delete" | "restore" | "import";

/** One pack revision: the pack as it was after `action` (before it, for a
 *  delete: the content that was deleted). */
export interface PackRevision {
  /** The revision's id: what POST /api/pack-revisions/:revision/restore takes. */
  revision: string;
  action: PackAction;
  /** ISO timestamp. */
  at: string;
  pack: Pack;
}

/** GET /api/pack-revisions?id=<pack id>[&offset=] (the live pack there,
 *  else the most recently deleted one) or ?revision=<revision id> (the pack
 *  that revision belongs to) — its revisions, newest first, 100 a page
 *  (renames and moves included: they are the same pack). `next` is the
 *  offset of the next page, null after the last. */
export interface PackRevisionsReply {
  revisions: PackRevision[];
  next: number | null;
}

/** A soft-deleted pack: `revision` is its delete, what
 *  POST /api/pack-revisions/:revision/undelete takes. */
export interface DeletedPack {
  revision: string;
  /** ISO timestamp. */
  deletedAt: string;
  pack: Pack;
}

/** GET /api/pack-revisions/deleted[?offset=] — the most recently deleted
 *  first, 50 a page; `next` as in PackRevisionsReply. */
export interface DeletedPacksReply {
  packs: DeletedPack[];
  next: number | null;
}

/** POST /api/pack-revisions/:revision/restore — a live pack takes that
 *  revision's content and keeps its id (409 when the pack is deleted:
 *  undelete it first). POST /api/pack-revisions/:revision/undelete — the
 *  deleted pack that revision belongs to comes back as it was deleted, at
 *  the id it had (409 when it is not deleted, or a live pack has taken the
 *  id). Either is itself a `restore` revision. */
export type PackRestoreReply = PackReply;

/* ------------------------------- assembly -------------------------------- */

export interface AssembleRequest {
  pack: Partial<PackInput>;
}

export interface Stats {
  words: number;
  /** words × 1.3, rounded — an estimate for a voice tool's context limit. */
  tokens: number;
  chars: number;
}

/** POST /api/assemble */
export interface AssembleResult {
  markdown: string;
  /** Human-readable sentences: cardinality, missing required slot, unknown
   *  unit/scenario/placeholder. Never fatal — the markdown is always there. */
  warnings: string[];
  stats: Stats;
}

/** POST /api/export — `id` names exports/<id>.md. */
export interface ExportRequest {
  pack: Partial<PackInput>;
  id: string;
}

export interface ExportResult {
  /** Absolute path of the written file. */
  path: string;
  stats: Stats;
  warnings: string[];
}

/** Every non-2xx reply. */
export interface ErrorReply {
  error: string;
}

/* ---------------------------------- auth --------------------------------- */
// Logins and learners (docs/DATA.md §Auth). The session is an httpOnly
// cookie the browser never reads; these are the shapes around it.

/** The logged-in account. */
export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

/** A learner: who is practising, under a login. The profile keys are
 *  profile.yaml's (snake_case, as the assembler and the pickers know them);
 *  `name` is the profile's learner_name. The mode is fixed at creation.
 *  `languages` are the learner's live language profiles, oldest first (one
 *  at least). */
export interface LearnerInfo {
  id: string;
  name: string;
  mode: Mode;
  native_language: string;
  languages: LanguageInfo[];
}

/** One language a learner practises (a language profile): profile.yaml's
 *  per-language keys. Packs and conversations belong to one. */
export interface LanguageInfo {
  id: string;
  learner_id: string;
  target_language: string;
  target_variant: string;
  level: string;
  goals: string;
  notes: string;
}

/** GET /api/auth/me (public), and the reply of login and first run.
 *  `firstRun`: there are no accounts yet, so the UI shows "Create the first
 *  account" instead of the login form. `learner` is the session's active
 *  learner, null until one is picked ("Who's practicing?"). */
export interface MeReply {
  firstRun: boolean;
  /** Only with firstRun: this request may create the first account (a direct
   *  local one). Absent or false: the page says to do it on the Mac. */
  firstRunHere?: boolean;
  user: AuthUser | null;
  learner: LearnerInfo | null;
  /** The session's active language, one of `learner.languages`; null
   *  exactly when `learner` is. */
  language: LanguageInfo | null;
  learners: LearnerInfo[];
}

/** Every error reply: a sentence to show, and for the few errors the client
 *  acts on, a code.
 *
 *  `stale_learner` (409): a learner-scoped route (profile, packs, folders,
 *  assemble, export, voice turn and cast, conversations) was called for a
 *  learner or a language that isn't the session's active one — the page's
 *  `X-Learner-Id` header (LearnerHeader) names another learner or none, its
 *  `X-Language-Profile-Id` (LanguageHeader) another language or none, or
 *  nobody is picked. Another tab switched learner or language, archived
 *  one, or logged in as someone else. The client re-reads /api/auth/me
 *  instead of showing it.
 *
 *  `conversation_ended` (409) and `no_conversation` (404): a voice turn named
 *  a saved conversation that is over or being ended (End, leaving Go, two idle hours) or
 *  that this learner doesn't have (deleted, or never theirs). The Go tab
 *  starts a new conversation from that turn on and sends it again. */
export interface ErrorReply {
  error: string;
  code?: ErrorCode;
}
export type ErrorCode = "stale_learner" | "conversation_ended" | "no_conversation";
/** The request header naming the learner the page is rendering. */
export type LearnerHeader = "X-Learner-Id";
/** The request header naming the language (profile) the page is rendering. */
export type LanguageHeader = "X-Language-Profile-Id";

/** POST /api/auth/login and POST /api/auth/first-run. 401 on a wrong
 *  username or password (the same sentence for both), 429 while throttled,
 *  409 from first-run once any account exists. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** POST /api/learners: name and mode required, with the learner's first
 *  language (its target language, variant, level, goals and notes; a
 *  learner always has one). PATCH /api/learners/:id takes only name and
 *  native_language (the mode can't change; a language is edited on its own
 *  route). Strings of at most 80 characters, goals and notes up to 2000. */
export type LearnerRequest = Partial<{ name: string; mode: Mode; native_language: string } & LanguageRequest>;

/** POST /api/learners/:id/languages (a new language) and PATCH
 *  /api/learners/:id/languages/:languageId (any subset). */
export type LanguageRequest = Partial<Omit<LanguageInfo, "id" | "learner_id">>;

export interface LanguagesReply {
  languages: LanguageInfo[];
}

export interface LanguageReply {
  language: LanguageInfo;
}

/** PUT /api/auth/language — make one of the active learner's languages the
 *  session's active one. Answers with MeReply. */
export interface PickLanguageRequest {
  languageId: string;
}

export interface LearnersReply {
  learners: LearnerInfo[];
}

export interface LearnerReply {
  learner: LearnerInfo;
}

/** PUT /api/auth/learner — make one of your learners the session's active
 *  one (null: back to the picker), with its last-used language. Answers with
 *  MeReply. */
export interface PickLearnerRequest {
  learnerId: string | null;
}

/* ---------------------------------- chat --------------------------------- */

/** One message of the agent chat (agent_messages; data/chat.jsonl before
 *  logins, the first admin's seed). `commit` lines record an auto-commit the
 *  server made after an agent turn: text is "<short hash>: <summary>". */
export type ChatRole = "user" | "assistant" | "commit";

export interface ChatMessage {
  role: ChatRole;
  text: string;
  /** ISO timestamp. */
  ts: string;
}

/** GET /api/chat/history */
export interface ChatHistoryReply {
  messages: ChatMessage[];
}

/** POST /api/chat — answered as SSE (see the Chat* event shapes). 409 when a
 *  run is already in progress: one agent at a time, by design. */
export interface ChatRequest {
  message: string;
  /** The library the user is looking at; the agent is told to edit that
   *  tree. Adult when absent. */
  mode?: Mode;
}

/** SSE `start`: the run began, with the model it went out on. */
export interface ChatStart {
  model: string;
}

/** SSE `heartbeat`, every few seconds while the agent works. */
export interface ChatHeartbeat {
  elapsed: number;
}

/** SSE `message`: the agent's final reply (the CLI buffers the whole turn, so
 *  there is nothing to stream before it). `denied` counts tool calls the
 *  sandbox refused — a Write outside content/, say. */
export interface ChatReply extends ChatMessage {
  role: "assistant";
  costUsd: number | null;
  numTurns: number | null;
  denied: number;
}

/** SSE `commit`, after the reply: what the server did with content/. */
export type ChatCommit =
  | { hash: string; summary: string }
  | { skipped: true }
  | { error: string };

/** SSE `error` (the run failed; `error` is a sentence with a hint when the
 *  cause is known: sign-in, usage limit) and `done` (always last). */
export interface ChatError {
  error: string;
}
export interface ChatDone {
  ok: boolean;
}

/* -------------------------------- settings ------------------------------- */

export interface AgentModel {
  /** What the CLI's --model accepts, e.g. "claude-sonnet-5-5". */
  id: string;
  label: string;
  note: string;
}

/** GET/PUT /api/settings — `models` is the list the UI may pick from; PUT
 *  takes {model} and answers with the same shape. */
export interface SettingsReply {
  model: string;
  models: AgentModel[];
}

export interface SettingsRequest {
  model: string;
}

/* --------------------------------- voice --------------------------------- */
// Practice a pack by voice inside the app (web/server/voice.ts): record →
// transcribe → one dojo-master turn → speak each line. Provider keys stay on
// the server (repo-root .env.local); nothing below carries one.

/** Who synthesizes speech. "system" is macOS `say`: free and offline. */
export type TtsProvider = "elevenlabs" | "azure" | "system";
/** Who transcribes the learner. */
export type SttProvider = "elevenlabs" | "azure";
/** The voices a frame names; kids mode adds the sidekick. */
export type VoiceSpeaker = "narrator" | "character" | "sidekick";
/** Whose voice a line is: the dojo master tags it (-F / -M). */
export type VoiceGender = "female" | "male";
/** How old a voice sounds, and how old the dojo master says a character
 *  is (a CAST line). ElevenLabs labels library voices young, middle_aged or
 *  old; "child" is only ever asked for, and matched by the youngest voices. */
export type VoiceAge = "child" | "young" | "middle" | "old";

/** A CAST line: who the dojo master says now speaks with one voice tag, so
 *  the app can give that tag a voice of the right age. Shown, not spoken. */
export interface VoiceCastNote {
  /** "character:female", "narrator:male", "sidekick:female"… */
  slot: string;
  age: VoiceAge;
  /** A few words on who it is ("Doña Carmen, the fruit vendor"). */
  who: string;
}
/** A voice choice: a speaker as a woman or a man, e.g. "character:female".
 *  (A bare speaker id is an older, ungendered choice, still honoured.) */
export type VoiceSlot = `${VoiceSpeaker}:${VoiceGender}`;
/** "tap": the learner stops the recording themselves. "pause": it stops
 *  after `silenceMs` of quiet once they have started talking. */
export type TurnTaking = "tap" | "pause";

/** One user's voice settings (user_settings.voice; data/voice.json before
 *  logins), always complete (the server normalizes what it reads). */
export interface VoiceSettings {
  tts: TtsProvider;
  stt: SttProvider;
  /** ElevenLabs synthesis model id. */
  elevenModel: string;
  /** Claude model for the dojo master's turns. */
  model: string;
  turn: TurnTaking;
  silenceMs: number;
  /** Show the transcript for a check (and an edit) before it is sent. */
  review: boolean;
  /** Start listening again as soon as the dojo master finishes. */
  handsFree: boolean;
  /** The Go tab's last "How long do you have?" choice per mode, in minutes;
   *  null = No limit. The picker starts here when the pack has no minutes. */
  sessionMinutes: Record<Mode, number | null>;
  /** provider → locale (BCP-47) → slot ("character:female") → voice id. */
  voices: Partial<Record<TtsProvider, Record<string, Partial<Record<VoiceSlot | VoiceSpeaker, string>>>>>;
}

export interface VoiceOption {
  id: string;
  label: string;
  note: string;
}

/** GET/PUT /api/voice/settings. PUT takes a partial VoiceSettings (`voices`
 *  replaces the whole map) and answers with this shape. */
export interface VoiceSettingsReply {
  settings: VoiceSettings;
  /** Which providers have what they need (a key; macOS for "system"). */
  configured: Record<TtsProvider, boolean>;
  models: VoiceOption[];
  elevenModels: VoiceOption[];
  silence: { min: number; max: number; default: number };
  speakers: Record<Mode, VoiceSpeaker[]>;
  /** Each mode's voice slots, in picker order. */
  slots: Record<Mode, VoiceSlot[]>;
  /** The "How long do you have?" picker's lengths per mode, in minutes
   *  (No limit is always offered too). */
  minuteChoices: Record<Mode, number[]>;
  /** Where the keys go, repo-relative, for the setup hint. */
  envFile: string;
  /** BCP-47 locales for the session languages named in the query
   *  (?target=&variant=&native=); null when unknown or not asked. */
  locales: { target: string | null; native: string | null };
}

/** `sessionMinutes` merges per mode: send only the mode that changed. */
export type VoiceSettingsRequest = Partial<Omit<VoiceSettings, "sessionMinutes">> & { sessionMinutes?: Partial<Record<Mode, number | null>> };

/** One entry of a provider's voice list. `match`: it speaks the locale asked
 *  for natively (listed first). */
export interface VoiceChoice {
  id: string;
  name: string;
  gender: string;
  note: string;
  match: boolean;
  /** How old it sounds, when the provider labels it. */
  age?: VoiceAge | "";
  /** An ElevenLabs premade voice (usable on any plan). */
  premade?: boolean;
}

/** GET /api/voice/voices?provider=&locale= */
export interface VoicesReply {
  provider: TtsProvider;
  locale: string;
  voices: VoiceChoice[];
}

/** Which language a piece of a line is in: the session's target or the
 *  learner's native language. The dojo master marks target words; each piece
 *  is synthesized in its own language by the speaker's one voice. */
export type SegmentLang = "target" | "native";

export interface VoiceSegment {
  lang: SegmentLang;
  text: string;
}

/** One spoken line of a dojo-master turn. `text` is the segments joined, for
 *  display and copying. */
export interface VoiceLine {
  speaker: VoiceSpeaker;
  /** null when the dojo master didn't say. */
  gender: VoiceGender | null;
  text: string;
  segments: VoiceSegment[];
  /** The dojo master's own timing mark, seconds: <pause N> → N,
   *  <overlap N> → -N. Absent when it gave none. */
  gap?: number;
  /** The delay to play before this line, ms (negative = overlap), resolved
   *  by the server from `gap` and who is speaking. 0 for the first line. */
  pauseMs?: number;
}

/** The session so far, as the client holds it (the server keeps none). */
/** A tap-to-see definition from the dojo master's GLOSS line: `term` is the
 *  target-language text as spoken (a word, a set phrase, or a whole
 *  sentence), `meaning` its meaning in the learner's native language. */
export interface VoiceGloss {
  term: string;
  meaning: string;
}

export type VoiceHistoryItem =
  | { role: "learner"; text: string }
  | { role: "master"; lines: VoiceLine[]; glosses?: VoiceGloss[]; choices?: string[]; stage?: string; castNotes?: VoiceCastNote[] };

/** One part of a session, for the timeline (scripts/voice.mjs sessionPlan):
 *  "intro", "warmup:<unit>", "scene", "beat:<n>", "debrief:<unit>", and in
 *  kids mode "games:<unit>" and "ending:<unit>". */
export interface VoicePlanItem {
  id: string;
  title: string;
  kind: string;
  /** A scene beat's full text (the title is its first clause). */
  detail?: string;
}

/** POST /api/voice/turn — an empty `message` opens the session. 409 while
 *  another turn is running. */
export interface VoiceTurnRequest {
  mode: Mode;
  pack: PackInput;
  history: VoiceHistoryItem[];
  message: string;
  /** The session's narrator gender, drawn at session start (/cast); ignored
   *  when the pack's narrator unit fixes it. */
  narratorGender?: VoiceGender;
  /** Milliseconds since the session's first turn (0 on the first). With
   *  `pack.overrides.minutes` set, the server adds a clock line to the turn
   *  from it; the model has no sense of time otherwise. */
  elapsedMs?: number;
  /** The saved conversation this turn belongs to (POST /api/conversations).
   *  Absent: the turn runs but is not saved (creating it failed, or the
   *  conversation ended while Go was hidden). */
  conversationId?: string;
  /** The index in `history` of the conversation's first entry: 0, unless it
   *  was started mid-session (after leaving Go, or two idle hours, ended the
   *  one before). The stored turns mirror history from there on, as far as
   *  the server lets a history rewrite them (DATA.md §Conversations). A
   *  conversation made after turns went unsaved starts where saving stopped,
   *  so those turns are stored too. */
  conversationStart?: number;
}

export interface VoiceTurnReply {
  lines: VoiceLine[];
  glosses: VoiceGloss[];
  /** Quick answers to a check-in question, shown as buttons; [] for most turns. */
  choices: string[];
  /** The session's parts, in order. */
  plan: VoicePlanItem[];
  /** The part this turn ended in (a plan id), or null when it didn't say. */
  stage: string | null;
  /** Who this turn says each voice tag now is ([] when nobody new came in).
   *  A Random slot whose voice is the wrong age gets recast (/cast with
   *  `ages`) before the turn plays. */
  castNotes: VoiceCastNote[];
  model: string;
  durationMs: number | null;
  costUsd: number | null;
  /** The assembler's warnings for the pack, so a broken pack is visible. */
  warnings: string[];
  /** With a `conversationId`: whether this turn (and the learner's message)
   *  is stored. False when the write failed, or the conversation ended or
   *  was deleted meanwhile; the turn still stands. */
  saved?: boolean;
}

/* ------------------------------ conversations ----------------------------- */
// Saved voice sessions (docs/DATA.md §Conversations), the active learner's
// active language's.

/** POST /api/conversations: the session's first turn is about to run. */
export interface ConversationCreateRequest {
  mode: Mode;
  /** The pack as the first turn plays it (its minutes are the session length). */
  pack: PackInput;
  /** The scene title the Go tab shows. */
  title?: string;
}

/** One conversation, as History lists it. Times are ISO strings. */
export interface ConversationSummary {
  id: string;
  title: string;
  mode: Mode;
  scenarioId: string | null;
  /** The session's languages, as they were when it started (the learner's
   *  profile under the pack's overrides); "" for none. */
  nativeLanguage: string;
  targetLanguage: string;
  targetVariant: string;
  /** The dojo master's model, as of the last saved turn. */
  model: string | null;
  /** The session length, as of the last saved turn; null = no limit. */
  plannedMinutes: number | null;
  startedAt: string;
  /** null while open. An idle-ended conversation ends at its last turn. */
  endedAt: string | null;
  /** The last saved turn's time; null before any. */
  lastTurnAt: string | null;
  /** Stored turns: the learner's and the dojo master's, each one. */
  turnCount: number;
  /** The post-session recap's summary; null until that phase exists. */
  summary: string | null;
}

export interface ConversationReply {
  conversation: ConversationSummary;
}

/** GET /api/conversations?offset=&limit= : newest first. */
export interface ConversationsReply {
  conversations: ConversationSummary[];
  /** The offset of the next page, or null on the last. */
  nextOffset: number | null;
}

/** A stored turn: the transcript entry as the session showed it, plus where
 *  and when it is, and for a dojo-master turn what it cost. */
export type ConversationTurn = VoiceHistoryItem & {
  idx: number;
  at: string;
  durationMs: number | null;
  costUsd: number | null;
};

/** GET /api/conversations/:id?from=&limit= : turns from idx `from` on. */
export interface ConversationTurnsReply {
  conversation: ConversationSummary;
  turns: ConversationTurn[];
  /** The idx to ask for next, or null when these are the last. */
  nextFrom: number | null;
  /** The session's parts (from the pack as played), for jump labels. */
  plan: VoicePlanItem[];
  /** The session's target locale, for the transcript's glosses; null when
   *  unknown. From the conversation's saved languages, never the profile. */
  locale: string | null;
  /** The session's native locale, for the translate buttons' label. */
  nativeLocale: string | null;
}

/** POST /api/voice/speak → audio bytes (audio/mpeg, or audio/wav for
 *  "system"). The provider and voice come from the saved settings. */
export interface VoiceSpeakRequest {
  speaker: VoiceSpeaker;
  text: string;
  /** The session's target locale; picks the voice set. */
  locale: string;
  /** The language this text is in; "target" when absent. */
  lang?: SegmentLang;
  /** The learner's native locale, for "native" text. */
  nativeLocale?: string;
  /** Picks the woman's or man's voice for the speaker. */
  gender?: VoiceGender | null;
  /** The session cast's voice for this line; overrides the saved choice
   *  when `provider` is the one now in use. */
  voice?: string;
  /** The provider the cast was drawn for. */
  provider?: TtsProvider;
  /** An account voice of the same gender (VoiceCastReply.fallbacks) for
   *  when the provider refuses `voice` and no voice is saved. */
  fallback?: string;
}

/** POST /api/voice/cast — this session's voices, drawn at session start. */
export interface VoiceCastRequest {
  mode: Mode;
  locale: string;
  /** The pack's unit ids: a narrator-female/-male unit fixes the gender. */
  units: string[];
  /** Slot → the age wanted; a slot without one takes any age. */
  ages?: Record<string, VoiceAge>;
  /** Draw only these slots (a recast mid-session); all when absent. */
  slots?: string[];
  /** Voice ids already playing other slots, to avoid when drawing. */
  avoid?: string[];
}

export interface VoiceCastReply {
  provider: TtsProvider;
  locale: string;
  /** Slot ("narrator:female") → the voice playing it this session, with
   *  how old it sounds when the provider says ("" when unknown). Only the
   *  requested `slots` on a recast. */
  cast: Record<string, { id: string; name: string; age?: VoiceAge | "" }>;
  narratorGender: VoiceGender;
  /** True when the pack fixed the narrator's gender. */
  pinned: boolean;
  /** Slot → an account voice of that gender, for ElevenLabs: what a line
   *  falls back to when a drawn library voice is refused (a free plan) and
   *  the learner saved no voice of their own. */
  fallbacks?: Record<string, string>;
}

/** One voice from the ElevenLabs Voice Library. */
export interface LibraryVoice {
  id: string;
  /** The sharer's public id; needed to add the voice to the account. */
  ownerId: string;
  name: string;
  description: string;
  accent: string;
  gender: string;
  age: string;
  useCase: string;
  locale: string;
  previewUrl: string;
  /** Characters generated with it in the last year / week: popularity. */
  usage1y: number;
  usage7d: number;
  clonedBy: number;
  /** Already in the account. */
  added: boolean;
}

export type LibrarySort = "usage_character_count_1y" | "trending" | "cloned_by_count" | "created_date";

/** GET /api/voice/library?locale=&gender=&q=&sort=&page= */
export interface LibraryReply {
  voices: LibraryVoice[];
  hasMore: boolean;
  total: number | null;
}

/** POST /api/voice/library/add — adds a library voice to the ElevenLabs
 *  account and answers with the id to synthesize with. */
export interface LibraryAddRequest {
  ownerId: string;
  voiceId: string;
  name: string;
}
export interface LibraryAddReply {
  voiceId: string;
}

/** POST /api/voice/transcribe?locales=en-US,zh-CN with a WAV body. */
export interface TranscribeReply {
  text: string;
  provider: SttProvider;
}

/* -------------------------------- phrase bank ------------------------------- */
// The active language's phrase bank (docs/DATA.md §Phrase bank): what the
// dojo master glossed, the scenarios' lists, and what the learner starred or
// added. Times are ISO strings.

export type MasteryBand = "New" | "Learning" | "Familiar" | "Mastered";
export type PhraseSource = "gloss" | "extraction" | "manual" | "scenario";
/** The bank view's filters (GET /api/phrases?show=). */
export type PhraseShow = "all" | "starred" | "new" | "due" | "trouble" | "pending" | "suspended";
export type PhraseSort = "recent" | "due" | "weakest" | "alpha" | "added";

/** One phrase as the bank lists it, with its metrics (DATA.md §Metrics). */
export interface PhraseSummary {
  id: string;
  /** The target form; null while pending (a scenario meaning, no words yet). */
  text: string | null;
  meaning: string | null;
  note: string | null;
  /** The variant it was first met in (BCP-47, e.g. es-MX); "" when unknown. */
  lang: string;
  source: PhraseSource;
  pending: boolean;
  starred: boolean;
  suspended: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  seenCount: number;
  lastPracticedAt: string | null;
  createdAt: string;
  /** The band of its weakest card; New with no cards. */
  mastery: MasteryBand;
  /** The earliest due time of its cards that have been reviewed; null
   *  when none has (a card never reviewed is new, not due). */
  due: string | null;
  /** Its cards never reviewed yet: waiting to be learned. */
  newCards: number;
  /** Lapses in the last 30 days, and whether that many is "trouble". */
  lapses: number;
  trouble: boolean;
  cardCount: number;
  exampleCount: number;
}

export interface PhraseExample {
  id: string;
  sentence: string;
  /** Who said it (the transcript's speaker tag); null when unknown. */
  speaker: string | null;
  /** The saved conversation it came from; null once that is deleted. */
  conversationId: string | null;
  createdAt: string;
}

/** One phrase with everything the bank shows when it is opened. */
export interface PhraseDetail extends PhraseSummary {
  examples: PhraseExample[];
  /** Other target forms the grader accepted. */
  alternates: string[];
}

/** GET /api/phrases?q=&show=&band=&sort=&offset=&limit= */
export interface PhrasesReply {
  phrases: PhraseSummary[];
  /** How many match the filters (before paging). */
  total: number;
  nextOffset: number | null;
  /** Over the whole bank, for the filter chips. */
  counts: Record<Exclude<PhraseShow, "all">, number> & { all: number; bands: Record<MasteryBand, number> };
  /** The bank's language: the active profile's target language and variant. */
  language: { targetLanguage: string; targetVariant: string; locale: string | null };
}

/** POST /api/phrases (add or star: words already in the bank are starred
 *  and keep their own meaning and note when they have them), and PATCH
 *  /api/phrases/:id (any of these; null or "" clears meaning and note). */
export interface PhraseInput {
  text?: string;
  meaning?: string | null;
  note?: string | null;
  starred?: boolean;
  suspended?: boolean;
}

/** POST, GET /:id and PATCH /:id. `created` (POST only): false when the
 *  words were already in the bank. */
export interface PhraseReply {
  phrase: PhraseDetail;
  created?: boolean;
}

/** GET /api/phrases/lookup?text= : the phrase with these words, if any. */
export interface PhraseLookupReply {
  phrase: PhraseSummary | null;
}
