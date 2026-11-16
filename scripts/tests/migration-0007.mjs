// Migration 0007 (a pack's random scene: packs.random_scene, nullable jsonb)
// against a database at 0006 with packs in it: a library pack, a quick
// scene in a folder, a deleted one and their revisions. Every row stays as
// it was, the new column is null on each (none of them is a random scene),
// the packs read back through the pack layer exactly as before plus
// `random_scene: null`, and the schema is a fresh build's.
// Shared by the PGlite test (db-migration-0007.test.mjs) and the
// real-Postgres one (migration-0007.pg.test.mjs). Not a test itself.
// Every name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

/** The migrations up to and including 0006. */
export const migrationsBefore0007 = () => upTo('ADD COLUMN "phrase_key"', "0006");
/** Up to and including 0007. */
export const migrationsThrough0007 = () => upTo('ADD COLUMN "random_scene"', "0007");

const U = "00000000-0000-4000-8000-000000000071";
const L = "00000000-0000-4000-8000-0000000000a7";
const LP = "00000000-0000-4000-8000-0000000000e7";
const P1 = "00000000-0000-4000-8000-0000000000c7";
const P2 = "00000000-0000-4000-8000-0000000000c8";
const P3 = "00000000-0000-4000-8000-0000000000c9";

/** A language profile with three packs (one deleted, one in a folder) and a revision each. */
export async function seedBefore0007(query) {
  await query(`insert into users (id, username, password_hash) values ($1, 'robin', 'scrypt$x')`, [U]);
  await query(`insert into learners (id, user_id, name, mode, native_language) values ($1, $2, 'Sam', 'adult', 'English')`, [L, U]);
  await query(`insert into language_profiles (id, learner_id, target_language, target_variant, level) values ($1, $2, 'Spanish', 'Mexican Spanish', 'A2')`, [LP, L]);
  await query(`insert into pack_folders (learner_id, language_profile_id, name) values ($1, $2, 'trips')`, [L, LP]);
  const pack = (id, folder, slug, title, scenario, quick, deleted) =>
    query(
      `insert into packs (id, learner_id, language_profile_id, folder, slug, title, created, scenario, quick_scenario, units, overrides, notes, deleted_at)
       values ($1, $2, $3, $4, $5, $6, '2026-10-19T09:30:00-06:00', $7, $8, '["intro-native","correct-gently"]', '{"level":"B1","location":"Lyon","minutes":10}', 'Numbers.', ${deleted ? "now()" : "null"})`,
      [id, L, LP, folder, slug, title, scenario, quick],
    );
  await pack(P1, "", "2026-10-19-market", "Market", "market", "", false);
  await pack(P2, "trips", "2026-10-20-tacos", "Tacos", "", "Tacos at 1 a.m.", false);
  await pack(P3, "", "2026-10-21-gone", "Gone", "plaza", "", true);
  for (const [id, action] of [[P1, "create"], [P2, "import"], [P3, "delete"]]) {
    await query(`insert into pack_revisions (pack_id, learner_id, language_profile_id, snapshot, action) values ($1, $2, $3, $4, $5)`, [
      id, L, LP, JSON.stringify({ id, title: "snapshot" }), action,
    ]);
  }
}

const packRows = (query) => query(`select to_jsonb(p) - 'random_scene' as row, p.random_scene from packs p order by id`);
const revisionRows = (query) => query(`select to_jsonb(r) as row from pack_revisions r order by seq`);

/**
 * Migrate a seeded 0006 database to 0007 and check it against `fresh` (a
 * database built from nothing through 0007). `readPacks`, when given,
 * reads the language's packs through the pack layer after the migration
 * (the PGlite test passes listPacks on a Drizzle handle).
 */
export async function migrateAndCheck0007(query, fresh, readPacks) {
  const packsBefore = await query(`select to_jsonb(p) as row from packs p order by id`);
  const revisionsBefore = await revisionRows(query);
  await applyMigrations(query, migrationsThrough0007());
  assert.equal((await migrationState(query, migrationsThrough0007())).status, "current");
  const after = await packRows(query);
  assert.deepEqual(
    after.map((r) => r.row),
    packsBefore.map((r) => r.row),
    "every pack row keeps every column it had",
  );
  assert.deepEqual(after.map((r) => r.random_scene), [null, null, null], "no old pack is a random scene");
  assert.deepEqual(await revisionRows(query), revisionsBefore, "revisions untouched");
  assert.deepEqual(await catalog(query), await catalog(fresh));
  if (readPacks) {
    const { packs } = await readPacks({ id: LP, learnerId: L });
    assert.deepEqual(
      packs.map((p) => [p.id, p.scenario, p.quick_scenario, p.random_scene, p.units, p.overrides, p.notes]),
      [
        ["2026-10-19-market", "market", "", null, ["intro-native", "correct-gently"], { level: "B1", location: "Lyon", minutes: 10 }, "Numbers."],
        ["trips/2026-10-20-tacos", "", "Tacos at 1 a.m.", null, ["intro-native", "correct-gently"], { level: "B1", location: "Lyon", minutes: 10 }, "Numbers."],
      ],
      "the live packs read back as they were, random_scene null",
    );
  }
}
