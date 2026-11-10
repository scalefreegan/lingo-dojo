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
  /** Optional complications a variation unit may pick from. */
  twists: string[];
  body: string;
  path: string;
}

/** content/profile.yaml. The keys below are the contract's; any other key
 *  is allowed and rendered in the Learner block. */
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
}

/** A file the loader could not use (`error`: left out of the library) or
 *  used with a caveat (`warning`). Never thrown, always listed. */
export interface Problem {
  file: string;
  level: "error" | "warning";
  message: string;
}

/** The two libraries: "adult" is content/, "kids" is content/kids/ (its own
 *  schema, frame, profile, units, scenarios and packs). Every content, pack,
 *  folder, assemble, export and profile route takes `?mode=`; adult when
 *  absent. */
export type Mode = "adult" | "kids";

/** GET /api/content?mode= — the loader's result minus packs (they have their
 *  own routes), re-read from disk on every call so an agent or editor change
 *  shows up without a restart. */
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

/** PUT /api/profile?mode= — any subset of the picker keys, strings of at
 *  most 80 characters; a blank value removes the key from that mode's
 *  profile.yaml. Everything else in the profile (goals, notes) is edited in
 *  the file. */
export type ProfileRequest = Partial<Record<PickerKey, string>>;

/** The profile as it reads back from disk after the write. */
export interface ProfileReply {
  profile: Profile;
}

/* --------------------------------- packs --------------------------------- */

/** The profile keys a pack may override from the UI. Overrides on disk may
 *  carry any profile key. */
export type Overrides = Partial<Record<PickerKey, string>> & Record<string, unknown>;

/** What a pack file holds (content/packs/<id>.yaml), and the body of PUT
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

/** A saved pack: the file plus its id — the path under content/packs
 *  without .yaml, `<stem>` or `<folder>/<stem>` — and the folder it is in
 *  ("" at the top level). */
export interface Pack extends PackInput {
  id: string;
  folder: string;
}

/** GET /api/packs — packs sorted by id (top-level ones first, by date);
 *  `folders` is every directory under content/packs, an empty one included,
 *  sorted. `problems` are the pack files that failed to load. */
export interface PacksReply {
  packs: Pack[];
  folders: string[];
  problems: Problem[];
}

/** GET /api/packs/:id */
export interface PackReply {
  pack: Pack;
}

/** The git half of a pack write (the server commits content/packs after
 *  each one as `packs: <summary>`). `commit` is null when there was nothing
 *  to commit (an identical save) or when git failed; only the failure sets
 *  `error`. Either way the write itself succeeded — this rides on a 200. */
export interface Committed {
  commit: { hash: string; summary: string } | null;
  error?: string;
}

/** PUT /api/packs/:id, POST /api/packs/:id/move and /rename: the pack as it
 *  reads back from disk (after a move or rename, `pack.id` is the new id). */
export interface PackWriteReply extends PackReply, Committed {}

/** DELETE /api/packs/:id */
export interface PackDeleteReply extends Committed {
  ok: true;
}

/** POST /api/packs/:id/move — "" moves the pack to the top level. 409 when
 *  the destination already has a pack with that stem. */
export interface PackMoveRequest {
  folder: string;
}

/** POST /api/packs/:id/rename — the new title; the file is renamed to
 *  `<its date>-<slug of title>` too. 409 when that name is taken. */
export interface PackRenameRequest {
  title: string;
}

/** POST /api/folders — a kebab-case name; 409 when it exists. */
export interface FolderRequest {
  name: string;
}

export interface FolderReply extends Committed {
  folder: string;
  folders: string[];
}

/** DELETE /api/folders/:name — only an empty folder; 409 otherwise. */
export interface FolderDeleteReply extends Committed {
  ok: true;
  folders: string[];
}

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

/* ---------------------------------- chat --------------------------------- */

/** One line of data/chat.jsonl. `commit` lines record an auto-commit the
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
/** A voice choice: a speaker as a woman or a man, e.g. "character:female".
 *  (A bare speaker id is an older, ungendered choice, still honoured.) */
export type VoiceSlot = `${VoiceSpeaker}:${VoiceGender}`;
/** "tap": the learner stops the recording themselves. "pause": it stops
 *  after `silenceMs` of quiet once they have started talking. */
export type TurnTaking = "tap" | "pause";

/** data/voice.json, always complete (the server normalizes what it reads). */
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
  /** Where the keys go, repo-relative, for the setup hint. */
  envFile: string;
  /** BCP-47 locales for the session languages named in the query
   *  (?target=&variant=&native=); null when unknown or not asked. */
  locales: { target: string | null; native: string | null };
}

export type VoiceSettingsRequest = Partial<VoiceSettings>;

/** One entry of a provider's voice list. `match`: it speaks the locale asked
 *  for natively (listed first). */
export interface VoiceChoice {
  id: string;
  name: string;
  gender: string;
  note: string;
  match: boolean;
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
  | { role: "master"; lines: VoiceLine[]; glosses?: VoiceGloss[]; choices?: string[]; stage?: string };

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
  model: string;
  durationMs: number | null;
  costUsd: number | null;
  /** The assembler's warnings for the pack, so a broken pack is visible. */
  warnings: string[];
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
}

/** POST /api/voice/cast — this session's voices, drawn at session start. */
export interface VoiceCastRequest {
  mode: Mode;
  locale: string;
  /** The pack's unit ids: a narrator-female/-male unit fixes the gender. */
  units: string[];
}

export interface VoiceCastReply {
  provider: TtsProvider;
  locale: string;
  /** Slot ("narrator:female") → the voice playing it this session. */
  cast: Record<string, { id: string; name: string }>;
  narratorGender: VoiceGender;
  /** True when the pack fixed the narrator's gender. */
  pinned: boolean;
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
