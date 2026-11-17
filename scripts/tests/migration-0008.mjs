// Migration 0008 (revisit: conversations.scene_key and
// previous_conversation_id, the recent_digests table) against a database at
// 0007 with sessions in it: a library scene, a random scene that drew one,
// two quick scenes whose text differs only in case and spacing, and one
// with no scene. Every row keeps every column it had; each gets the scene
// key scripts/revisit.mjs sceneKey gives its pack (so the two quick ones
// share one); none has an earlier attempt; the schema is a fresh build's.
// Shared by the PGlite test (db-migration-0008.test.mjs) and the
// real-Postgres one (migration-0008.pg.test.mjs). Not a test itself.
// Every name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { sceneKey } from "../revisit.mjs";
import { catalog } from "./migration-0003.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

/** The migrations up to and including 0007. */
export const migrationsBefore0008 = () => upTo('ADD COLUMN "random_scene"', "0007");
/** Up to and including 0008. */
export const migrationsThrough0008 = () => upTo('CREATE TABLE "recent_digests"', "0008");

const U = "00000000-0000-4000-8000-000000000081";
const L = "00000000-0000-4000-8000-0000000000a8";
const LP = "00000000-0000-4000-8000-0000000000e8";
const C = (n) => `00000000-0000-4000-8000-0000000008c${n}`;

const PACKS = [
  [C(1), "market", { scenario: "market", quick_scenario: "" }],
  [C(2), "plaza", { scenario: "plaza", quick_scenario: "", random_scene: null, random_draw: { collections: [], pool: ["plaza", "market"], drawn: "plaza" } }],
  [C(3), null, { scenario: "", quick_scenario: "Ordering tacos at a stand" }],
  [C(4), null, { scenario: "", quick_scenario: "  ordering TACOS\n\tat a  stand " }],
  [C(5), null, { scenario: "", quick_scenario: "   " }],
];

/** A language profile with five ended sessions (see the header). */
export async function seedBefore0008(query) {
  await query(`insert into users (id, username, password_hash) values ($1, 'robin', 'scrypt$x')`, [U]);
  await query(`insert into learners (id, user_id, name, mode, native_language) values ($1, $2, 'Sam', 'adult', 'English')`, [L, U]);
  await query(`insert into language_profiles (id, learner_id, target_language, target_variant, level) values ($1, $2, 'Spanish', 'Mexican Spanish', 'A2')`, [LP, L]);
  for (const [id, scenario, snap] of PACKS) {
    await query(
      `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, scenario_id, title, mode, ended_at)
       values ($1, $2, $3, $4, $5, 'Session', 'adult', now())`,
      [id, L, LP, JSON.stringify({ title: "", created: "", units: [], overrides: {}, notes: "", ...snap }), scenario],
    );
  }
}

const rows = (query) => query(`select to_jsonb(c) - 'scene_key' - 'previous_conversation_id' as row, c.scene_key, c.previous_conversation_id from conversations c order by id`);

/** Migrate a seeded 0007 database to 0008 and check it against `fresh` (a
 *  database built from nothing through 0008). */
export async function migrateAndCheck0008(query, fresh) {
  const before = await query(`select to_jsonb(c) as row from conversations c order by id`);
  await applyMigrations(query, migrationsThrough0008());
  assert.equal((await migrationState(query, migrationsThrough0008())).status, "current");
  const after = await rows(query);
  assert.deepEqual(after.map((r) => r.row), before.map((r) => r.row), "every session keeps every column it had");
  assert.deepEqual(
    after.map((r) => r.scene_key),
    PACKS.map(([id, , snap]) => sceneKey(snap, id)),
    "each gets the scene key the app would give it",
  );
  assert.equal(after[2].scene_key, after[3].scene_key, "two quick scenes differing in case and spacing are one scene");
  assert.equal(after[4].scene_key, `c:${C(5)}`, "a blank quick scene is its own");
  assert.deepEqual(after.map((r) => r.previous_conversation_id), PACKS.map(() => null), "no old session built on another");
  assert.deepEqual(await query(`select * from recent_digests`), []);
  assert.deepEqual(await catalog(query), await catalog(fresh));
}
