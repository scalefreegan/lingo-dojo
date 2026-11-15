// Migration 0003 (the phrase bank moves under language profiles) against a
// database at 0002 with data in it. 0003 moves no bank row: it refuses to run
// while any bank table has one (hand-edits.mjs, GUARD_0003), because nothing
// wrote the bank before it and no rule can say which language an old phrase
// belongs to. So: with accounts, learners, languages, conversations and turns
// but an empty bank it applies, leaves those rows as they were, and gives the
// same schema as a database built from nothing; with any bank row it fails
// in its own transaction and leaves the 0002 schema and every row in place.
// Shared by the PGlite test (db-migration-0003.test.mjs) and the
// real-Postgres one (migration-0003.pg.test.mjs, PostgreSQL 17 under
// LINGO_TEST_PG_URL). Not a test itself (the npm glob is *.test.mjs). Every
// name here is made up.

import assert from "node:assert/strict";
import { GUARD_0003_MESSAGE } from "../db/hand-edits.mjs";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

/** The migrations up to and including 0002. */
export const migrationsBefore0003 = () => upTo('CREATE TABLE "language_profiles"', "0002");

/** The migrations up to and including 0003. */
export const migrationsThrough0003 = () => upTo('CREATE TABLE "phrase_dismissals"', "0003");

const U = { robin: "00000000-0000-4000-8000-000000000001", lee: "00000000-0000-4000-8000-000000000002" };
const L = { sam: "00000000-0000-4000-8000-0000000000a1", ana: "00000000-0000-4000-8000-0000000000b1" };
const LP = {
  samEs: "00000000-0000-4000-8000-0000000000e1",
  samDe: "00000000-0000-4000-8000-0000000000e2",
  ana: "00000000-0000-4000-8000-0000000000e3",
};
const C = { sam: "00000000-0000-4000-8000-0000000000d1", samDe: "00000000-0000-4000-8000-0000000000d2" };

/** Fill a database at 0002 with everything but the bank: two accounts, a
 *  learner with two languages, another with one, conversations and turns. */
export async function seedBefore0003(query) {
  await query(`insert into users (id, username, password_hash) values ($1, 'robin', 'scrypt$x'), ($2, 'lee', 'scrypt$x')`, [U.robin, U.lee]);
  await query(
    `insert into learners (id, user_id, name, mode, native_language, created_at) values
       ($1, $3, 'Sam', 'adult', 'English', '2026-10-01T09:00:00Z'), ($2, $4, 'Ana', 'adult', 'Spanish', '2026-10-05T09:00:00Z')`,
    [L.sam, L.ana, U.robin, U.lee],
  );
  await query(
    `insert into language_profiles (id, learner_id, target_language, target_variant, level, created_at, last_used_at) values
       ($1, $4, 'Spanish', 'Mexican Spanish', 'A2', '2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z'),
       ($2, $4, 'German', '', 'A1', '2026-11-01T09:00:00Z', now()),
       ($3, $5, 'French', '', 'B2', '2026-10-05T09:00:00Z', now())`,
    [LP.samEs, LP.samDe, LP.ana, L.sam, L.ana],
  );
  await query(
    `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language) values
       ($1, $3, $4, '{}', 'Market', 'adult', 'Spanish'), ($2, $3, $5, '{}', 'Markt', 'adult', 'German')`,
    [C.sam, C.samDe, L.sam, LP.samEs, LP.samDe],
  );
  await query(
    `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values
       ($1, $2, $3, 0, 'learner', '¿A cómo?'), ($4, $2, $5, 0, 'learner', 'Hallo')`,
    [C.sam, L.sam, LP.samEs, C.samDe, LP.samDe],
  );
}

/** One row in `table` of the 0002 bank (keyed by learner and lang), with
 *  the parents it needs. */
export async function seedBankRow(query, table) {
  const [{ id: phrase }] = await query(
    `insert into phrases (learner_id, lang, text, norm, meaning, source) values ($1, 'es-MX', '¿A cómo?', 'a cómo', 'how much?', 'gloss') returning id`,
    [L.sam],
  );
  if (table === "phrases") return;
  if (table === "phrase_examples") return void (await query(`insert into phrase_examples (phrase_id, learner_id, sentence) values ($1, $2, '¿A cómo el kilo?')`, [phrase, L.sam]));
  if (table === "cloze_items")
    return void (await query(`insert into cloze_items (phrase_id, learner_id, sentence, blank_start, blank_end, origin) values ($1, $2, '¿A cómo?', 0, 8, 'example')`, [phrase, L.sam]));
  const [{ id: card }] = await query(`insert into cards (phrase_id, learner_id, skill) values ($1, $2, 'recognize') returning id`, [phrase, L.sam]);
  if (table === "cards") return;
  await query(`insert into reviews (card_id, learner_id, mode, rating, card_before) values ($1, $2, 'flashcard', 3, '{}')`, [card, L.sam]);
}

/** Every row of the tables that hold data, as text, for before/after. */
export async function contents(query) {
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = (await query(`select t::text as row from "${t}" t order by 1`)).map((r) => r.row);
  return out;
}

/** The public schema's shape: columns, constraints and indexes. */
export async function catalog(query) {
  const columns = await query(`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public' order by 1, 2`);
  const constraints = await query(`
    select r.relname as table, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' order by 1, 2`);
  const indexes = await query(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`);
  return { columns, constraints, indexes };
}

const without = (rows, ...tables) => Object.fromEntries(Object.entries(rows).filter(([t]) => !tables.includes(t)));

/** Empty bank: 0003 applies, the other rows are untouched, and the schema is
 *  `fresh`'s (a database migrated from nothing). */
export async function migrateEmptyAndCheck(query, fresh) {
  const before = await contents(query);
  await applyMigrations(query, migrationsThrough0003());
  assert.equal((await migrationState(query, migrationsThrough0003())).status, "current");
  // (The migrations table is in the drizzle schema, not public.)
  const after = await contents(query);
  // The tables 0003 makes are new and empty (so the guard needn't cover them).
  assert.deepEqual(without(after, "phrase_dismissals", "phrase_sightings"), before);
  assert.deepEqual([after.phrase_dismissals, after.phrase_sightings], [[], []]);
  assert.deepEqual(await catalog(query), await catalog(fresh));
}

/** A bank row present: 0003 fails with the guard's message, in its own
 *  transaction, leaving the 0002 schema and every row as they were. */
export async function refuseAndCheck(query) {
  const schema = await catalog(query);
  const rows = await contents(query);
  await assert.rejects(applyMigrations(query, migrationsThrough0003()), (e) => {
    assert.ok(String(e.message).includes(GUARD_0003_MESSAGE), `the guard's message, not: ${e.message}`);
    return true;
  });
  assert.deepEqual(await catalog(query), schema);
  assert.deepEqual(await contents(query), rows);
  assert.deepEqual(await migrationState(query, migrationsBefore0003()).then((s) => s.status), "current");
}

/** The bank tables, each of which alone must stop 0003. */
export const BANK_TABLES = ["phrases", "phrase_examples", "cards", "cloze_items", "reviews"];
