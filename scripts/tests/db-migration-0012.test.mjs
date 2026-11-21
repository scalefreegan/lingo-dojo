// Migration 0012 (the word game's picture theme, stock pointers and Redraw
// all, bead ld-6k7, docs/DATA.md §Kids word game) on PGlite, from a 0011
// database with a ready picture: it applies, the picture keeps every column
// with no theme (drawn before themes), the new checks hold, and the schema
// matches a fresh build. Three ADD COLUMNs and three CHECKs: nothing
// PostgreSQL 18 only. Every name here is made up.
//   node --test scripts/tests/db-migration-0012.test.mjs

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
const through0011 = () => upTo('CREATE TABLE "phrase_pictures"', "0011");
const through0012 = () => upTo('ADD COLUMN "stock_id"', "0012");

test("0012 on a 0011 database: an existing picture keeps everything, with no theme; the new columns' checks; schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0008());
  await seedBefore0008(query);
  await applyMigrations(query, through0011());
  const [lp] = await query(`select id, learner_id from language_profiles`);
  const phrase = async (text) =>
    (await query(`insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source) values ($1, $2, 'de-DE', $3, $3, 'x', 'manual') returning id`, [lp.learner_id, lp.id, text]))[0].id;
  const dog = await phrase("hund");
  await query(
    `insert into phrase_pictures (phrase_id, learner_id, language_profile_id, phrase_key, status, description, file, content_type) values ($1, $2, $3, 'k1', 'ready', 'a dog', $4, 'image/webp')`,
    [dog, lp.learner_id, lp.id, "a".repeat(64)],
  );
  const before = (await query(`select to_jsonb(p) as row from phrase_pictures p`))[0].row;

  await applyMigrations(query, through0012());
  assert.equal((await migrationState(query, through0012())).status, "current");
  const after = (await query(`select to_jsonb(p) as row from phrase_pictures p`))[0].row;
  assert.deepEqual(after, { ...before, theme: null, stock_id: null, restyle: null }, "drawn before themes: no theme");

  const pic = async (cols, vals, params = []) => {
    const id = await phrase(`w${Math.random()}`);
    return query(`insert into phrase_pictures (phrase_id, learner_id, language_profile_id, phrase_key${cols}) values ($1, $2, $3, 'k1'${vals})`, [id, lp.learner_id, lp.id, ...params]);
  };
  const ready = ", status, description, file, content_type";
  const readyVals = ", 'ready', 'a dog', $4, 'image/jpeg'";
  const file = ["b".repeat(64)];
  await pic(`${ready}, theme, stock_id`, `${readyVals}, 'cream-outline-1', 'dog'`, file);
  await pic(`${ready}, theme, restyle`, `${readyVals}, 'cream-outline-1+openai', 'check'`, file);
  await assert.rejects(pic(`${ready}, theme`, `${readyVals}, 'Bad Theme'`, file), /phrase_pictures_theme/);
  await assert.rejects(pic(`${ready}, stock_id`, `${readyVals}, 'dog'`, file), /phrase_pictures_stock/, "a stock pointer names its theme");
  await assert.rejects(pic(`${ready}, theme, stock_id`, `${readyVals}, 'cream-outline-1', '../dog'`, file), /phrase_pictures_stock/);
  await assert.rejects(pic(", status, description, theme, stock_id", ", 'pending', 'a dog', 'cream-outline-1', 'dog'"), /phrase_pictures_stock/, "only a ready row points at stock");
  await assert.rejects(pic(", status, restyle", ", 'removed', 'draw'"), /phrase_pictures_restyle/, "only a ready row waits for a restyle");
  await assert.rejects(pic(`${ready}, restyle`, `${readyVals}, 'later'`, file), /phrase_pictures_restyle/);

  const built = await fresh(t);
  await applyMigrations(built.query, through0012());
  assert.deepEqual(await catalog(query), await catalog(built.query));
});
