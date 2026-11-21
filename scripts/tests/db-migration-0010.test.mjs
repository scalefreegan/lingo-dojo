// Migration 0010 (a cloze item's translation, bead ld-r2x, docs/DATA.md
// §Practice modes) on PGlite, from a 0009 database with a phrase, one of its
// sentences and a "nothing usable" mark: it applies, both rows keep every
// column they had with no translation (no backfill: existing rows stay
// NULL), a new sentence takes one, a tried mark can't, and the schema
// matches a fresh build. A nullable ADD COLUMN and a CHECK, nothing
// PostgreSQL 18 only. Every name here is made up.
//   node --test scripts/tests/db-migration-0010.test.mjs

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
const through0009 = () => upTo('CREATE TABLE "hidden_scenes"', "0009");
const through0010 = () => upTo('ADD COLUMN "translation"', "0010");

test("0010 on a 0009 database: cloze items untouched with no translation, new ones take one, a tried mark can't; schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0008());
  await seedBefore0008(query);
  await applyMigrations(query, through0009());
  const [lp] = await query(`select id, learner_id from language_profiles`);
  const [ph] = await query(
    `insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source) values ($1, $2, 'es-MX', 'la cuenta', 'la cuenta', 'the bill', 'manual') returning id`,
    [lp.learner_id, lp.id],
  );
  const ins = (cols, vals) =>
    query(
      `insert into cloze_items (phrase_id, learner_id, language_profile_id, phrase_key, origin${cols}) values ($1, $2, $3, 'k1', 'generated'${vals}) returning id`,
      [ph.id, lp.learner_id, lp.id],
    );
  await ins(", sentence, blank_start, blank_end", ", '¿Me trae la cuenta, por favor?', 9, 18");
  await ins("", "");
  const before = await query(`select to_jsonb(c) as row from cloze_items c order by id`);

  await applyMigrations(query, through0010());
  assert.equal((await migrationState(query, through0010())).status, "current");
  const after = await query(`select to_jsonb(c) - 'translation' as row, c.translation from cloze_items c order by id`);
  assert.deepEqual(after.map((r) => r.row), before.map((r) => r.row), "every item keeps every column it had");
  assert.deepEqual(after.map((r) => r.translation), [null, null], "no backfill");

  await query(
    `insert into cloze_items (phrase_id, learner_id, language_profile_id, phrase_key, origin, sentence, blank_start, blank_end, translation) values ($1, $2, $3, 'k1', 'generated', 'Pedimos la cuenta al mesero ya.', 8, 17, 'We asked the waiter for the bill.')`,
    [ph.id, lp.learner_id, lp.id],
  );
  await assert.rejects(
    query(`update cloze_items set translation = 'nothing' where sentence is null`),
    /cloze_items_translation/,
    "a tried mark has no sentence to translate",
  );

  const built = await fresh(t);
  await applyMigrations(built.query, through0010());
  assert.deepEqual(await catalog(query), await catalog(built.query));
});
