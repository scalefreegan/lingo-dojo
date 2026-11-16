// Cloze items against an edit on a real Postgres (scripts/db/cloze.ts
// clozeStates): a queue load that read a phrase before an edit must not
// delete the rows made for the phrase as it is now (a flag among them),
// whether it runs after the edit or at the same time as loads that read it
// fresh. The stale-key delete is conditional on the phrase still having the
// words and meaning the request read. Runs only when LINGO_TEST_PG_URL
// names a Postgres (pg-scratch.mjs: a throwaway database, dropped after);
// skipped otherwise. Every name here is made up.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/cloze.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { clozeKey, findBlank } from "../cloze.mjs";
import { createLearner, createUser } from "../db/accounts.ts";
import { clozeStates, flagClozeItem, storeGenerated } from "../db/cloze.ts";
import { applyMigrations } from "../db/migrations.mjs";
import { addPhrase, updatePhrase } from "../db/phrases.ts";
import * as schema from "../db/schema.ts";
import { ADULT } from "./http-session.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const OPTS = { locale: "es-MX", level: "A2" };
const ROUNDS = 10;

async function withProfile(t, fn) {
  const scratch = await scratchDatabase(url, "cloze");
  const pool = new pg.Pool({ connectionString: scratch.url, max: 8 });
  t.after(async () => {
    await pool.end();
    await scratch.drop();
  });
  await applyMigrations(scratch.query);
  const db = drizzle(pool, { schema });
  const user = await createUser(db, { username: "editor", passwordHash: "x" });
  const learner = await createLearner(db, user.id, ADULT);
  const [{ id }] = (await pool.query("select id from language_profiles where learner_id = $1", [learner.id])).rows;
  await fn(pool, db, { id, learnerId: learner.id });
}

/** A generated sentence for `phrase` as it is, kept and then flagged. */
async function flaggedSentence(db, profile, phrase, sentence) {
  const b = findBlank(sentence, phrase.text, "es-MX");
  await storeGenerated(db, profile, [{ phraseId: phrase.id, phraseKey: clozeKey(phrase), sentences: [{ sentence, start: b.start, end: b.end }] }]);
  const [row] = (await db.query.clozeItems.findMany({ where: (c, { eq }) => eq(c.phraseId, phrase.id) })).filter((r) => r.sentence === sentence);
  await flagClozeItem(db, profile, row.id, new Date());
  return row.id;
}

test("a load holding a copy from before an edit keeps the edited phrase's rows, its flag included; a fresh load clears the old key's", { skip }, async (t) => {
  await withProfile(t, async (pool, db, profile) => {
    for (let round = 0; round < ROUNDS; round++) {
      const { phrase: before } = await addPhrase(db, profile, "es-MX", { text: `la vuelta${round}`, meaning: "the change" });
      // A sentence for the old words (a row of the old key).
      const b = findBlank(`Aquí tiene la vuelta${round}, señora.`, before.text, "es-MX");
      await storeGenerated(db, profile, [{ phraseId: before.id, phraseKey: clozeKey(before), sentences: [{ sentence: `Aquí tiene la vuelta${round}, señora.`, start: b.start, end: b.end }] }]);
      // The edit, then a flagged sentence for the new words.
      await updatePhrase(db, profile, before.id, { text: `el cambio${round}` });
      const after = { ...before, text: `el cambio${round}` };
      const flagged = await flaggedSentence(db, profile, after, `Cuente bien el cambio${round}, por favor.`);
      // Loads at once: stale copies (read before the edit) and fresh ones.
      const loads = Array.from({ length: 6 }, (_, i) => clozeStates(db, profile, [i % 2 ? before : after], OPTS));
      const out = await Promise.allSettled(loads);
      assert.deepEqual(out.filter((o) => o.status === "rejected").map((o) => String(o.reason)), [], `round ${round}`);
      const rows = (await pool.query("select id, phrase_key, flagged_at is not null as flagged from cloze_items where phrase_id = $1", [before.id])).rows;
      const mine = rows.find((r) => r.id === flagged);
      assert.ok(mine, `round ${round}: the new key's flagged row survived`);
      assert.deepEqual([mine.phrase_key, mine.flagged], [clozeKey(after), true]);
      // The old key's sentence is gone (a fresh load deleted it), and stays gone.
      assert.equal(rows.filter((r) => r.phrase_key === clozeKey(before)).length, 0, `round ${round}`);
      // A stale load alone afterwards deletes nothing of the new key.
      await clozeStates(db, profile, [before], OPTS);
      assert.equal((await pool.query("select count(*)::int as n from cloze_items where id = $1", [flagged])).rows[0].n, 1);
    }
  });
});
