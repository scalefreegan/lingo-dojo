// Migration 0004 (the session recap's columns: the extraction claim and
// status on conversations, a source on phrase sightings) against a database
// at 0003 with data in it: accounts, learners, languages, open and ended
// conversations, turns, and a bank with phrases, an example, sightings,
// cards and a review. It only adds columns with defaults, a partial unique
// index and three checks, so every row stays as it was, the new columns
// read 'none' / 0 / null on conversations and 'gloss' on sightings (all of
// them are a gloss's: nothing else wrote one before), and the schema is a
// fresh build's. Shared by the PGlite test (db-migration-0004.test.mjs)
// and the real-Postgres one (migration-0004.pg.test.mjs, PostgreSQL 17
// under LINGO_TEST_PG_URL). Not a test itself. Every name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

/** The migrations up to and including 0003. */
export const migrationsBefore0004 = () => upTo('CREATE TABLE "phrase_dismissals"', "0003");
/** Up to and including 0004. */
export const migrationsThrough0004 = () => upTo('ADD COLUMN "extraction_status"', "0004");

const U = "00000000-0000-4000-8000-000000000001";
const L = "00000000-0000-4000-8000-0000000000a1";
const LP = "00000000-0000-4000-8000-0000000000e1";
const C = { open: "00000000-0000-4000-8000-0000000000d1", ended: "00000000-0000-4000-8000-0000000000d2" };
const T = { a: "00000000-0000-4000-8000-0000000000f1", b: "00000000-0000-4000-8000-0000000000f2" };
const P = "00000000-0000-4000-8000-0000000000c1";
const K = "00000000-0000-4000-8000-0000000000c2";

/** A database at 0003 with a bank in use. */
export async function seedBefore0004(query) {
  await query(`insert into users (id, username, password_hash) values ($1, 'robin', 'scrypt$x')`, [U]);
  await query(`insert into learners (id, user_id, name, mode, native_language) values ($1, $2, 'Sam', 'adult', 'English')`, [L, U]);
  await query(`insert into language_profiles (id, learner_id, target_language, target_variant, level) values ($1, $2, 'Spanish', 'Mexican Spanish', 'A2')`, [LP, L]);
  await query(
    `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language, ended_at, summary) values
       ($1, $3, $4, '{}', 'Open', 'adult', 'Spanish', null, null), ($2, $3, $4, '{}', 'Ended', 'adult', 'Spanish', now(), null)`,
    [C.open, C.ended, L, LP],
  );
  await query(
    `insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, text, lines) values
       ($1, $3, $4, $5, 0, 'master', null, '[{"speaker":"narrator","gender":null,"text":"¿A cómo el kilo?","segments":[]}]'),
       ($2, $3, $4, $5, 1, 'learner', 'A veinte.', null)`,
    [T.a, T.b, C.ended, L, LP],
  );
  await query(
    `insert into phrases (id, learner_id, language_profile_id, lang, text, norm, meaning, source, seen_count) values ($1, $2, $3, 'es-MX', '¿A cómo?', 'a cómo', 'how much?', 'gloss', 1)`,
    [P, L, LP],
  );
  await query(`insert into phrase_examples (phrase_id, learner_id, language_profile_id, conversation_id, turn_id, sentence) values ($1, $2, $3, $4, $5, '¿A cómo el kilo?')`, [P, L, LP, C.ended, T.a]);
  await query(`insert into phrase_sightings (phrase_id, learner_id, language_profile_id, conversation_id, turn_id) values ($1, $2, $3, $4, $5)`, [P, L, LP, C.ended, T.a]);
  await query(`insert into cards (id, phrase_id, learner_id, language_profile_id, skill, reps, state) values ($1, $2, $3, $4, 'recognize', 1, 1)`, [K, P, L, LP]);
  await query(`insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before, conversation_id) values ($1, $2, $3, 'flashcard', 3, '{"state":0}', null)`, [K, L, LP]);
}

const NEW_COLUMNS = {
  conversations: ["extraction_status", "extraction_claim", "extraction_started_at", "extraction_attempts", "extraction_error"],
  phrase_sightings: ["source"],
};

/** Every row of every public table as JSON text, less 0004's new columns. */
async function oldContents(query) {
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((r) => r.tablename);
  const out = {};
  for (const t of tables) {
    const minus = (NEW_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join("");
    out[t] = (await query(`select (to_jsonb(t)${minus})::text as row from "${t}" t order by 1`)).map((r) => r.row);
  }
  return out;
}

/** 0004 applies on `query` (at 0003, seeded): the old rows are untouched,
 *  the new columns hold their defaults, the schema is `fresh`'s (migrated
 *  from nothing through 0004), and the new checks hold. */
export async function migrateAndCheck0004(query, fresh) {
  const before = await oldContents(query);
  const { applied } = await applyMigrations(query, migrationsThrough0004());
  assert.equal(applied.length, 1);
  assert.equal((await migrationState(query, migrationsThrough0004())).status, "current");
  assert.deepEqual(await oldContents(query), before);
  assert.deepEqual(
    await query(`select title, extraction_status, extraction_claim, extraction_started_at, extraction_attempts, extraction_error from conversations order by title`),
    [
      { title: "Ended", extraction_status: "none", extraction_claim: null, extraction_started_at: null, extraction_attempts: 0, extraction_error: null },
      { title: "Open", extraction_status: "none", extraction_claim: null, extraction_started_at: null, extraction_attempts: 0, extraction_error: null },
    ],
  );
  assert.deepEqual(await query(`select source from phrase_sightings`), [{ source: "gloss" }]);
  assert.deepEqual(await catalog(query), await catalog(fresh));
  // The claim check: running exactly when a claim is held.
  await assert.rejects(query(`update conversations set extraction_status = 'running' where id = $1`, [C.ended]), /conversations_extraction_claim/);
  await assert.rejects(query(`update conversations set extraction_status = 'later' where id = $1`, [C.ended]), /conversations_extraction_status/);
  await query(`update conversations set extraction_status = 'running', extraction_claim = gen_random_uuid() where id = $1`, [C.ended]);
  // One recap sighting per conversation and phrase; a gloss's alongside it is fine.
  const recap = `insert into phrase_sightings (phrase_id, learner_id, language_profile_id, conversation_id, turn_id, source) values ($1, $2, $3, $4, null, 'extraction')`;
  await query(recap, [P, L, LP, C.ended]);
  await assert.rejects(query(recap, [P, L, LP, C.ended]), /phrase_sightings_extraction_once/);
  await assert.rejects(query(`update phrase_sightings set source = 'guess'`), /phrase_sightings_source/);
}
