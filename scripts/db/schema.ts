// The whole database schema (docs/DATA.md §Schema), shared by the dev server
// (web/server/db.ts), the CLIs and the tests. drizzle-kit diffs this file
// against the last snapshot to write the SQL under ./migrations, which is
// what actually reaches a database; this file is never executed against one.
//
// Erasable TypeScript only (no enums, namespaces or parameter properties):
// Node runs it by stripping types, so `node --test` imports it directly.
//
// Ownership. Every personal row carries its owner: `user_id` for account rows,
// `learner_id` for everything a learner makes. Child tables (turns, cards,
// reviews, …) carry the learner too, denormalized, and reach their parent
// through a composite foreign key on (parent id, learner_id). That makes a
// child that belongs to a different learner than its parent impossible, lets
// the owned-row helper (owned.ts) treat every personal table alike, and lets
// the row-level security of the read-only role (migration 0005) be one
// `learner_id = … and language_profile_id = …` policy per table instead of
// a join per table.
//
// One level deeper (migration 0002): what belongs to one of a learner's
// languages (packs, pack folders, pack revisions, conversations, turns)
// also carries `language_profile_id`, and reaches the profile through
// (language_profile_id, learner_id) → language_profiles (id, learner_id). A
// child of such a row (a revision, a turn) reaches its parent through both
// (parent id, learner_id) and (parent id, language_profile_id), so it can't
// sit under another language, learner or account than its parent. The
// phrase bank joined them in migration 0003: phrases, their examples, cards,
// reviews and cloze items belong to one language profile too (a learner's
// Spanish bank and German bank are separate), the phrase reaching its
// profile through (language_profile_id, learner_id) and each child its
// parent through both (parent id, learner_id) and (parent id,
// language_profile_id).
//
// Deletes cascade from a parent to children that mean nothing without it
// (a learner's packs, a conversation's turns, a phrase's cards). Links that
// are only provenance (a review's conversation, an example's turn, a
// session's active learner) are composite too, so they can't point at another
// owner's row, and on delete they null only the link column
// (`ON DELETE SET NULL (col)`, PostgreSQL 15+). Deleting a conversation never
// erases memory. drizzle-kit can't write the column list: those keys are
// declared below with a plain "set null", and hand-edits.mjs rewrites them in
// the generated SQL. A test regenerates the migration and checks that the
// committed file is exactly the generated one plus those edits.
//
// Row-level security (migration 0005, bead ld-t5f): the five tables the
// content agent's read-only bank MCP reads (conversations, turns, phrases,
// cards, reviews) have RLS enabled (`.enableRLS()`), NOT forced. The table
// owner, which is the role the app connects as, bypasses it entirely, so no
// app query changes. The policies, the read-only role they apply to and its
// column grants can't be expressed here (the role's name is configurable),
// so they are the hand edit in hand-edits.mjs (docs/DATA.md §Content agent).

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Overrides, RandomScene, VoiceCastNote, VoiceGloss, VoiceLine } from "../../web/shared/wire.ts";

/* --------------------------------- helpers -------------------------------- */

const id = () => uuid("id").primaryKey().defaultRandom();
const tz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tz("created_at").notNull().defaultNow();

/* -------------------------------- accounts -------------------------------- */

export const users = pgTable(
  "users",
  {
    id: id(),
    /** Stored lowercased; the check keeps a mixed-case insert from slipping
     *  past the unique constraint as a second account. */
    username: text("username").notNull().unique(),
    /** `scrypt$N$r$p$salt$hash` (DATA.md §Auth). */
    passwordHash: text("password_hash").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
    disabledAt: tz("disabled_at"),
  },
  (t) => [check("users_username_lowercase", sql`${t.username} = lower(${t.username})`)],
);

export const learners = pgTable(
  "learners",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The profile's learner_name. */
    name: text("name").notNull(),
    mode: text("mode").$type<"adult" | "kids">().notNull(),
    // The one profile.yaml key that belongs to the person rather than to a
    // language (blank allowed, as in the YAML). The per-language keys
    // (target language, variant, level, goals, notes) moved to
    // language_profiles in migration 0002.
    nativeLanguage: text("native_language").notNull().default(""),
    createdAt: createdAt(),
    archivedAt: tz("archived_at"),
  },
  (t) => [
    check("learners_mode", sql`${t.mode} in ('adult', 'kids')`),
    index("learners_user_idx").on(t.userId),
    unique("learners_id_user").on(t.id, t.userId),
  ],
);

/** One language a learner practises: profile.yaml's per-language keys. A
 *  learner keeps at least one that isn't archived; the login session holds
 *  the active one (so two devices can practise two languages), and the most
 *  recently used is where picking the learner lands. Packs and
 *  conversations belong to one of these. */
export const languageProfiles = pgTable(
  "language_profiles",
  {
    id: id(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    targetLanguage: text("target_language").notNull().default(""),
    targetVariant: text("target_variant").notNull().default(""),
    level: text("level").notNull().default(""),
    goals: text("goals").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
    /** Set whenever a session picks it: the learner's newest is the one a
     *  pick of the learner (and the pack import) lands on. */
    lastUsedAt: tz("last_used_at"),
    archivedAt: tz("archived_at"),
  },
  (t) => [
    index("language_profiles_learner_idx").on(t.learnerId),
    unique("language_profiles_id_learner").on(t.id, t.learnerId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    /** SHA-256 (hex) of the cookie token; the token itself is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The active learner, one of this user's (composite key). Deleting
     *  the learner nulls only this column, so the session falls back to the
     *  picker. */
    learnerId: uuid("learner_id"),
    /** The active language, one of the active learner's (composite key), so
     *  two devices of one learner can practise two languages. Archiving a
     *  language moves its sessions to another (archiveLanguageProfile);
     *  deleting the language row nulls only this column. Hard-deleting the
     *  learner is the exception: its key's SET NULL ("learner_id") runs
     *  first, and with learner_id null the composite key (MATCH SIMPLE) no
     *  longer matches, so this column is left naming a deleted profile.
     *  Harmless (no row is read through it without a learner, and the next
     *  pick sets both columns) and no app path hard-deletes a learner
     *  (they are archived); fixing it would need a migration to SET NULL
     *  both columns from the learner key. */
    languageProfileId: uuid("language_profile_id"),
    createdAt: createdAt(),
    expiresAt: tz("expires_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    // Hand-edited to ON DELETE SET NULL ("learner_id") (hand-edits.mjs).
    foreignKey({ name: "auth_sessions_learner_fk", columns: [t.learnerId, t.userId], foreignColumns: [learners.id, learners.userId] }).onDelete("set null"),
    // Hand-edited to ON DELETE SET NULL ("language_profile_id") (hand-edits.mjs).
    foreignKey({ name: "auth_sessions_language_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("set null"),
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_expires_idx").on(t.expiresAt),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The content agent's model; null means the default. */
  model: text("model"),
  /** Today's data/voice.json shape (normalizeVoiceSettings reads it). */
  voice: jsonb("voice").$type<Record<string, unknown>>().notNull().default({}),
});

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Insertion order. `ts` is now() (the transaction's start), so two
     *  messages written in one transaction tie on it; order by this. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    role: text("role").$type<"user" | "assistant" | "commit">().notNull(),
    text: text("text").notNull(),
    ts: tz("ts").notNull().defaultNow(),
    /** Set on the messages of a run that could read a learner's phrase bank
     *  (chat.ts bankAccess): the language profile it read. Such a run's
     *  messages may quote that learner's data, so they are replayed into a
     *  later run only when it reads the same language profile (migration
     *  0005). NULL: a run without the bank, replayed into any run. Deleting
     *  the language profile deletes them with it. */
    bankLanguageProfileId: uuid("bank_language_profile_id").references(() => languageProfiles.id, { onDelete: "cascade" }),
  },
  (t) => [
    check("agent_messages_role", sql`${t.role} in ('user', 'assistant', 'commit')`),
    index("agent_messages_user_seq_idx").on(t.userId, t.seq),
  ],
);

/* ---------------------------------- packs --------------------------------- */

export const packs = pgTable(
  "packs",
  {
    id: id(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** The language it is for, one of the learner's (composite key). */
    languageProfileId: uuid("language_profile_id").notNull(),
    /** "" at the top level, else one kebab segment. */
    folder: text("folder").notNull().default(""),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** The wire value verbatim (ISO with its offset, e.g.
     *  2026-10-19T09:30:00-06:00): timestamptz would drop the offset, and the
     *  pack's date stem is the learner's local date. */
    created: text("created").notNull(),
    scenario: text("scenario").notNull().default(""),
    quickScenario: text("quick_scenario").notNull().default(""),
    /** A random scene (migration 0007): {collections: string[]}, the pool
     *  the scenario is drawn from when a session starts; null for a pack
     *  that names its scene (every pack before 0007). Validated by
     *  web/shared/scenes.ts readRandomScene on every write. */
    randomScene: jsonb("random_scene").$type<RandomScene>(),
    units: jsonb("units").$type<string[]>().notNull().default([]),
    overrides: jsonb("overrides").$type<Overrides>().notNull().default({}),
    notes: text("notes").notNull().default(""),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    deletedAt: tz("deleted_at"),
  },
  (t) => [
    foreignKey({ name: "packs_language_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    // Soft deletes: a deleted pack frees its id for a new one. Ids are per
    // language: each of a learner's languages may have a pack at one id.
    uniqueIndex("packs_profile_folder_slug_live").on(t.languageProfileId, t.folder, t.slug).where(sql`${t.deletedAt} is null`),
    unique("packs_id_learner").on(t.id, t.learnerId),
    unique("packs_id_profile").on(t.id, t.languageProfileId),
  ],
);

/** Folders exist on their own (the Library lists an empty one), which a
 *  `packs.folder` value alone cannot express. */
export const packFolders = pgTable(
  "pack_folders",
  {
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    languageProfileId: uuid("language_profile_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "pack_folders_profile_name_pk", columns: [t.languageProfileId, t.name] }),
    foreignKey({ name: "pack_folders_language_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
  ],
);

export const packRevisions = pgTable(
  "pack_revisions",
  {
    id: id(),
    packId: uuid("pack_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** Revision order (`at` ties within a transaction). */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** The pack row as it was after this action (before it, for a delete). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    action: text("action").$type<"create" | "update" | "move" | "rename" | "delete" | "restore" | "import">().notNull(),
    at: tz("at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.packId, t.learnerId], foreignColumns: [packs.id, packs.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "pack_revisions_pack_profile_fk", columns: [t.packId, t.languageProfileId], foreignColumns: [packs.id, packs.languageProfileId] }).onDelete("cascade"),
    index("pack_revisions_pack_seq_idx").on(t.packId, t.seq),
  ],
);

/* ------------------------------ conversations ----------------------------- */

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** The language practised, one of the learner's (composite key). */
    languageProfileId: uuid("language_profile_id").notNull(),
    /** What was played, frozen: packs change later. */
    packSnapshot: jsonb("pack_snapshot").$type<Record<string, unknown>>().notNull(),
    scenarioId: text("scenario_id"),
    title: text("title").notNull().default(""),
    mode: text("mode").$type<"adult" | "kids">().notNull(),
    // The session's languages as they were (the learner's profile under the
    // pack's overrides, assemble.mjs effectiveProfile), so History keeps its
    // locales when the profile changes later. "" for none.
    nativeLanguage: text("native_language").notNull().default(""),
    targetLanguage: text("target_language").notNull().default(""),
    targetVariant: text("target_variant").notNull().default(""),
    model: text("model"),
    /** The learner's "How long do you have?" choice; null = no limit. */
    plannedMinutes: integer("planned_minutes"),
    startedAt: tz("started_at").notNull().defaultNow(),
    endedAt: tz("ended_at"),
    turnCount: integer("turn_count").notNull().default(0),
    // The post-session recap (DATA.md §Post-session extraction): the
    // summary, the parsed and resolved model reply, and when it was made.
    summary: text("summary"),
    extraction: jsonb("extraction").$type<Record<string, unknown>>(),
    extractedAt: tz("extracted_at"),
    /** Where the recap is (migration 0004): 'none' (never run: open, or
     *  ended before this existed), 'running' (a run holds the claim),
     *  'done', 'failed' (both tries failed: "Retry recap"), 'skipped'
     *  (nothing the learner said to recap). */
    extractionStatus: text("extraction_status").$type<"none" | "running" | "done" | "failed" | "skipped">().notNull().default("none"),
    /** The running run's token, set by the claim (one UPDATE, so two Ends,
     *  two tabs or a Retry racing the end claim it once) and checked by the
     *  run's final write; null unless running. */
    extractionClaim: uuid("extraction_claim"),
    /** When the current or last run claimed it, to spot a run a restart
     *  killed. */
    extractionStartedAt: tz("extraction_started_at"),
    /** Model calls made for this conversation's recap, all runs. */
    extractionAttempts: integer("extraction_attempts").notNull().default(0),
    /** Why the last run failed, for the log and the recap card. */
    extractionError: text("extraction_error"),
    // Revisit (DATA.md §Revisit, migration 0008): which sessions were the
    // same scene (scripts/revisit.mjs sceneKey: `s:<scenario>`,
    // `q:<md5 of a quick scenario>`, `c:<own id>`), and the earlier attempt
    // this one built on. The link only says where the carry-over came from
    // (the carry-over itself is frozen in pack_snapshot.revisit), so
    // deleting that session nulls it and nothing else.
    sceneKey: text("scene_key"),
    previousConversationId: uuid("previous_conversation_id"),
  },
  (t) => [
    check("conversations_mode", sql`${t.mode} in ('adult', 'kids')`),
    check("conversations_extraction_status", sql`${t.extractionStatus} in ('none', 'running', 'done', 'failed', 'skipped')`),
    check("conversations_extraction_claim", sql`(${t.extractionStatus} = 'running') = (${t.extractionClaim} is not null)`),
    foreignKey({ name: "conversations_language_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    unique("conversations_id_learner").on(t.id, t.learnerId),
    unique("conversations_id_profile").on(t.id, t.languageProfileId),
    index("conversations_learner_started_idx").on(t.learnerId, t.startedAt),
    index("conversations_profile_started_idx").on(t.languageProfileId, t.startedAt),
    // The earlier attempt, always in the same language. ON DELETE SET NULL
    // ("previous_conversation_id") in the migration (hand-edits.mjs).
    foreignKey({ name: "conversations_previous_fk", columns: [t.previousConversationId, t.languageProfileId], foreignColumns: [t.id, t.languageProfileId] }).onDelete("set null"),
    // History by scene, and a scene's latest attempt.
    index("conversations_profile_scene_idx").on(t.languageProfileId, t.sceneKey, t.startedAt),
  ],
).enableRLS();

export const turns = pgTable(
  "turns",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** 0-based position in the conversation. */
    idx: integer("idx").notNull(),
    role: text("role").$type<"learner" | "master">().notNull(),
    // The VoiceHistoryItem shapes, so a stored conversation renders with the
    // existing transcript components.
    text: text("text"),
    lines: jsonb("lines").$type<VoiceLine[]>(),
    glosses: jsonb("glosses").$type<VoiceGloss[]>(),
    choices: jsonb("choices").$type<string[]>(),
    stage: text("stage"),
    castNotes: jsonb("cast_notes").$type<VoiceCastNote[]>(),
    /** A master turn whose words came from the browser's copy of the
     *  history, not from a reply the server produced: true. Learner turns
     *  and the server's own replies: false. Anything that reads stored
     *  master turns as what the dojo master said checks it. */
    fromClient: boolean("from_client").notNull().default(false),
    durationMs: integer("duration_ms"),
    costUsd: doublePrecision("cost_usd"),
    lookup: jsonb("lookup").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    check("turns_role", sql`${t.role} in ('learner', 'master')`),
    foreignKey({ columns: [t.conversationId, t.learnerId], foreignColumns: [conversations.id, conversations.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "turns_conversation_profile_fk", columns: [t.conversationId, t.languageProfileId], foreignColumns: [conversations.id, conversations.languageProfileId] }).onDelete("cascade"),
    unique("turns_conversation_position").on(t.conversationId, t.idx),
    unique("turns_id_learner").on(t.id, t.learnerId),
    // For phrase_examples_turn_profile_fk: an example's turn is in its language.
    unique("turns_id_profile").on(t.id, t.languageProfileId),
  ],
).enableRLS();

/* ------------------------------- phrase bank ------------------------------ */

export const phrases = pgTable(
  "phrases",
  {
    id: id(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** The language whose bank it is in, one of the learner's (composite
     *  key). Its identity is per profile: one row per target form. */
    languageProfileId: uuid("language_profile_id").notNull(),
    /** BCP-47 of the variant it was first met in, e.g. es-MX ("" when the
     *  session's language has no known locale). Provenance only, not part
     *  of the identity: a pack set in Spain, inside a Mexican Spanish
     *  profile, glosses "gracias" into the same row. */
    lang: text("lang").notNull(),
    /** Target form; null while pending (a scenario meaning not yet paired). */
    text: text("text"),
    /** Match key of `text` (DATA.md §Identity); null exactly when pending. */
    norm: text("norm"),
    meaning: text("meaning"),
    /** A pending phrase's identity: the match key of its meaning. Pending
     *  rows live in their own namespace, so a pending "taxi" (an English
     *  meaning) never captures the later gloss of the target word "taxi". */
    meaningNorm: text("meaning_norm"),
    note: text("note"),
    /** Mandarin only (migration 0014, ld-op2): the dojo master's reading
     *  for `text`, one tone-marked syllable per Chinese character ("yín
     *  háng"), kept only when the server accepted it and the app's reader
     *  reads the phrase otherwise (web/server/hints.ts). Null for almost
     *  every phrase: the reader's own reading is then the one shown. */
    reading: text("reading"),
    /** Where it came from. `picture` (migration 0020, ld-ec9): a word of the
     *  shared picture pool, made the first time the learner answered it in
     *  the picture game (scripts/db/picturePool.ts adoptPoolWord). */
    source: text("source").$type<"gloss" | "extraction" | "manual" | "scenario" | "picture">().notNull(),
    /** Other target forms the grader accepted, so they grade exact next time. */
    alternates: jsonb("alternates").$type<string[]>().notNull().default([]),
    starred: boolean("starred").notNull().default(false),
    suspended: boolean("suspended").notNull().default(false),
    firstSeenAt: tz("first_seen_at"),
    lastSeenAt: tz("last_seen_at"),
    seenCount: integer("seen_count").notNull().default(0),
    lastPracticedAt: tz("last_practiced_at"),
    /** When the learner last changed it by hand (any edit, a star, an add
     *  of words already here); null if never. The automatic paths (a
     *  gloss, a scene's list, undoing a dropped reply) never delete it or
     *  overwrite what the learner set while this is set. */
    editedAt: tz("edited_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("phrases_source", sql`${t.source} in ('gloss', 'extraction', 'manual', 'scenario', 'picture')`),
    // Complete: text and norm. Pending: neither, and a meaning key instead.
    check(
      "phrases_complete_or_pending",
      sql`(${t.text} is not null and ${t.norm} is not null) or (${t.text} is null and ${t.norm} is null and ${t.meaningNorm} is not null)`,
    ),
    foreignKey({ name: "phrases_language_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    // Identity (DATA.md), per language profile: complete phrases by target
    // form, pending ones by meaning. When a target form turns up for a
    // pending row, the pending row is filled in if no complete phrase has
    // that norm; otherwise it is deleted and the complete one kept. The
    // gloss upsert targets the first index (ON CONFLICT
    // (language_profile_id, norm) WHERE text IS NOT NULL).
    uniqueIndex("phrases_profile_identity").on(t.languageProfileId, t.norm).where(sql`${t.text} is not null`),
    uniqueIndex("phrases_profile_pending_identity").on(t.languageProfileId, t.meaningNorm).where(sql`${t.text} is null`),
    unique("phrases_id_learner").on(t.id, t.learnerId),
    unique("phrases_id_profile").on(t.id, t.languageProfileId),
    // The bank, recall and practice list one profile's rows: the identity
    // index already leads with language_profile_id.
    // Trigram GIN indexes serve the LOOKUP direction (a short query found
    // inside phrases: `query <% text`). Per-turn retrieval runs the other way
    // (a phrase found inside the message), which these indexes don't serve;
    // it scans the learner's rows, which is fine at one learner's bank size.
    index("phrases_text_trgm").using("gin", t.text.op("gin_trgm_ops")),
    index("phrases_meaning_trgm").using("gin", t.meaning.op("gin_trgm_ops")),
  ],
).enableRLS();

export const phraseExamples = pgTable(
  "phrase_examples",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    conversationId: uuid("conversation_id"),
    turnId: uuid("turn_id"),
    sentence: text("sentence").notNull(),
    speaker: text("speaker"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "phrase_examples_phrase_profile_fk", columns: [t.phraseId, t.languageProfileId], foreignColumns: [phrases.id, phrases.languageProfileId] }).onDelete("cascade"),
    // Provenance, the learner's own only, and in the phrase's language
    // (the _profile_ keys, migration 0003); all hand-edited to SET NULL
    // (col), so deleting a conversation keeps the example.
    foreignKey({ name: "phrase_examples_conversation_fk", columns: [t.conversationId, t.learnerId], foreignColumns: [conversations.id, conversations.learnerId] }).onDelete("set null"),
    foreignKey({ name: "phrase_examples_turn_fk", columns: [t.turnId, t.learnerId], foreignColumns: [turns.id, turns.learnerId] }).onDelete("set null"),
    foreignKey({ name: "phrase_examples_conversation_profile_fk", columns: [t.conversationId, t.languageProfileId], foreignColumns: [conversations.id, conversations.languageProfileId] }).onDelete("set null"),
    foreignKey({ name: "phrase_examples_turn_profile_fk", columns: [t.turnId, t.languageProfileId], foreignColumns: [turns.id, turns.languageProfileId] }).onDelete("set null"),
    index("phrase_examples_phrase_idx").on(t.phraseId),
    // For cloze_items_example_fk (migration 0006): a cloze item made from
    // an example is of the example's own phrase.
    unique("phrase_examples_id_phrase").on(t.id, t.phraseId),
  ],
);

/**
 * One sighting: a reply's capture saw this phrase (scripts/db/phrases.ts
 * recordGlosses writes it in the capture's own savepoint, so a capture
 * that failed left none). The bank's record of what each turn did:
 * `phrases.seen_count` is always the number of a phrase's rows here and
 * its first and last seen their earliest and latest `seen_at`, so undoing
 * a dropped reply (unrecordGlosses) deletes that turn's rows and counts
 * again, never re-deriving anything from the reply's text. Deleting a
 * conversation keeps its sightings (turn and conversation set null): the
 * phrases were still met.
 */
export const phraseSightings = pgTable(
  "phrase_sightings",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    conversationId: uuid("conversation_id"),
    turnId: uuid("turn_id"),
    seenAt: tz("seen_at").notNull().defaultNow(),
    /** What saw it (migration 0004): 'gloss', a reply's capture (turn_id
     *  set); 'extraction', the post-session recap naming a phrase the
     *  session's glosses didn't (turn_id null, one per conversation and
     *  phrase), which a re-run of the recap replaces. */
    source: text("source").$type<"gloss" | "extraction">().notNull().default("gloss"),
  },
  (t) => [
    check("phrase_sightings_source", sql`${t.source} in ('gloss', 'extraction')`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "phrase_sightings_phrase_profile_fk", columns: [t.phraseId, t.languageProfileId], foreignColumns: [phrases.id, phrases.languageProfileId] }).onDelete("cascade"),
    // In the phrase's language; hand-edited to SET NULL (col), so deleting
    // a conversation keeps the sighting.
    foreignKey({ name: "phrase_sightings_conversation_profile_fk", columns: [t.conversationId, t.languageProfileId], foreignColumns: [conversations.id, conversations.languageProfileId] }).onDelete("set null"),
    foreignKey({ name: "phrase_sightings_turn_profile_fk", columns: [t.turnId, t.languageProfileId], foreignColumns: [turns.id, turns.languageProfileId] }).onDelete("set null"),
    // A capture sees each phrase once.
    uniqueIndex("phrase_sightings_turn_phrase").on(t.turnId, t.phraseId),
    // The recap sees a phrase once per conversation.
    uniqueIndex("phrase_sightings_extraction_once").on(t.conversationId, t.phraseId).where(sql`${t.source} = 'extraction'`),
    index("phrase_sightings_phrase_idx").on(t.phraseId, t.seenAt),
  ],
);

/**
 * A scene-list phrase the learner deleted from the bank: the scene's next
 * start doesn't add it back (docs/DATA.md §Phrase bank, "Dismissed"). Keyed
 * like the phrase it stood for: `kind` 'text' with the target form's norm,
 * or 'meaning' with a pending phrase's meaning_norm. Only the scene lists
 * read it; a gloss in a session, an add or a star brings the phrase back
 * (and an add or star clears the mark).
 */
export const phraseDismissals = pgTable(
  "phrase_dismissals",
  {
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    kind: text("kind").$type<"text" | "meaning">().notNull(),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("phrase_dismissals_kind", sql`${t.kind} in ('text', 'meaning')`),
    primaryKey({ name: "phrase_dismissals_pk", columns: [t.languageProfileId, t.kind, t.key] }),
    foreignKey({ name: "phrase_dismissals_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
  ],
);

/**
 * One FSRS memory per phrase and skill. The columns cover every field of
 * ts-fsrs 6's `Card` (due, stability, difficulty, scheduled_days,
 * learning_steps, reps, lapses, state, last_review) plus `stability_fast`,
 * which its FSRS-7 default scheduler adds. `elapsed_days` is gone: ts-fsrs 6
 * dropped it from the card (it is now - last_review). `scheduled_days` is a
 * double because FSRS-7 schedules fractional days.
 *
 * The FSRS fields keep ts-fsrs's snake_case names as their JS keys too (the
 * one place this schema isn't camelCase): scripts/fsrs.mjs `toRow` output
 * spreads straight into an insert or update, and a selected row goes straight
 * into `fromRow`. Drizzle drops unknown keys silently, so camelCase keys here
 * would lose `learning_steps` on write and make `fromRow` throw on read.
 */
export const cards = pgTable(
  "cards",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    skill: text("skill").$type<"recognize" | "listen" | "produce">().notNull(),
    due: tz("due").notNull().defaultNow(),
    stability: doublePrecision("stability").notNull().default(0),
    stability_fast: doublePrecision("stability_fast"),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    scheduled_days: doublePrecision("scheduled_days").notNull().default(0),
    learning_steps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    /** ts-fsrs State: 0 New, 1 Learning, 2 Review, 3 Relearning. */
    state: smallint("state").notNull().default(0),
    last_review: tz("last_review"),
  },
  (t) => [
    check("cards_skill", sql`${t.skill} in ('recognize', 'listen', 'produce')`),
    check("cards_state", sql`${t.state} between 0 and 3`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "cards_phrase_profile_fk", columns: [t.phraseId, t.languageProfileId], foreignColumns: [phrases.id, phrases.languageProfileId] }).onDelete("cascade"),
    unique("cards_phrase_skill").on(t.phraseId, t.skill),
    unique("cards_id_learner").on(t.id, t.learnerId),
    unique("cards_id_profile").on(t.id, t.languageProfileId),
    // The practice queue, the review block and the bank's "due": one
    // language's due cards.
    index("cards_profile_due_idx").on(t.languageProfileId, t.due),
  ],
).enableRLS();

export const reviews = pgTable(
  "reviews",
  {
    // Append-only and the busiest table: a bigserial is cheaper than a uuid
    // and orders by insertion for free.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: uuid("card_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** The drill that wrote it; `picture` is the kids word game (a tap on a
     *  picture reviews the listen card: migration 0011). */
    mode: text("mode").$type<"flashcard" | "cloze" | "listening" | "speak" | "picture" | "session">().notNull(),
    rating: smallint("rating").notNull(),
    answer: text("answer"),
    verdict: text("verdict").$type<"exact" | "close" | "accepted" | "wrong" | "self">(),
    graderNote: text("grader_note"),
    durationMs: integer("duration_ms"),
    reviewedAt: tz("reviewed_at").notNull().defaultNow(),
    conversationId: uuid("conversation_id"),
    /** The card's full FSRS state before this review. A grade override
     *  (DATA.md) restores it and re-reviews with the new rating. */
    cardBefore: jsonb("card_before").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    check("reviews_mode", sql`${t.mode} in ('flashcard', 'cloze', 'listening', 'speak', 'picture', 'session')`),
    check("reviews_rating", sql`${t.rating} between 1 and 4`),
    check("reviews_verdict", sql`${t.verdict} in ('exact', 'close', 'accepted', 'wrong', 'self')`),
    foreignKey({ columns: [t.cardId, t.learnerId], foreignColumns: [cards.id, cards.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "reviews_card_profile_fk", columns: [t.cardId, t.languageProfileId], foreignColumns: [cards.id, cards.languageProfileId] }).onDelete("cascade"),
    // Hand-edited to ON DELETE SET NULL ("conversation_id"); the second
    // (migration 0003) keeps the conversation in the card's language.
    foreignKey({ name: "reviews_conversation_fk", columns: [t.conversationId, t.learnerId], foreignColumns: [conversations.id, conversations.learnerId] }).onDelete("set null"),
    foreignKey({ name: "reviews_conversation_profile_fk", columns: [t.conversationId, t.languageProfileId], foreignColumns: [conversations.id, conversations.languageProfileId] }).onDelete("set null"),
    // At most one session review per card per conversation (DATA.md).
    uniqueIndex("reviews_one_session_review").on(t.cardId, t.conversationId).where(sql`${t.mode} = 'session'`),
    index("reviews_card_at_idx").on(t.cardId, t.reviewedAt),
    // "Trouble": lapses in the last 30 days, per language.
    index("reviews_profile_at_idx").on(t.languageProfileId, t.reviewedAt),
  ],
).enableRLS();

/**
 * A fill-in-the-blank sentence for a phrase's produce card (docs/DATA.md
 * §Practice modes, "As built (phase 7c: cloze)"). Made once and kept: from
 * one of the phrase's examples (a line of the dojo master's from the
 * learner's own session; `example_id` set) or written by one model call
 * for a batch of phrases (origin 'generated'). `phrase_key` is the
 * phrase's words and meaning it was made for (practice.mjs clozeKey): an
 * edit of either leaves every item of the old key unused (the next fill
 * clears them), while a new alternate doesn't. A generated row with no
 * sentence marks a call that gave nothing usable for the phrase, so the
 * key counts as tried and the phrase never pays twice. `flagged_at`: the
 * learner said the sentence is bad, and it is never shown again. The bank
 * reader role of 0005 is granted nothing on it.
 */
export const clozeItems = pgTable(
  "cloze_items",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** The sentence in the target language; null only on a generated row
     *  marking a call that gave nothing usable. */
    sentence: text("sentence"),
    /** Offsets of the blank in `sentence`, end exclusive (UTF-16 code
     *  units, as JavaScript counts them). */
    blankStart: integer("blank_start"),
    blankEnd: integer("blank_end"),
    /** Unused as built (null): the hint shown is the phrase's meaning now. */
    hint: text("hint"),
    /** What the sentence means, in the learner's native language (migration
     *  0010, bead ld-r2x), shown quietly under it on a flashcard's answer
     *  side. A generated sentence's came from the same call (cloze.mjs
     *  checkTranslation); a session line's is the turn's own gloss of that
     *  sentence, when it had one. Null: none (and every row from before 0010). */
    translation: text("translation"),
    origin: text("origin").$type<"example" | "generated">().notNull(),
    /** practice.mjs clozeKey of the phrase as the item was made for it. */
    phraseKey: text("phrase_key").notNull(),
    /** The example it was made from (origin 'example'): deleting the
     *  example (its turn dropped) deletes the item. */
    exampleId: uuid("example_id"),
    flaggedAt: tz("flagged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("cloze_items_origin", sql`${t.origin} in ('example', 'generated')`),
    check("cloze_items_blank", sql`0 <= ${t.blankStart} and ${t.blankStart} < ${t.blankEnd}`),
    // A sentence and its blank come together; only a generated row may
    // have none (the tried mark); an example's item, and only it, names
    // its example.
    check(
      "cloze_items_sentence",
      sql`(${t.sentence} is null) = (${t.blankStart} is null) and (${t.sentence} is null) = (${t.blankEnd} is null) and (${t.sentence} is not null or ${t.origin} = 'generated') and (${t.exampleId} is not null) = (${t.origin} = 'example')`,
    ),
    // A translation is a sentence's: the tried mark has none.
    check("cloze_items_translation", sql`${t.translation} is null or ${t.sentence} is not null`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "cloze_items_phrase_profile_fk", columns: [t.phraseId, t.languageProfileId], foreignColumns: [phrases.id, phrases.languageProfileId] }).onDelete("cascade"),
    foreignKey({ name: "cloze_items_example_fk", columns: [t.exampleId, t.phraseId], foreignColumns: [phraseExamples.id, phraseExamples.phraseId] }).onDelete("cascade"),
    index("cloze_items_phrase_idx").on(t.phraseId),
    // The queue reads one language's items.
    index("cloze_items_profile_idx").on(t.languageProfileId),
    // One item per example and key, one row per generated sentence and
    // key: two fills at once insert each once.
    uniqueIndex("cloze_items_example_once").on(t.exampleId, t.phraseKey).where(sql`${t.exampleId} is not null`),
    uniqueIndex("cloze_items_generated_once").on(t.phraseId, t.phraseKey, t.sentence).where(sql`${t.origin} = 'generated' and ${t.sentence} is not null`),
    // One "nothing usable" mark per phrase and key: a later try refreshes it
    // (an upsert, whose target always leads with the owner: owned.ts).
    uniqueIndex("cloze_items_tried_once").on(t.languageProfileId, t.phraseId, t.phraseKey).where(sql`${t.sentence} is null`),
  ],
);

/**
 * One generation call for cloze sentences (docs/DATA.md §Practice modes,
 * "As built (phase 7c: cloze)"): the ledger the daily cap counts
 * (cloze.mjs CLOZE_DAILY_CALLS). Written as the call starts, whatever it
 * then gives, and kept apart from cloze_items: those are a cache that an
 * edit, a phrase's delete or an expiring mark clears, and a call paid for
 * must count all the same; nor does a restart reset it. Goes only with its
 * language profile; rows older than the window are pruned as calls are
 * made. The bank reader role of 0005 is granted nothing on it.
 */
export const clozeCalls = pgTable(
  "cloze_calls",
  {
    id: id(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** How many phrases the call asked sentences for. */
    phrases: integer("phrases").notNull(),
    /** Sentences kept from its reply; null while it runs, or when it got
     *  no reply (the CLI, a limit, a timeout). */
    kept: integer("kept"),
    createdAt: createdAt(),
  },
  (t) => [
    check("cloze_calls_counts", sql`${t.phrases} > 0 and ${t.kept} >= 0`),
    foreignKey({ name: "cloze_calls_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    // The daily cap counts one language's recent calls.
    index("cloze_calls_profile_idx").on(t.languageProfileId, t.createdAt),
  ],
);

/* ------------------------------ word pictures ------------------------------ */

/**
 * A word's picture for the kids word game (docs/DATA.md §Kids word game,
 * migration 0011): one row per phrase, for its words and meaning as
 * `phrase_key` names them (pictures.mjs pictureKey; an edit leaves the row
 * stale, and the word is judged and drawn again). The picturable verdict is
 * stored once (`none`: no clear picture, left out of the game; `pending`:
 * picturable, with the description to draw), the image once (`ready`: the
 * file under the images directory, scripts/picture-store.mjs), and never
 * made again unless a grown-up asks for a redraw. `failed`: the provider
 * refused it or gave no image (not retried by itself); `removed`: a
 * grown-up took it out. The bank reader role of 0005 gets nothing on it.
 */
export const phrasePictures = pgTable(
  "phrase_pictures",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** pictures.mjs pictureKey of the phrase the verdict and picture are for. */
    phraseKey: text("phrase_key").notNull(),
    status: text("status").$type<"pending" | "ready" | "none" | "failed" | "removed">().notNull(),
    /** What to draw (the picturable check's, cleaned); null for `none`. */
    description: text("description"),
    /** The image's file name stem (64 hex, made by the server, never from a
     *  client) while it is `ready`; also the cache-busting part of its URL. */
    file: text("file"),
    contentType: text("content_type"),
    /** The picture theme the file was drawn in (pictures.mjs PICTURE_THEME's
     *  id, with "+<provider>" when a provider other than the theme's own
     *  drew it: pictures.mjs drawnTheme). Null for a picture drawn before
     *  themes (0012), and while there is no file. "Not in the current
     *  theme" is what Redraw all in the current style converts. */
    theme: text("theme"),
    /** Set when the file is a shared stock picture (content/pictures.yaml,
     *  `stock/<theme>/<id>.<ext>` under the images directory) instead of
     *  one drawn for this word: `file` is then pictures.mjs stockKey(theme,
     *  id), never a file of its own, and no per-word deletion touches it. */
    stockId: text("stock_id"),
    /** A grown-up's Redraw all in the current style, waiting: `check` (ask
     *  the picturable check whether a stock picture fits first) or `draw`
     *  (draw it again in the theme). The old file stays in place, and in the
     *  game, until the new one is ready. Null otherwise. */
    restyle: text("restyle").$type<"check" | "draw">(),
    /** The picturable check's answer on whether the word and its picture
     *  are fine to teach a young child (migration 0020, ld-ec9): what lets
     *  an adult's drawing, once shared into the picture pool, reach kids
     *  learners. Null: not asked (judged before 0020, or not picturable). */
    kidsSafe: boolean("kids_safe"),
    createdAt: createdAt(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("phrase_pictures_theme", sql`${t.theme} is null or ${t.theme} ~ '^[a-z0-9][a-z0-9.+-]{0,63}$'`),
    check("phrase_pictures_stock", sql`${t.stockId} is null or (${t.status} = 'ready' and ${t.theme} is not null and ${t.stockId} ~ '^[a-z0-9][a-z0-9-]{0,47}$')`),
    check("phrase_pictures_restyle", sql`${t.restyle} is null or (${t.status} = 'ready' and ${t.restyle} in ('check', 'draw'))`),
    check("phrase_pictures_status", sql`${t.status} in ('pending', 'ready', 'none', 'failed', 'removed')`),
    // A file exactly while ready; something to draw while pending or ready.
    check(
      "phrase_pictures_file",
      sql`(${t.status} = 'ready') = (${t.file} is not null) and (${t.file} is null or ${t.file} ~ '^[0-9a-f]{64}$') and (${t.file} is null) = (${t.contentType} is null)`,
    ),
    check("phrase_pictures_type", sql`${t.contentType} is null or ${t.contentType} in ('image/png', 'image/webp', 'image/jpeg')`),
    check("phrase_pictures_description", sql`${t.status} not in ('pending', 'ready') or ${t.description} is not null`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    foreignKey({ name: "phrase_pictures_phrase_profile_fk", columns: [t.phraseId, t.languageProfileId], foreignColumns: [phrases.id, phrases.languageProfileId] }).onDelete("cascade"),
    // One row per phrase; an upsert's target leads with the owner (owned.ts).
    unique("phrase_pictures_profile_phrase").on(t.languageProfileId, t.phraseId),
  ],
);

/**
 * One paid call for the word game's pictures (docs/DATA.md §Kids word
 * game): a picturable check (`judge`, a claude call) or an image (`image`,
 * the image provider). Written as the call starts, whatever it then gives,
 * and kept apart from phrase_pictures (an edit, a delete or a redraw
 * changes those rows; a call paid for must count all the same): the daily
 * caps (pictures.mjs PICTURE_DAILY_IMAGES, PICTURE_DAILY_JUDGES) count
 * these rows, and a restart doesn't reset them. Pruned past the window as
 * calls are made; goes with its language profile. The reader role gets
 * nothing on it.
 */
export const pictureCalls = pgTable(
  "picture_calls",
  {
    id: id(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    kind: text("kind").$type<"judge" | "image">().notNull(),
    /** Words the call was for (an image: 1). */
    words: integer("words").notNull(),
    /** How it ended, for diagnosis: null while it runs or when the server stopped. */
    outcome: text("outcome").$type<"ok" | "refused" | "failed">(),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_calls_kind", sql`${t.kind} in ('judge', 'image')`),
    check("picture_calls_words", sql`${t.words} > 0`),
    check("picture_calls_outcome", sql`${t.outcome} is null or ${t.outcome} in ('ok', 'refused', 'failed')`),
    foreignKey({ name: "picture_calls_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    // The daily caps count one language's recent calls.
    index("picture_calls_profile_idx").on(t.languageProfileId, t.createdAt),
  ],
);

/* ------------------------------ recent digests ----------------------------- */

/** The once-a-day written digest of a language's recent sessions (DATA.md
 *  §Revisit, migration 0008). One row per language per day, claimed by its
 *  insert before the model is called: the unique key is the daily cap, and
 *  a row that failed still counts. The reader role (0005) gets nothing on
 *  it. */
export const recentDigests = pgTable(
  "recent_digests",
  {
    id: id(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** The server's calendar day it was written for. */
    day: date("day", { mode: "string" }).notNull(),
    status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
    /** The run holding it, to tell a live run from one a restart killed. */
    claim: uuid("claim"),
    text: text("text"),
    /** The newest recap it read (conversations.extracted_at), and how many sessions. */
    through: tz("through"),
    sessions: integer("sessions").notNull().default(0),
    createdAt: createdAt(),
    finishedAt: tz("finished_at"),
  },
  (t) => [
    check("recent_digests_status", sql`${t.status} in ('running', 'done', 'failed')`),
    foreignKey({ name: "recent_digests_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    unique("recent_digests_profile_day").on(t.languageProfileId, t.day),
  ],
);

/* ------------------------------- hidden scenes ----------------------------- */

/** A library scene or collection one language profile has hidden from its
 *  Scene tab and its random draws (DATA.md §Hidden scenes, migration 0009).
 *  The library is content shared by everyone, so hiding is a per-language
 *  preference, not a file delete: unhiding deletes the row, hiding again
 *  inserts it again. `key` is a scenario id (`kind = 'scenario'`) or a
 *  collection name (`'collection'`, "" for the scenes in no collection), not
 *  checked against the library, which can change under it. The primary key
 *  is the unique (language, kind, key). The reader role (0005) gets nothing
 *  on it. */
export const hiddenScenes = pgTable(
  "hidden_scenes",
  {
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    kind: text("kind").$type<"scenario" | "collection">().notNull(),
    key: text("key").notNull(),
    hiddenAt: tz("hidden_at").notNull().defaultNow(),
  },
  (t) => [
    check("hidden_scenes_kind", sql`${t.kind} in ('scenario', 'collection')`),
    check("hidden_scenes_key_length", sql`char_length(${t.key}) <= 200`),
    primaryKey({ name: "hidden_scenes_pk", columns: [t.languageProfileId, t.kind, t.key] }),
    foreignKey({ name: "hidden_scenes_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
  ],
);

/* ------------------------------ stock pictures ------------------------------ */

/**
 * A shared stock picture concept an admin added from the picture library
 * page (docs/DATA.md §Stock pictures, migration 0013, bead ld-318),
 * install-wide: every learner's word game may use it. It sits beside
 * content/pictures.yaml's concepts and is merged with them wherever the
 * stock list is read (the picturable check, the CLI, the routes), by the
 * same rules (pictures.mjs readStockList), the file's concepts first, so an
 * id the file also has keeps the file's. A route never writes content/
 * (only the content agent does), so a concept added there lives here. Not
 * personal: no owner column, never through owned.ts; `created_by` is
 * provenance only. The reader role (0005) gets nothing on it.
 */
export const pictureStockConcepts = pgTable(
  "picture_stock_concepts",
  {
    /** pictures.mjs STOCK_ID_RE; also its file's name under stock/<theme>/. */
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    /** What the theme's prompt draws: passes pictures.mjs cleanDescription as written. */
    description: text("description").notNull(),
    /** The English words it stands for (what the picturable check matches). */
    words: text("words").array().notNull(),
    /** Adults only (pictures.mjs stockForMode): never offered to, matched
     *  for or shown to a kids learner, like pictures.yaml's `adults: true`. */
    adults: boolean("adults").notNull().default(false),
    /** Its look-alike group (migration 0019, ld-2nw), like pictures.yaml's
     *  `group` and in its format (STOCK_ID_RE): a round never offers two
     *  concepts of one group (pictures.mjs roundChoices), file and added
     *  concepts alike. Null: none. Not named "group", a reserved word in SQL. */
    group: text("look_alike_group"),
    /** How it came (migration 0020, ld-ec9): `admin`, added from the
     *  picture library page; `drawing`, a learner's own word picture shared
     *  into the picture pool (web/server/picturePool.ts), its file copied
     *  into the stock folder. */
    origin: text("origin").$type<"admin" | "drawing">().notNull().default("admin"),
    /** A `drawing`'s source file key (phrase_pictures.file when it was
     *  shared: 64 hex, random): shared once per file, and unshared when its
     *  owner removes or redraws that picture. Null for an admin's. */
    sourceFile: text("source_file").unique("picture_stock_concepts_source_file"),
    /** A `drawing`'s kids check: true (a kids learner's own word, or an
     *  adult's the check found fine for a young child), false, or null (not
     *  asked yet). Anything but true keeps it from kids learners whatever
     *  `adults` says (pictures.mjs mergeStock). Null for an admin's. */
    kidsSafe: boolean("kids_safe"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_stock_concepts_id", sql`${t.id} ~ '^[a-z0-9][a-z0-9-]{0,47}$'`),
    check("picture_stock_concepts_category", sql`char_length(${t.category}) between 1 and 40`),
    check("picture_stock_concepts_description", sql`char_length(${t.description}) between 1 and 80`),
    check("picture_stock_concepts_words", sql`cardinality(${t.words}) between 1 and 20`),
    check("picture_stock_concepts_group", sql`${t.group} is null or ${t.group} ~ '^[a-z0-9][a-z0-9-]{0,47}$'`),
    check(
      "picture_stock_concepts_origin",
      sql`(${t.origin} = 'admin' and ${t.sourceFile} is null and ${t.kidsSafe} is null) or (${t.origin} = 'drawing' and ${t.sourceFile} is not null and ${t.sourceFile} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * One stock picture drawn from the picture library page (docs/DATA.md
 * §Stock pictures, migration 0013): the ledger the install-wide daily cap
 * on stock draws counts (pictures.mjs PICTURE_DAILY_STOCK), apart from each
 * language's picture_calls. Written as the call starts, whatever it then
 * gives (a failure was, or may have been, paid); pruned past the window as
 * draws are made. The CLI (npm run pictures:stock) is the grown-up's
 * explicit one-off and writes none. The reader role (0005) gets nothing.
 */
export const pictureStockCalls = pgTable(
  "picture_stock_calls",
  {
    id: id(),
    /** Who asked (provenance; the slot it ran in). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conceptId: text("concept_id").notNull(),
    /** How it ended, for diagnosis: null while it runs or when the server stopped. */
    outcome: text("outcome").$type<"ok" | "refused" | "failed">(),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_stock_calls_outcome", sql`${t.outcome} is null or ${t.outcome} in ('ok', 'refused', 'failed')`),
    index("picture_stock_calls_created_idx").on(t.createdAt),
  ],
);

/**
 * An admin's Adults only setting for a concept of content/pictures.yaml
 * (docs/DATA.md §Adults only, set from the page; migration 0018, bead
 * ld-cvd), install-wide. The app never writes content/, so the picture
 * library's toggle on a file concept lands here; mergeStock lays it over
 * the file's `adults` flag (an added concept's toggle flips its own
 * picture_stock_concepts.adults instead, and a row here never applies to
 * one). A row exists only while it differs from the file: setting a
 * concept back to the file's value deletes it, so a later edit of the
 * file is followed again. No foreign key: the file's concepts aren't rows;
 * a row whose id the file no longer has is ignored. Not personal: no
 * owner, never through owned.ts; `set_by` is provenance only. The reader
 * role (0005) gets nothing on it.
 */
export const pictureStockAdults = pgTable(
  "picture_stock_adults",
  {
    /** The file concept's id (pictures.mjs STOCK_ID_RE). */
    conceptId: text("concept_id").primaryKey(),
    /** The effective flag: true keeps the concept from kids learners. */
    adults: boolean("adults").notNull(),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("picture_stock_adults_id", sql`${t.conceptId} ~ '^[a-z0-9][a-z0-9-]{0,47}$'`)],
);

/* --------------------------- the shared picture pool --------------------------- */

/**
 * A stock concept's word in one language of the shared picture pool
 * (docs/DATA.md §The shared picture pool, migration 0020, bead ld-ec9),
 * for a concept content/picture-words.yaml has no word for there: an
 * admin's concept, a learner's shared drawing (its own word, at once), or
 * one the content agent added to pictures.yaml later. Written once per
 * (concept, key) by the capped background naming call
 * (web/server/picturePool.ts) and never replaced; the file's word wins
 * where both have one. `key` is picture-pool.mjs POOL_LANGS or
 * POOL_VARIANTS. No foreign key (a file concept is no row); a deleted
 * added concept takes its rows with it (scripts/db/picturePool.ts).
 * Install-wide, not personal: never through owned.ts. The reader role
 * (0005) gets nothing on it.
 */
export const picturePoolWords = pgTable(
  "picture_pool_words",
  {
    conceptId: text("concept_id").notNull(),
    key: text("key").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_pool_words_concept", sql`${t.conceptId} ~ '^[a-z0-9][a-z0-9-]{0,47}$'`),
    check("picture_pool_words_key", sql`${t.key} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check("picture_pool_words_text", sql`char_length(${t.text}) between 1 and 40`),
    primaryKey({ name: "picture_pool_words_pk", columns: [t.conceptId, t.key] }),
  ],
);

/**
 * A stock concept's CEFR level in the shared picture pool (migration 0020),
 * for a concept content/picture-words.yaml has no level for: set once by
 * the same background naming call that names it, never replaced (the
 * file's level wins). Install-wide; the reader role gets nothing on it.
 */
export const picturePoolLevels = pgTable(
  "picture_pool_levels",
  {
    conceptId: text("concept_id").primaryKey(),
    level: text("level").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_pool_levels_concept", sql`${t.conceptId} ~ '^[a-z0-9][a-z0-9-]{0,47}$'`),
    check("picture_pool_levels_level", sql`${t.level} in ('A1', 'A2', 'B1', 'B2')`),
  ],
);

/**
 * One background naming call of the shared picture pool (migration 0020):
 * the ledger its install-wide daily cap (picture-pool.mjs POOL_DAILY_CALLS)
 * counts, written as the call starts whatever it then gives, pruned past
 * the window as calls are made. `user_id` is whose background slot it ran
 * in (provenance). The reader role gets nothing on it.
 */
export const picturePoolCalls = pgTable(
  "picture_pool_calls",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Concepts the call was asked about. */
    concepts: integer("concepts").notNull(),
    outcome: text("outcome").$type<"ok" | "failed">(),
    createdAt: createdAt(),
  },
  (t) => [
    check("picture_pool_calls_concepts", sql`${t.concepts} > 0`),
    check("picture_pool_calls_outcome", sql`${t.outcome} is null or ${t.outcome} in ('ok', 'failed')`),
    index("picture_pool_calls_created_idx").on(t.createdAt),
  ],
);

/* ---------------------------- Mandarin readings ---------------------------- */

/**
 * A learner's own reading of a Mandarin word, in one language profile
 * (docs/DATA.md §Reading corrections, migration 0015, bead ld-4i2): what
 * the learner chose by hand ("This reading is wrong": `corrected`; "This
 * is right": `confirmed`) or what the post-session recap settled for them
 * (`suggested`: the model's reading, differing from the reader's, until
 * the learner checks it; `confirmed` with source `recap`: the model agreed
 * with the reader). The browser lays them over the reader's readings for
 * this learner only (zh.ts Corrections: a hand choice outranks
 * everything, a suggestion only the dictionary and the prior). One row per
 * word, keyed by its simplified spelling (zh.ts correctionKey) so one
 * script's correction reads in the other; a hand choice is never replaced
 * by the recap's. Queries only in scripts/db/readings.ts.
 */
export const readingCorrections = pgTable(
  "reading_corrections",
  {
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** zh.ts correctionKey: the word's simplified spelling. */
    key: text("key").notNull(),
    /** The word as the learner saw it (2–8 Chinese characters). */
    word: text("word").notNull(),
    /** One tone-marked syllable per character, space separated (zh.ts validateCorrection). */
    reading: text("reading").notNull(),
    kind: text("kind").$type<"corrected" | "confirmed" | "suggested">().notNull(),
    source: text("source").$type<"user" | "recap">().notNull(),
    /** Which model call settled a `recap` row (migration 0017, ld-0mn): a
     *  kids session's background check or the recap; null for a hand choice
     *  and for rows from before 0017 (a recap's). */
    checkedBy: text("checked_by").$type<"session" | "recap">(),
    createdAt: createdAt(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("reading_corrections_kind", sql`${t.kind} in ('corrected', 'confirmed', 'suggested')`),
    check("reading_corrections_checked_by", sql`${t.checkedBy} is null or (${t.source} = 'recap' and ${t.checkedBy} in ('session', 'recap'))`),
    check("reading_corrections_source", sql`${t.source} in ('user', 'recap')`),
    check("reading_corrections_by_hand", sql`${t.source} = 'user' or ${t.kind} <> 'corrected'`),
    check("reading_corrections_word", sql`char_length(${t.word}) between 2 and 8 and char_length(${t.key}) between 2 and 8`),
    check("reading_corrections_reading", sql`char_length(${t.reading}) between 2 and 80`),
    primaryKey({ name: "reading_corrections_pk", columns: [t.languageProfileId, t.key] }),
    foreignKey({ name: "reading_corrections_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
  ],
);

/**
 * The ledger of a kids session's background reading checks (docs/DATA.md
 * §Kids: resolving uncertain readings, migration 0017, bead ld-0mn): one
 * row per tool-less model call, written as the call starts, so it counts
 * toward the language's daily cap whatever it then gives (a failure too)
 * and the cap survives a restart. Words and readings are never here: the
 * answers go to reading_corrections. Queries only in
 * scripts/db/readingChecks.ts.
 */
export const readingCheckCalls = pgTable(
  "reading_check_calls",
  {
    id: id(),
    learnerId: uuid("learner_id").notNull(),
    languageProfileId: uuid("language_profile_id").notNull(),
    /** How many words the call asked about. */
    words: integer("words").notNull(),
    /** How many answers passed the checks and settled a word; null while
     *  it runs, or when it got no reply. */
    settled: integer("settled"),
    createdAt: createdAt(),
  },
  (t) => [
    check("reading_check_calls_counts", sql`${t.words} > 0 and ${t.settled} >= 0`),
    foreignKey({ name: "reading_check_calls_profile_fk", columns: [t.languageProfileId, t.learnerId], foreignColumns: [languageProfiles.id, languageProfiles.learnerId] }).onDelete("cascade"),
    // The daily cap counts one language's recent calls.
    index("reading_check_calls_profile_idx").on(t.languageProfileId, t.createdAt),
  ],
);

/**
 * The shared list of Mandarin readings (docs/DATA.md §Shared readings,
 * migration 0015, bead ld-4i2): whole-word readings every learner's reader
 * applies once `active` (zh.ts Corrections: below a learner's own hand
 * choice, above the library's dictionary). Install-wide and not personal:
 * words and readings only. An admin's correction is active at once; a
 * learner's (`by_user`) or the recap's (`by_recap`) is `suggested`, and
 * becomes active when an admin confirms it or when both agree on the same
 * reading. One row per (word, scope, reading): competing suggestions sit
 * side by side, and at most one reading per (word, scope) is active.
 * `suggested_by` and `confirmed_by` are for the admin view only (the
 * browser's list carries word, scope and reading alone). Queries only in
 * scripts/db/sharedReadings.ts.
 */
export const sharedReadings = pgTable(
  "shared_readings",
  {
    id: id(),
    /** zh.ts correctionKey: the word's simplified spelling. */
    key: text("key").notNull(),
    /** The word as first written (either script). */
    word: text("word").notNull(),
    reading: text("reading").notNull(),
    /** "tw": a reading only Taiwan uses (zh.ts correctionScope). */
    scope: text("scope").$type<"all" | "tw">().notNull().default("all"),
    status: text("status").$type<"active" | "suggested">().notNull(),
    /** Who first proposed it. */
    source: text("source").$type<"admin" | "user" | "recap">().notNull(),
    byUser: boolean("by_user").notNull().default(false),
    byRecap: boolean("by_recap").notNull().default(false),
    suggestedBy: uuid("suggested_by").references(() => users.id, { onDelete: "set null" }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("shared_readings_status", sql`${t.status} in ('active', 'suggested')`),
    check("shared_readings_source", sql`${t.source} in ('admin', 'user', 'recap')`),
    check("shared_readings_scope", sql`${t.scope} in ('all', 'tw')`),
    check("shared_readings_word", sql`char_length(${t.word}) between 2 and 8 and char_length(${t.key}) between 2 and 8`),
    check("shared_readings_reading", sql`char_length(${t.reading}) between 2 and 80`),
    unique("shared_readings_entry").on(t.key, t.scope, t.reading),
    uniqueIndex("shared_readings_one_active").on(t.key, t.scope).where(sql`${t.status} = 'active'`),
  ],
);

/**
 * How many readings the shared list changed in one session's dojo-master
 * lines, counted when its recap ran (docs/DATA.md §Shared readings): what
 * the admin view sums over the last 30 days. A count, no words; a recap
 * made again replaces its row.
 */
/**
 * Who stands behind a shared suggestion (PR #67 review, ld-4i2; migration
 * 0016): one row per user per entry, a learner's own correction or
 * confirmation (`user`) or a recap of one of their sessions (`recap`,
 * counted as the conversation owner's: one person agreeing with a model's
 * answer to their own transcript is one source, not two). A suggestion is
 * activated without an admin only by two different users. Also the per-user
 * daily cap's count. User ids leave scripts/db/sharedReadings.ts only for
 * the admin view.
 */
export const sharedReadingVotes = pgTable(
  "shared_reading_votes",
  {
    sharedReadingId: uuid("shared_reading_id")
      .notNull()
      .references(() => sharedReadings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").$type<"user" | "recap">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sharedReadingId, t.userId] }),
    check("shared_reading_votes_source", sql`${t.source} in ('user', 'recap')`),
    index("shared_reading_votes_user_idx").on(t.userId, t.createdAt),
  ],
);

export const sharedReadingUses = pgTable(
  "shared_reading_uses",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    changed: integer("changed").notNull(),
    countedAt: tz("counted_at").notNull().defaultNow(),
  },
  (t) => [check("shared_reading_uses_changed", sql`${t.changed} >= 0`), index("shared_reading_uses_counted_idx").on(t.countedAt)],
);
