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
// 0005_bank_reader (the content agent's read-only phrase-bank reader,
// docs/DATA.md §Content agent): drizzle-kit writes the five ENABLE ROW LEVEL
// SECURITY lines from schema.ts's .enableRLS(); appended after them is one
// DO block (READER_0005) that makes or reuses the read-only role (its name
// is configurable, which drizzle-kit's pgRole/pgPolicy can't express), lets
// the migrating role SET ROLE to it, grants it SELECT on exactly
// READER_COLUMNS and creates one policy per table for it alone.
//
// 0006_cloze (fill-in-the-blank practice, docs/DATA.md §Practice modes):
//  1. Clears cloze_items first (CLEAR_0006). Nothing wrote the table before
//     this migration, so it holds no row; one that some other tool left
//     would have no phrase key for the new NOT NULL column, and the table
//     is a cache the app refills (an example's item again from the line, a
//     generated one at the cost of one call). Not a guard like 0003's: a
//     cache isn't worth refusing to start over.
//  2. Reordered (ORDER_0006): drizzle-kit adds cloze_items_example_fk
//     before phrase_examples_id_phrase, the unique key it references.
//  The reader role of 0005 gets nothing on cloze_items: the table's
//  sentences are the learner's own session lines.
//
//   node scripts/db/hand-edits.mjs [tag]   re-applies them to that migration
//                                          (default 0000_init) after
//                                          regenerating it (idempotent)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_DIR, READER_ROLE, READER_ROLE_RE } from "./config.mjs";

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
  phrase_sightings_conversation_profile_fk: "conversation_id",
  phrase_sightings_turn_profile_fk: "turn_id",
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

/* ---------------------------- 0005_bank_reader ----------------------------- */


/**
 * Exactly what the reader may SELECT, table → columns. Nothing else is
 * granted: no account table (users, sessions, settings, agent chat), no
 * pack, no example sentence, no typed practice answer, no recap JSON or
 * pack snapshot. `learner_id` and `language_profile_id` are granted so the
 * bank MCP's own WHERE can name them; the policy filters on them anyway.
 */
export const READER_COLUMNS = {
  conversations: ["id", "learner_id", "language_profile_id", "title", "scenario_id", "target_language", "target_variant", "started_at", "ended_at", "turn_count", "summary", "extraction_status"],
  turns: ["id", "conversation_id", "learner_id", "language_profile_id", "idx", "role", "text", "lines", "glosses", "from_client", "created_at"],
  phrases: ["id", "learner_id", "language_profile_id", "text", "meaning", "source", "starred", "suspended", "first_seen_at", "last_seen_at", "seen_count", "last_practiced_at", "created_at"],
  cards: ["id", "phrase_id", "learner_id", "language_profile_id", "skill", "due", "stability", "stability_fast", "difficulty", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review"],
  reviews: ["card_id", "learner_id", "language_profile_id", "mode", "rating", "reviewed_at", "card_before"],
};

/** The one policy per table: a row is visible to the reader only when both
 *  its learner and its language are the ones the transaction set. Unset
 *  (or empty) settings are NULL, and NULL matches nothing. */
export const READER_POLICY = "bank_reader_scope";
const SCOPE =
  "learner_id = nullif(current_setting('app.learner_id', true), '')::uuid AND language_profile_id = nullif(current_setting('app.language_profile_id', true), '')::uuid";

const MARK_0005 = "-- Hand-written (scripts/db/hand-edits.mjs, 0005):";

const q = (s) => s.replace(/'/g, "''");

const READER_0005 = `${MARK_0005} the content agent's read-only role,
-- its column grants and its row-level security policies (docs/DATA.md
-- §Content agent). The role's name is the setting lingo.reader_role when
-- set (tests on a shared server use a throwaway one), else ${READER_ROLE}.
-- Roles are cluster-wide: an existing role is reused, after checking it
-- has no power beyond what this grants, no member but the app's role and
-- no default privileges here. The policies apply to that role only, and
-- RLS is enabled, not forced, so the table owner (the app) is unaffected.
DO $$
DECLARE
  reader text := coalesce(nullif(current_setting('lingo.reader_role', true), ''), '${READER_ROLE}');
  me text := current_user;
  existing record;
  others text;
  d record;
  t text;
BEGIN
  IF reader !~ '${READER_ROLE_RE.source}' THEN
    RAISE EXCEPTION '0005_bank_reader: lingo.reader_role must look like ${READER_ROLE}[a-z0-9_]*, got %', reader;
  END IF;
  SELECT * INTO existing FROM pg_roles WHERE rolname = reader;
  IF NOT FOUND THEN
    IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = me) THEN
      RAISE EXCEPTION '0005_bank_reader: the read-only role % does not exist and % may not create it', reader, me
        USING HINT = format('As a superuser, run: CREATE ROLE %I NOLOGIN; GRANT %I TO %I WITH INHERIT FALSE, SET TRUE; then npm run db:setup again.', reader, reader, me);
    END IF;
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', reader);
  ELSIF existing.rolsuper OR existing.rolbypassrls OR existing.rolcanlogin OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication THEN
    RAISE EXCEPTION '0005_bank_reader: the role % exists with more than read access (superuser, bypassrls, login, createrole, createdb or replication)', reader
      USING HINT = format('As a superuser, run: ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOLOGIN NOCREATEROLE NOCREATEDB NOREPLICATION; then npm run db:setup again.', reader);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = reader) THEN
    RAISE EXCEPTION '0005_bank_reader: the role % is a member of another role, whose privileges it would have', reader
      USING HINT = 'Revoke its memberships (pg_auth_members lists them), then npm run db:setup again.';
  END IF;
  -- Nobody but the app's role may hold the reader: another member could
  -- SET ROLE to it, or inherit the grants below.
  SELECT string_agg(DISTINCT r.rolname, ', ' ORDER BY r.rolname) INTO others
    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
   WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = reader) AND r.rolname <> me;
  IF others IS NOT NULL THEN
    RAISE EXCEPTION '0005_bank_reader: the role % has other members: %', reader, others
      USING HINT = format('As a superuser, revoke it from them (REVOKE %I FROM <role>), then npm run db:setup again.', reader);
  END IF;
  -- Default privileges in this database that name the reader would hand it
  -- tables made later. Those this role set are cleared; any other is
  -- refused, naming its owner.
  FOR d IN
    SELECT a.defaclrole::regrole::text AS owner, n.nspname AS schema,
           CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END AS kind
      FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid = a.defaclnamespace
     WHERE a.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = me)
       AND EXISTS (SELECT 1 FROM aclexplode(a.defaclacl) x WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = reader))
  LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %I',
      me, CASE WHEN d.schema IS NULL THEN '' ELSE format('IN SCHEMA %I', d.schema) END, d.kind, reader);
  END LOOP;
  SELECT string_agg(format('%s (for objects of %s%s)', a.defaclobjtype, a.defaclrole::regrole, coalesce(' in schema ' || n.nspname, '')), ', ') INTO others
    FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid = a.defaclnamespace
   WHERE a.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = reader)
      OR EXISTS (SELECT 1 FROM aclexplode(a.defaclacl) x WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = reader));
  IF others IS NOT NULL THEN
    RAISE EXCEPTION '0005_bank_reader: default privileges in this database name the role %: %', reader, others
      USING HINT = format('As that owner, run ALTER DEFAULT PRIVILEGES FOR ROLE <owner> REVOKE ALL ON <kind> FROM %I (\\ddp lists them), then npm run db:setup again.', reader);
  END IF;
  -- The app's own role enters the reader with SET ROLE inside a read-only
  -- transaction: it needs a membership with SET and without INHERIT. Granted
  -- explicitly even to a superuser (who could SET ROLE without it), so the
  -- grant is in the catalog: a dump restored as another role, or a role
  -- that stops being a superuser, still has it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = reader)
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = me)
       AND m.set_option AND NOT m.inherit_option
  ) THEN
    BEGIN
      EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', reader, me);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0005_bank_reader: % may not grant itself the role %', me, reader
        USING HINT = format('As a superuser, run: GRANT %I TO %I WITH INHERIT FALSE, SET TRUE; then npm run db:setup again.', reader, me);
    END;
  END IF;
  -- Exactly these grants in this database, whatever the role had here.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', reader);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', reader);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', reader);
${Object.entries(READER_COLUMNS)
  .map(([table, cols]) => `  EXECUTE format('GRANT SELECT (${cols.map((c) => `"${c}"`).join(", ")}) ON "${table}" TO %I', reader);`)
  .join("\n")}
  FOREACH t IN ARRAY ARRAY[${Object.keys(READER_COLUMNS).map((t) => `'${t}'`).join(", ")}] LOOP
    EXECUTE format('CREATE POLICY ${READER_POLICY} ON %I AS PERMISSIVE FOR SELECT TO %I USING (${q(SCOPE)})', t, reader);
  END LOOP;
END $$;`;

function bankReaderEdits(generated) {
  if (generated.includes(MARK_0005)) return generated; // already applied
  const stmts = statements(generated);
  const tables = Object.keys(READER_COLUMNS);
  // drizzle-kit's part is exactly the five ENABLE ROW LEVEL SECURITY lines
  // and agent_messages' bank scope column (chat.ts) with its foreign key.
  const expected = new Set([
    ...tables.map((t) => `ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`),
    'ALTER TABLE "agent_messages" ADD COLUMN "bank_language_profile_id" uuid;',
    'ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_bank_language_profile_id_language_profiles_id_fk" FOREIGN KEY ("bank_language_profile_id") REFERENCES "public"."language_profiles"("id") ON DELETE cascade ON UPDATE no action;',
  ]);
  for (const s of stmts) if (!expected.has(s)) throw new Error(`hand-edits 0005: a generated statement this edit doesn't expect:\n${s}`);
  if (stmts.length !== expected.size) throw new Error(`hand-edits 0005: expected ${expected.size} generated statements, got ${stmts.length}`);
  return joinStatements([...stmts, READER_0005]);
}

/* -------------------------------- 0006_cloze -------------------------------- */

const MARK_0006 = "-- Hand-written (scripts/db/hand-edits.mjs, 0006 edit 1):";

const CLEAR_0006 = `${MARK_0006} cloze_items is a cache nothing
-- wrote before this migration; any row would have no phrase key (see the
-- header of hand-edits.mjs).
DELETE FROM "cloze_items";`;

const ORDER_0006 = [
  { name: "clear", insert: [CLEAR_0006] },
  { name: "relaxed columns", re: /^ALTER TABLE "cloze_items" ALTER COLUMN "\w+" DROP NOT NULL;$/ },
  // Not "new columns": reorder() takes that bucket's NOT NULL off for a
  // backfill to set; this key is NOT NULL at once (the table is empty).
  { name: "added columns", re: /^ALTER TABLE "cloze_items" ADD COLUMN / },
  { name: "unique keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" UNIQUE\(/ },
  { name: "foreign keys", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" FOREIGN KEY / },
  { name: "checks", re: /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" CHECK / },
  { name: "indexes", re: /^CREATE (UNIQUE )?INDEX "/ },
];

function clozeEdits(generated) {
  if (generated.includes(MARK_0006)) return generated; // already applied
  return reorder(generated, ORDER_0006, "0006");
}

/* ---------------------------------- all ------------------------------------ */

const EDITS = {
  "0000_init": initEdits,
  "0002_language_profiles": languageProfileEdits,
  "0003_phrase_bank_per_language": phraseBankEdits,
  "0005_bank_reader": bankReaderEdits,
  "0006_cloze": clozeEdits,
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
