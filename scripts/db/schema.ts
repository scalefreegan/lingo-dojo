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
// the row-level security planned for the read-only role (bead ld-t5f) be one
// `learner_id = …` policy per table instead of a join per table.
//
// Deletes cascade from a parent to children that mean nothing without it
// (a learner's packs, a conversation's turns, a phrase's cards). Links that
// are only provenance (a review's conversation, an example's turn) are set
// null instead, so ending or deleting a conversation never erases memory.

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
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
import type { Overrides, VoiceCastNote, VoiceGloss, VoiceLine } from "../../web/shared/wire.ts";

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
    // The profile.yaml keys, as text (blank allowed, as in the YAML today).
    nativeLanguage: text("native_language").notNull().default(""),
    targetLanguage: text("target_language").notNull().default(""),
    targetVariant: text("target_variant").notNull().default(""),
    level: text("level").notNull().default(""),
    goals: text("goals").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
    archivedAt: tz("archived_at"),
  },
  (t) => [
    check("learners_mode", sql`${t.mode} in ('adult', 'kids')`),
    index("learners_user_idx").on(t.userId),
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
    /** The active learner. Set null when that learner is deleted, so the
     *  session falls back to the picker. That it belongs to `user_id` is the
     *  auth code's to check: a composite key could not set only this column
     *  null. */
    learnerId: uuid("learner_id").references(() => learners.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: tz("expires_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expires_idx").on(t.expiresAt)],
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
    role: text("role").$type<"user" | "assistant" | "commit">().notNull(),
    text: text("text").notNull(),
    ts: tz("ts").notNull().defaultNow(),
  },
  (t) => [
    check("agent_messages_role", sql`${t.role} in ('user', 'assistant', 'commit')`),
    index("agent_messages_user_ts_idx").on(t.userId, t.ts),
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
    units: jsonb("units").$type<string[]>().notNull().default([]),
    overrides: jsonb("overrides").$type<Overrides>().notNull().default({}),
    notes: text("notes").notNull().default(""),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    deletedAt: tz("deleted_at"),
  },
  (t) => [
    // Soft deletes: a deleted pack frees its id for a new one.
    uniqueIndex("packs_learner_folder_slug_live").on(t.learnerId, t.folder, t.slug).where(sql`${t.deletedAt} is null`),
    unique("packs_id_learner").on(t.id, t.learnerId),
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
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.learnerId, t.name] })],
);

export const packRevisions = pgTable(
  "pack_revisions",
  {
    id: id(),
    packId: uuid("pack_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    /** The pack row as it was after this action (before it, for a delete). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    action: text("action").$type<"create" | "update" | "move" | "rename" | "delete" | "restore" | "import">().notNull(),
    at: tz("at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.packId, t.learnerId], foreignColumns: [packs.id, packs.learnerId] }).onDelete("cascade"),
    index("pack_revisions_pack_at_idx").on(t.packId, t.at),
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
    /** What was played, frozen: packs change later. */
    packSnapshot: jsonb("pack_snapshot").$type<Record<string, unknown>>().notNull(),
    scenarioId: text("scenario_id"),
    title: text("title").notNull().default(""),
    mode: text("mode").$type<"adult" | "kids">().notNull(),
    targetVariant: text("target_variant").notNull().default(""),
    model: text("model"),
    /** The learner's "How long do you have?" choice; null = no limit. */
    plannedMinutes: integer("planned_minutes"),
    startedAt: tz("started_at").notNull().defaultNow(),
    endedAt: tz("ended_at"),
    turnCount: integer("turn_count").notNull().default(0),
    summary: text("summary"),
    extraction: jsonb("extraction").$type<Record<string, unknown>>(),
    extractedAt: tz("extracted_at"),
  },
  (t) => [
    check("conversations_mode", sql`${t.mode} in ('adult', 'kids')`),
    unique("conversations_id_learner").on(t.id, t.learnerId),
    index("conversations_learner_started_idx").on(t.learnerId, t.startedAt),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
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
    durationMs: integer("duration_ms"),
    costUsd: doublePrecision("cost_usd"),
    lookup: jsonb("lookup").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    check("turns_role", sql`${t.role} in ('learner', 'master')`),
    foreignKey({ columns: [t.conversationId, t.learnerId], foreignColumns: [conversations.id, conversations.learnerId] }).onDelete("cascade"),
    unique("turns_conversation_position").on(t.conversationId, t.idx),
  ],
);

/* ------------------------------- phrase bank ------------------------------ */

export const phrases = pgTable(
  "phrases",
  {
    id: id(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** BCP-47 of the variant it was learned in, e.g. es-MX. */
    lang: text("lang").notNull(),
    /** Target form; null while pending (a scenario meaning not yet paired). */
    text: text("text"),
    /** Match key (DATA.md §Identity). For a pending phrase, the key of its
     *  meaning, so the same scenario line does not pend twice. */
    norm: text("norm").notNull(),
    meaning: text("meaning"),
    note: text("note"),
    source: text("source").$type<"gloss" | "extraction" | "manual" | "scenario">().notNull(),
    /** Other target forms the grader accepted, so they grade exact next time. */
    alternates: jsonb("alternates").$type<string[]>().notNull().default([]),
    starred: boolean("starred").notNull().default(false),
    suspended: boolean("suspended").notNull().default(false),
    firstSeenAt: tz("first_seen_at"),
    lastSeenAt: tz("last_seen_at"),
    seenCount: integer("seen_count").notNull().default(0),
    lastPracticedAt: tz("last_practiced_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("phrases_source", sql`${t.source} in ('gloss', 'extraction', 'manual', 'scenario')`),
    unique("phrases_identity").on(t.learnerId, t.lang, t.norm),
    unique("phrases_id_learner").on(t.id, t.learnerId),
    // Recall and the bank list by learner + language (prefix): the identity
    // constraint's index already leads with (learner_id, lang).
    // Per-turn retrieval and LOOKUP: pg_trgm word_similarity on both sides.
    index("phrases_text_trgm").using("gin", t.text.op("gin_trgm_ops")),
    index("phrases_meaning_trgm").using("gin", t.meaning.op("gin_trgm_ops")),
  ],
);

export const phraseExamples = pgTable(
  "phrase_examples",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "set null" }),
    sentence: text("sentence").notNull(),
    speaker: text("speaker"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    index("phrase_examples_phrase_idx").on(t.phraseId),
  ],
);

/**
 * One FSRS memory per phrase and skill. The columns cover every field of
 * ts-fsrs 6's `Card` (due, stability, difficulty, scheduled_days,
 * learning_steps, reps, lapses, state, last_review) plus `stability_fast`,
 * which its FSRS-7 default scheduler adds. `elapsed_days` is gone: ts-fsrs 6
 * dropped it from the card (it is now - last_review). `scheduled_days` is a
 * double because FSRS-7 schedules fractional days.
 */
export const cards = pgTable(
  "cards",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    skill: text("skill").$type<"recognize" | "listen" | "produce">().notNull(),
    due: tz("due").notNull().defaultNow(),
    stability: doublePrecision("stability").notNull().default(0),
    stabilityFast: doublePrecision("stability_fast"),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    scheduledDays: doublePrecision("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    /** ts-fsrs State: 0 New, 1 Learning, 2 Review, 3 Relearning. */
    state: smallint("state").notNull().default(0),
    lastReview: tz("last_review"),
  },
  (t) => [
    check("cards_skill", sql`${t.skill} in ('recognize', 'listen', 'produce')`),
    check("cards_state", sql`${t.state} between 0 and 3`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    unique("cards_phrase_skill").on(t.phraseId, t.skill),
    unique("cards_id_learner").on(t.id, t.learnerId),
    // The practice queue and the review block: a learner's due cards.
    index("cards_learner_due_idx").on(t.learnerId, t.due),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    // Append-only and the busiest table: a bigserial is cheaper than a uuid
    // and orders by insertion for free.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: uuid("card_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    mode: text("mode").$type<"flashcard" | "cloze" | "listening" | "speak" | "session">().notNull(),
    rating: smallint("rating").notNull(),
    answer: text("answer"),
    verdict: text("verdict").$type<"exact" | "close" | "accepted" | "wrong" | "self">(),
    graderNote: text("grader_note"),
    durationMs: integer("duration_ms"),
    reviewedAt: tz("reviewed_at").notNull().defaultNow(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  },
  (t) => [
    check("reviews_mode", sql`${t.mode} in ('flashcard', 'cloze', 'listening', 'speak', 'session')`),
    check("reviews_rating", sql`${t.rating} between 1 and 4`),
    check("reviews_verdict", sql`${t.verdict} in ('exact', 'close', 'accepted', 'wrong', 'self')`),
    foreignKey({ columns: [t.cardId, t.learnerId], foreignColumns: [cards.id, cards.learnerId] }).onDelete("cascade"),
    index("reviews_card_at_idx").on(t.cardId, t.reviewedAt),
    // "Trouble": lapses in the last 30 days, per learner.
    index("reviews_learner_at_idx").on(t.learnerId, t.reviewedAt),
  ],
);

export const clozeItems = pgTable(
  "cloze_items",
  {
    id: id(),
    phraseId: uuid("phrase_id").notNull(),
    learnerId: uuid("learner_id").notNull(),
    sentence: text("sentence").notNull(),
    /** Character offsets of the blank in `sentence`, end exclusive. */
    blankStart: integer("blank_start").notNull(),
    blankEnd: integer("blank_end").notNull(),
    hint: text("hint"),
    origin: text("origin").$type<"example" | "generated">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("cloze_items_origin", sql`${t.origin} in ('example', 'generated')`),
    check("cloze_items_blank", sql`0 <= ${t.blankStart} and ${t.blankStart} < ${t.blankEnd}`),
    foreignKey({ columns: [t.phraseId, t.learnerId], foreignColumns: [phrases.id, phrases.learnerId] }).onDelete("cascade"),
    index("cloze_items_phrase_idx").on(t.phraseId),
  ],
);
