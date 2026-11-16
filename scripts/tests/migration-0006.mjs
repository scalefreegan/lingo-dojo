// Migration 0006 (fill the gap: cloze_items gets its phrase key, example
// link and flag; phrase_examples a unique (id, phrase_id) for that link;
// a new cloze_calls ledger)
// against a database at 0005 with data in it: an account, a learner, a
// bank with a phrase, an example, a card and a review, and a cloze row as
// the never-written table could have held. Every row but the cloze one
// stays as it was; that one is cleared (it has no phrase key); the schema
// is a fresh build's; the new checks and keys hold; and the content
// agent's read-only role is as 0005 left it, with no grant on cloze_items
// or cloze_calls.
// Shared by the PGlite test (db-migration-0006.test.mjs) and the
// real-Postgres one (migration-0006.pg.test.mjs). Not a test itself.
// Every name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, bankReaderProblem, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

/** The migrations up to and including 0005. */
export const migrationsBefore0006 = () => upTo('ADD COLUMN "bank_language_profile_id"', "0005");
/** Up to and including 0006. */
export const migrationsThrough0006 = () => upTo('ADD COLUMN "phrase_key"', "0006");

const U = "00000000-0000-4000-8000-000000000001";
const L = "00000000-0000-4000-8000-0000000000a1";
const LP = "00000000-0000-4000-8000-0000000000e1";
const C = "00000000-0000-4000-8000-0000000000d1";
const T = "00000000-0000-4000-8000-0000000000f1";
const P = "00000000-0000-4000-8000-0000000000c1";
const E = "00000000-0000-4000-8000-0000000000b1";
const K = "00000000-0000-4000-8000-0000000000c2";
const SENTENCE = "Aquí tiene la vuelta, señora.";

/** A database at 0005 with a bank in use, and one cloze row. */
export async function seedBefore0006(query) {
  await query(`insert into users (id, username, password_hash) values ($1, 'robin', 'scrypt$x')`, [U]);
  await query(`insert into learners (id, user_id, name, mode, native_language) values ($1, $2, 'Sam', 'adult', 'English')`, [L, U]);
  await query(`insert into language_profiles (id, learner_id, target_language, target_variant, level) values ($1, $2, 'Spanish', 'Mexican Spanish', 'A2')`, [LP, L]);
  await query(`insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language, ended_at) values ($1, $2, $3, '{}', 'Market', 'adult', 'Spanish', now())`, [C, L, LP]);
  await query(
    `insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, lines) values ($1, $2, $3, $4, 0, 'master', $5)`,
    [T, C, L, LP, JSON.stringify([{ speaker: "character", gender: "female", text: SENTENCE, segments: [{ lang: "target", text: SENTENCE }] }])],
  );
  await query(`insert into phrases (id, learner_id, language_profile_id, lang, text, norm, meaning, source, seen_count) values ($1, $2, $3, 'es-MX', 'la vuelta', 'la vuelta', 'the change', 'gloss', 1)`, [P, L, LP]);
  await query(`insert into phrase_examples (id, phrase_id, learner_id, language_profile_id, conversation_id, turn_id, sentence) values ($1, $2, $3, $4, $5, $6, $7)`, [E, P, L, LP, C, T, SENTENCE]);
  await query(`insert into cards (id, phrase_id, learner_id, language_profile_id, skill, reps, state) values ($1, $2, $3, $4, 'produce', 1, 1)`, [K, P, L, LP]);
  await query(`insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) values ($1, $2, $3, 'speak', 3, '{"state":0}')`, [K, L, LP]);
  await query(`insert into cloze_items (phrase_id, learner_id, language_profile_id, sentence, blank_start, blank_end, origin) values ($1, $2, $3, $4, 11, 20, 'example')`, [P, L, LP, SENTENCE]);
}

/** Every row of every public table as JSON text, but cloze_items (and
 *  0006's new cloze_calls). */
async function oldContents(query) {
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' and tablename not in ('cloze_items', 'cloze_calls') order by 1`)).map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = (await query(`select to_jsonb(t)::text as row from "${t}" t order by 1`)).map((r) => r.row);
  return out;
}

/** 0006 applies on `query` (at 0005, seeded): the other rows untouched,
 *  the cloze row cleared, the schema `fresh`'s, the new rules enforced and
 *  `role` (the database's reader) still sound and kept out of cloze_items. */
export async function migrateAndCheck0006(query, fresh, role) {
  const before = await oldContents(query);
  assert.equal(await bankReaderProblem(query, role), null, "sound at 0005");
  const { applied } = await applyMigrations(query, migrationsThrough0006());
  assert.equal(applied.length, 1);
  assert.equal((await migrationState(query, migrationsThrough0006())).status, "current");
  assert.deepEqual(await oldContents(query), before);
  assert.deepEqual(await query(`select * from cloze_items`), []);
  assert.deepEqual(await catalog(query), await catalog(fresh));
  assert.equal(await bankReaderProblem(query, role), null, "sound at 0006");
  for (const t of ["cloze_items", "cloze_calls"]) {
    assert.deepEqual(await query(`select has_table_privilege($1, $2, 'select') as can, has_any_column_privilege($1, $2, 'select') as cols`, [role, t]), [{ can: false, cols: false }], t);
  }
  assert.deepEqual(await query(`select * from cloze_calls`), []);

  const cloze = `insert into cloze_items (phrase_id, learner_id, language_profile_id, phrase_key, origin, example_id, sentence, blank_start, blank_end) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
  // An example's item, once per key; a generated one, and its "nothing usable" tombstone.
  await query(cloze, [P, L, LP, "k1", "example", E, SENTENCE, 11, 20]);
  await assert.rejects(query(cloze, [P, L, LP, "k1", "example", E, SENTENCE, 11, 20]), /cloze_items_example_once/);
  await query(cloze, [P, L, LP, "k2", "example", E, SENTENCE, 11, 20]);
  await query(cloze, [P, L, LP, "k1", "generated", null, "No olvide la vuelta en la mesa.", 10, 19]);
  await assert.rejects(query(cloze, [P, L, LP, "k1", "generated", null, "No olvide la vuelta en la mesa.", 10, 19]), /cloze_items_generated_once/);
  await query(cloze, [P, L, LP, "k1", "generated", null, null, null, null]);
  // One mark per phrase and key.
  await assert.rejects(query(cloze, [P, L, LP, "k1", "generated", null, null, null, null]), /cloze_items_tried_once/);
  // The rules: no blank without a sentence, no sentence-less example, an example's link exactly when it is one.
  await assert.rejects(query(cloze, [P, L, LP, "k3", "generated", null, "Algo.", null, null]), /cloze_items_sentence/);
  await assert.rejects(query(cloze, [P, L, LP, "k3", "example", E, null, null, null]), /cloze_items_sentence/);
  await assert.rejects(query(cloze, [P, L, LP, "k3", "example", null, SENTENCE, 11, 20]), /cloze_items_sentence/);
  await assert.rejects(query(cloze, [P, L, LP, "k3", "generated", E, SENTENCE, 11, 20]), /cloze_items_sentence/);
  await assert.rejects(query(`insert into cloze_items (phrase_id, learner_id, language_profile_id, origin, sentence, blank_start, blank_end) values ($1, $2, $3, 'generated', 'x y', 0, 1)`, [P, L, LP]), /phrase_key/);
  // The example must be this phrase's.
  const other = (await query(`insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source) values ($1, $2, 'es-MX', 'la cuenta', 'la cuenta', 'the bill', 'manual') returning id`, [L, LP]))[0].id;
  await assert.rejects(query(cloze, [other, L, LP, "k9", "example", E, SENTENCE, 11, 20]), /cloze_items_example_fk/);
  // Dropping the example drops its items, not the generated ones.
  await query(`delete from phrase_examples where id = $1`, [E]);
  assert.deepEqual((await query(`select origin, sentence is null as tomb from cloze_items order by 1, 2`)).map((r) => [r.origin, r.tomb]), [["generated", false], ["generated", true]]);

  // The call ledger: its counts checked, owned by a language profile of
  // its learner's, kept when the phrases go, gone with the profile.
  const call = `insert into cloze_calls (learner_id, language_profile_id, phrases, kept) values ($1, $2, $3, $4)`;
  await query(call, [L, LP, 10, null]);
  await query(call, [L, LP, 3, 0]);
  await assert.rejects(query(call, [L, LP, 0, null]), /cloze_calls_counts/);
  await assert.rejects(query(call, [L, LP, 1, -1]), /cloze_calls_counts/);
  await assert.rejects(query(call, [U, LP, 1, null]), /cloze_calls_profile_fk/);
  await query(`delete from phrases where learner_id = $1`, [L]);
  assert.deepEqual(await query(`select count(*)::int as n from cloze_items`), [{ n: 0 }]);
  assert.deepEqual(await query(`select count(*)::int as n from cloze_calls`), [{ n: 2 }]);
  await query(`delete from language_profiles where id = $1`, [LP]);
  assert.deepEqual(await query(`select count(*)::int as n from cloze_calls`), [{ n: 0 }]);
}
