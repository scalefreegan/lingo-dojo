// The hand edits to generated migrations, in one place: each committed
// migration is exactly `applyHandEdits(<drizzle-kit output>, <tag>)`.
// scripts/tests/db-migrations.test.mjs regenerates the SQL from schema.ts
// and checks that, so schema, snapshot and SQL can't drift apart unnoticed.
// A migration with no entry in EDITS is drizzle-kit's output as it is.
//
// 0000_init, two things drizzle-kit can't express:
//  1. `CREATE EXTENSION IF NOT EXISTS pg_trgm` first, before the
//     gin_trgm_ops indexes need it.
//  2. Composite provenance keys delete with `ON DELETE SET NULL (<col>)`
//     (PostgreSQL 15+), nulling only the link and keeping the not-null
//     owner column. schema.ts declares them with a plain "set null".
//
// 0002_language_profiles (language profiles, docs/DATA.md §Schema), whose
// generated SQL can't run at all, even on an empty database, and knows
// nothing of the rows already there:
//  1. Reordered: drizzle-kit adds pack_folders' new primary key before the
//     column it is on, and the (pack_id, language_profile_id) foreign key
//     before the unique key it references. The statements are sorted into
//     the order below; every generated statement must land in exactly one
//     place, or this throws (a regenerated migration with a statement it
//     doesn't know is a schema change to look at, not to paper over).
//  2. The five `language_profile_id … NOT NULL` columns are added nullable,
//     filled from the backfill, then set NOT NULL.
//  3. The backfill (BACKFILL below): one profile per existing learner from
//     its own target_language, target_variant, level, goals and notes;
//     every pack, folder, revision, conversation and turn is pointed at its
//     learner's profile, and every session with a learner gets it as the
//     active one. All before the learner columns are dropped (last).
//  4. auth_sessions_language_profile_fk deletes with SET NULL
//     ("language_profile_id"), as in 0000.
//
// 0003_phrase_bank_per_language (the phrase bank moves under language
// profiles, docs/DATA.md §Phrase bank):
//  1. A guard first (GUARD_0003): it refuses, with a clear message, to run on
//     a database whose bank tables hold any row. No code wrote them before
//     this migration, so none should; and a learner's phrases can't be put
//     under one of its languages without knowing which (`lang` is a variant,
//     a profile a language, and a learner may have none or several), so a
//     database that does have rows needs a decision, not a guess. The
//     migration runs in one transaction: a refusal leaves 0002 as it was.
//  2. Reordered (ORDER_0003): drizzle-kit adds the foreign keys before the
//     unique keys they reference.
//  3. The keys that keep an example's conversation and turn, and a review's
//     conversation, in the row's language delete with SET NULL (col), as in
//     0000.
//
//   node scripts/db/hand-edits.mjs [tag]   re-applies them to that migration
//                                          (default 0000_init) after
//                                          regenerating it (idempotent)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_DIR } from "./config.mjs";

export const INITIAL_MIGRATION = path.join(MIGRATIONS_DIR, "0000_init.sql");

const BREAK = "--> statement-breakpoint";

/* -------------------------------- 0000_init -------------------------------- */

const EXTENSION = `-- Hand-added (scripts/db/hand-edits.mjs): trigram search needs pg_trgm before
-- the gin_trgm_ops indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
${BREAK}
`;

/** 0000's constraint name → the one column its ON DELETE nulls. */
const INITIAL_SET_NULL = {
  auth_sessions_learner_fk: "learner_id",
  phrase_examples_conversation_fk: "conversation_id",
  phrase_examples_turn_fk: "turn_id",
  reviews_conversation_fk: "conversation_id",
};

/** 0002's. */
const PROFILE_SET_NULL = { auth_sessions_language_profile_fk: "language_profile_id" };

/** Every SET NULL (col) key in the schema, constraint name → column (the
 *  catalog test checks the migrated database has exactly these). */
/** 0003's: an example's conversation and turn, a review's conversation, in
 *  the row's own language. */
const BANK_SET_NULL = {
  phrase_examples_conversation_profile_fk: "conversation_id",
  phrase_examples_turn_profile_fk: "turn_id",
  reviews_conversation_profile_fk: "conversation_id",
};

export const SET_NULL_COLUMNS = { ...INITIAL_SET_NULL, ...PROFILE_SET_NULL, ...BANK_SET_NULL };

function setNull(sql, keys) {
  let out = sql;
  for (const [name, col] of Object.entries(keys)) {
    const line = new RegExp(`(ADD CONSTRAINT "${name}" FOREIGN KEY [^\\n]*?ON DELETE )(set null|SET NULL \\("${col}"\\))`);
    if (!line.test(out)) throw new Error(`hand-edits: no ON DELETE set null for constraint ${name} in the generated SQL`);
    out = out.replace(line, `$1SET NULL ("${col}")`);
  }
  return out;
}

function initEdits(generated) {
  const out = generated.startsWith(EXTENSION) ? generated : EXTENSION + generated;
  return setNull(out, INITIAL_SET_NULL);
}

/* -------------------------- 0002_language_profiles ------------------------- */

/** The tables that move under a language profile, in the backfill's order. */
const PROFILE_TABLES = ["packs", "pack_folders", "pack_revisions", "conversations", "turns"];

const MARK = "-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3):";

const BACKFILL = [
  `${MARK} one language profile per existing
-- learner, from the learner's own per-language columns (dropped below). It
-- is the learner's only one, so last_used_at makes it the one picking the
-- learner lands on.
INSERT INTO "language_profiles" ("learner_id", "target_language", "target_variant", "level", "goals", "notes", "created_at", "last_used_at")
SELECT "id", "target_language", "target_variant", "level", "goals", "notes", "created_at", now() FROM "learners";`,
  ...PROFILE_TABLES.map(
    (t) => `${MARK} every ${t} row goes under its learner's profile.
UPDATE "${t}" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "${t}"."learner_id";`,
  ),
  `${MARK} a session with a learner practises that learner's
-- one language.
UPDATE "auth_sessions" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "auth_sessions"."learner_id";`,
  ...PROFILE_TABLES.map((t) => `ALTER TABLE "${t}" ALTER COLUMN "language_profile_id" SET NOT NULL;`),
];

/** Where each generated statement goes, in order; the first rule a
 *  statement matches places it. */
const ORDER = [
  { name: "create language_profiles", re: /^CREATE TABLE "language_profiles"/ },
  { name: "language_profiles' own keys", re: /^(ALTER TABLE "language_profiles" ADD CONSTRAINT|CREATE INDEX "language_profiles_)/ },
  { name: "new columns", re: /^ALTER TABLE "\w+" ADD COLUMN "language_profile_id" uuid( NOT NULL)?;$/ },
  { name: "backfill", insert: BACKFILL },
  { name: "old keys out", re: /^(DROP INDEX "packs_learner_folder_slug_live"|ALTER TABLE "pack_folders" DROP CONSTRAINT "pack_folders_learner_id_name_pk");$/ },
  { name: "new primary and unique keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" (PRIMARY KEY|UNIQUE)\(/ },
  { name: "foreign keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" FOREIGN KEY / },
  { name: "indexes", re: /^CREATE (UNIQUE )?INDEX "/ },
  { name: "learner columns out, last", re: /^ALTER TABLE "learners" DROP COLUMN "(target_language|target_variant|level|goals|notes)";$/ },
];

const statements = (sql) => sql.split(BREAK).map((s) => s.trim()).filter(Boolean);
const joinStatements = (list) => list.map((s) => `${s}\n`).join(`${BREAK}\n`);

/** The generated statements sorted into `order`'s buckets (the first rule
 *  a statement matches places it; a "new columns" one loses its NOT NULL,
 *  which the backfill sets), with each `insert` bucket's hand-written
 *  statements in place. Every generated statement must land somewhere and
 *  every rule must catch one, or this throws: a regenerated migration with
 *  a statement it doesn't know is a schema change to look at, not to paper
 *  over. */
function reorder(generated, order, tag) {
  const buckets = order.map(() => []);
  for (const stmt of statements(generated)) {
    const i = order.findIndex((o) => o.re?.test(stmt));
    if (i < 0) throw new Error(`hand-edits ${tag}: a generated statement no rule places:\n${stmt}`);
    // Added nullable; the backfill fills it and sets NOT NULL.
    buckets[i].push(order[i].name === "new columns" ? stmt.replace(/ NOT NULL;$/, ";") : stmt);
  }
  order.forEach((o, i) => {
    if (o.insert) buckets[i].push(...o.insert);
    else if (!buckets[i].length) throw new Error(`hand-edits ${tag}: the generated SQL has nothing for "${o.name}"`);
  });
  return joinStatements(buckets.flat());
}

function languageProfileEdits(generated) {
  if (generated.includes(MARK)) return generated; // already applied
  return setNull(reorder(generated, ORDER, "0002"), PROFILE_SET_NULL);
}

/* ---------------------- 0003_phrase_bank_per_language ---------------------- */

/** The bank's tables, which must be empty for 0003 to run. */
const BANK_TABLES = ["phrases", "phrase_examples", "cards", "cloze_items", "reviews"];

const MARK_0003 = "-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 1):";

export const GUARD_0003_MESSAGE =
  "0003_phrase_bank_per_language: the phrase bank tables already hold rows. This migration moves the bank under language profiles and does not guess which language an existing phrase belongs to; empty phrases, phrase_examples, cards, cloze_items and reviews (or assign them by hand) and run it again.";

const GUARD_0003 = `${MARK_0003} refuse to run on a bank that has rows
-- (see the header of hand-edits.mjs); nothing is changed.
DO $$
BEGIN
  IF ${BANK_TABLES.map((t) => `EXISTS (SELECT 1 FROM "${t}")`).join("\n    OR ")} THEN
    RAISE EXCEPTION '${GUARD_0003_MESSAGE.replace(/'/g, "''")}';
  END IF;
END $$;`;

const ORDER_0003 = [
  { name: "guard", insert: [GUARD_0003] },
  { name: "new tables", re: /^CREATE TABLE "/ },
  { name: "old learner indexes out", re: /^DROP INDEX "(cards_learner_due_idx|phrases_identity|phrases_pending_identity|reviews_learner_at_idx)";$/ },
  { name: "profile columns", re: /^ALTER TABLE "\w+" ADD COLUMN "language_profile_id" uuid NOT NULL;$/ },
  { name: "edit marker", re: /^ALTER TABLE "phrases" ADD COLUMN "edited_at" timestamp with time zone;$/ },
  { name: "new unique keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" UNIQUE\(/ },
  { name: "foreign keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" FOREIGN KEY / },
  { name: "indexes", re: /^CREATE (UNIQUE )?INDEX "/ },
];

function phraseBankEdits(generated) {
  if (generated.includes(MARK_0003)) return generated; // already applied
  return setNull(reorder(generated, ORDER_0003, "0003"), BANK_SET_NULL);
}

/* ---------------------------------- all ------------------------------------ */

const EDITS = {
  "0000_init": initEdits,
  "0002_language_profiles": languageProfileEdits,
  "0003_phrase_bank_per_language": phraseBankEdits,
};

/** The migration `tag` as committed, from drizzle-kit's output for it. */
export function applyHandEdits(generated, tag = "0000_init") {
  const edit = EDITS[tag];
  return edit ? edit(generated) : generated;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? "0000_init";
  const file = path.join(MIGRATIONS_DIR, `${tag}.sql`);
  const before = fs.readFileSync(file, "utf8");
  const after = applyHandEdits(before, tag);
  fs.writeFileSync(file, after);
  console.log(before === after ? "hand edits already applied" : `hand edits applied to ${file}`);
}
