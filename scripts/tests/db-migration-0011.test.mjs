// Migration 0011 (the kids word game's pictures, bead ld-8zu, docs/DATA.md
// §Kids word game) on PGlite, from a 0010 database with a phrase, its listen
// card and a review: it applies, the review keeps every column, a review of
// mode `picture` is taken (and an unknown mode still refused), the two new
// tables' checks hold, a phrase's delete takes its picture row, a profile's
// delete its ledger, and the schema matches a fresh build. Two CREATE
// TABLEs, foreign keys, an index and a CHECK swapped: nothing PostgreSQL 18
// only. Every name here is made up.
//   node --test scripts/tests/db-migration-0011.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";
import { migrationsBefore0008, seedBefore0008 } from "./migration-0008.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { query: async (text, params) => (await pg.query(text, params)).rows };
};

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};
const through0010 = () => upTo('ADD COLUMN "translation"', "0010");
const through0011 = () => upTo('CREATE TABLE "phrase_pictures"', "0011");

test("0011 on a 0010 database: reviews untouched and `picture` taken, the picture tables' checks, cascades; schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0008());
  await seedBefore0008(query);
  await applyMigrations(query, through0010());
  const [lp] = await query(`select id, learner_id from language_profiles`);
  const [ph] = await query(
    `insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source) values ($1, $2, 'de-DE', 'der Hund', 'der hund', 'dog', 'manual') returning id`,
    [lp.learner_id, lp.id],
  );
  const [card] = await query(`insert into cards (phrase_id, learner_id, language_profile_id, skill) values ($1, $2, $3, 'listen') returning id`, [ph.id, lp.learner_id, lp.id]);
  await query(`insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) values ($1, $2, $3, 'listening', 3, '{}')`, [card.id, lp.learner_id, lp.id]);
  const before = await query(`select to_jsonb(r) as row from reviews r order by id`);

  await applyMigrations(query, through0011());
  assert.equal((await migrationState(query, through0011())).status, "current");
  assert.deepEqual(await query(`select to_jsonb(r) as row from reviews r order by id`), before);

  const review = (mode) => query(`insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) values ($1, $2, $3, $4, 1, '{}')`, [card.id, lp.learner_id, lp.id, mode]);
  await review("picture");
  await assert.rejects(review("tapping"), /reviews_mode/);

  const pic = (cols, vals, params = []) =>
    query(`insert into phrase_pictures (phrase_id, learner_id, language_profile_id, phrase_key${cols}) values ($1, $2, $3, 'k1'${vals}) returning id`, [ph.id, lp.learner_id, lp.id, ...params]);
  await assert.rejects(pic(", status, description", ", 'ready', 'a dog'"), /phrase_pictures_file/, "ready needs a file");
  await assert.rejects(pic(", status, description", ", 'pending', null"), /phrase_pictures_description/, "pending needs something to draw");
  await assert.rejects(pic(", status, description, file, content_type", ", 'ready', 'a dog', 'nope', 'image/png'"), /phrase_pictures_file/, "a file is 64 hex");
  await assert.rejects(pic(", status, description, file, content_type", ", 'ready', 'a dog', $4, 'image/gif'", ["a".repeat(64)]), /phrase_pictures_type/);
  await pic(", status, description, file, content_type", ", 'ready', 'a dog', $4, 'image/webp'", ["a".repeat(64)]);
  await assert.rejects(pic(", status", ", 'none'"), /phrase_pictures_profile_phrase/, "one row per phrase");
  await assert.rejects(
    query(`insert into picture_calls (learner_id, language_profile_id, kind, words) values ($1, $2, 'video', 1)`, [lp.learner_id, lp.id]),
    /picture_calls_kind/,
  );
  await query(`insert into picture_calls (learner_id, language_profile_id, kind, words) values ($1, $2, 'image', 1)`, [lp.learner_id, lp.id]);

  await query(`delete from phrases where id = $1`, [ph.id]);
  assert.equal((await query(`select count(*)::int as n from phrase_pictures`))[0].n, 0, "the picture row goes with its phrase");
  assert.equal((await query(`select count(*)::int as n from picture_calls`))[0].n, 1, "the ledger stays: a paid call counts");
  await query(`delete from language_profiles where id = $1`, [lp.id]);
  assert.equal((await query(`select count(*)::int as n from picture_calls`))[0].n, 0, "and goes with its language profile");

  const built = await fresh(t);
  await applyMigrations(built.query, through0011());
  assert.deepEqual(await catalog(query), await catalog(built.query));
});
