// Migration 0002 (language profiles) against a database that already has
// data: a database built at 0001, filled with rows the way the code before
// 0002 wrote them, then migrated. Shared by the PGlite test
// (db-migration-0002.test.mjs) and the real-Postgres one
// (migration-0002.pg.test.mjs, PostgreSQL 17 under LINGO_TEST_PG_URL). Not a
// test itself (the npm glob is *.test.mjs). Every name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";

export const BEFORE_TAG = "0001_conversation_languages_from_client";

/** The migrations up to and including 0001. */
export function migrationsBefore0002() {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes('ADD COLUMN "from_client"')));
  assert.ok(i >= 0, "0001 is on disk");
  return disk.slice(0, i + 1);
}

// Fixed ids, so a row's owner is checkable by name.
const U = { robin: "00000000-0000-4000-8000-000000000001", lee: "00000000-0000-4000-8000-000000000002" };
export const L = {
  sam: "00000000-0000-4000-8000-0000000000a1", // robin's adult learner, Spanish
  pip: "00000000-0000-4000-8000-0000000000a2", // robin's kids learner, German
  old: "00000000-0000-4000-8000-0000000000a3", // robin's archived learner
  ana: "00000000-0000-4000-8000-0000000000b1", // lee's learner, French
};
const P = {
  market: "00000000-0000-4000-8000-0000000000c1",
  gone: "00000000-0000-4000-8000-0000000000c2",
  pipPack: "00000000-0000-4000-8000-0000000000c3",
  anaPack: "00000000-0000-4000-8000-0000000000c4",
};
const C = { sam: "00000000-0000-4000-8000-0000000000d1", ana: "00000000-0000-4000-8000-0000000000d2" };

/** Fill a database at 0001 with what the code before 0002 wrote: accounts,
 *  learners with their languages on the row, sessions, packs (one deleted)
 *  with folders and revisions, conversations with turns, and phrase-bank
 *  rows that point at a conversation and a turn. */
export async function seedBefore0002(query) {
  await query(`insert into users (id, username, password_hash, is_admin) values ($1, 'robin', 'scrypt$x', true), ($2, 'lee', 'scrypt$x', false)`, [U.robin, U.lee]);
  await query(
    `insert into learners (id, user_id, name, mode, native_language, target_language, target_variant, level, goals, notes, created_at, archived_at) values
       ($1, $5, 'Sam', 'adult', 'English', 'Spanish', 'Mexican Spanish', 'A2', 'Order food.', 'Likes direct corrections.', '2026-10-01T09:00:00Z', null),
       ($2, $5, 'Pip', 'kids', 'English', 'German', 'Standard German (Germany)', 'First words', '', '', '2026-10-02T09:00:00Z', null),
       ($3, $5, 'Old', 'adult', 'English', 'Italian', '', 'B1', 'Opera.', '', '2026-10-03T09:00:00Z', '2026-10-04T09:00:00Z'),
       ($4, $6, 'Ana', 'adult', 'Spanish', 'French', '', 'B2', '', 'Prefers formal.', '2026-10-05T09:00:00Z', null)`,
    [L.sam, L.pip, L.old, L.ana, U.robin, U.lee],
  );
  await query(
    `insert into auth_sessions (id, user_id, learner_id, expires_at) values
       ('session-robin-sam', $1, $3, now() + interval '30 days'),
       ('session-robin-none', $1, null, now() + interval '30 days'),
       ('session-lee-ana', $2, $4, now() + interval '30 days')`,
    [U.robin, U.lee, L.sam, L.ana],
  );
  await query(
    `insert into packs (id, learner_id, folder, slug, title, created, units, overrides, deleted_at) values
       ($1, $5, 'oaxaca', '2026-10-19-market', 'Market', '2026-10-19T09:30:00-06:00', '["warm-up"]', '{"level":"B1"}', null),
       ($2, $5, '', '2026-10-20-gone', 'Gone', '2026-10-20T09:30:00-06:00', '[]', '{}', now()),
       ($3, $6, '', '2026-10-21-zoo', 'Zoo', '2026-10-21T09:30:00+02:00', '[]', '{}', null),
       ($4, $7, '', '2026-10-19-market', 'Marché', '2026-10-19T09:30:00+02:00', '[]', '{}', null)`,
    [P.market, P.gone, P.pipPack, P.anaPack, L.sam, L.pip, L.ana],
  );
  await query(`insert into pack_folders (learner_id, name) values ($1, 'oaxaca'), ($1, 'empty'), ($2, 'animals')`, [L.sam, L.pip]);
  await query(
    `insert into pack_revisions (pack_id, learner_id, snapshot, action) values
       ($1, $5, '{"id":"oaxaca/2026-10-19-market"}', 'import'), ($1, $5, '{"id":"oaxaca/2026-10-19-market"}', 'update'),
       ($2, $5, '{"id":"2026-10-20-gone"}', 'create'), ($2, $5, '{"id":"2026-10-20-gone"}', 'delete'),
       ($3, $6, '{"id":"2026-10-21-zoo"}', 'create'), ($4, $7, '{"id":"2026-10-19-market"}', 'create')`,
    [P.market, P.gone, P.pipPack, P.anaPack, L.sam, L.pip, L.ana],
  );
  await query(
    `insert into conversations (id, learner_id, pack_snapshot, title, mode, native_language, target_language, target_variant, turn_count, ended_at) values
       ($1, $3, '{"title":"Market"}', 'Market', 'adult', 'English', 'Spanish', 'Mexican Spanish', 2, now()),
       ($2, $4, '{"title":"Marché"}', 'Marché', 'adult', 'Spanish', 'French', '', 2, null)`,
    [C.sam, C.ana, L.sam, L.ana],
  );
  await query(
    `insert into turns (conversation_id, learner_id, idx, role, text, lines, from_client) values
       ($1, $3, 0, 'learner', '¿A cómo?', null, false), ($1, $3, 1, 'master', null, '[{"speaker":"vendor","text":"A diez."}]', false),
       ($2, $4, 0, 'learner', 'Bonjour', null, false), ($2, $4, 1, 'master', null, '[{"speaker":"dojo_master","text":"Bonjour !"}]', true)`,
    [C.sam, C.ana, L.sam, L.ana],
  );
  // The phrase bank, untouched by 0002, with provenance into Sam's conversation.
  const [ph] = await query(`insert into phrases (learner_id, lang, text, norm, source) values ($1, 'es-MX', '¿A cómo?', 'a como', 'gloss') returning id`, [L.sam]);
  const [turn] = await query(`select id from turns where conversation_id = $1 and idx = 0`, [C.sam]);
  await query(`insert into phrase_examples (phrase_id, learner_id, conversation_id, turn_id, sentence) values ($1, $2, $3, $4, '¿A cómo?')`, [ph.id, L.sam, C.sam, turn.id]);
  const [card] = await query(`insert into cards (phrase_id, learner_id, skill) values ($1, $2, 'produce') returning id`, [ph.id, L.sam]);
  await query(`insert into reviews (card_id, learner_id, mode, rating, conversation_id, card_before) values ($1, $2, 'session', 3, $3, '{}')`, [card.id, L.sam, C.sam]);
}

const TABLES = ["users", "learners", "auth_sessions", "packs", "pack_folders", "pack_revisions", "conversations", "turns", "phrases", "phrase_examples", "cards", "reviews"];

/** Every row of every table, as JSON text, minus the columns 0002 adds or
 *  drops: what must come through the migration unchanged. */
export async function contents(query) {
  const out = {};
  for (const t of TABLES) {
    // Only learners lose columns (their languages move out); every other
    // table only gains language_profile_id.
    const minus = t === "learners" ? ["target_language", "target_variant", "level", "goals", "notes"] : ["language_profile_id"];
    const rows = await query(`select to_jsonb(x) ${minus.map((c) => `- '${c}'`).join(" ")} as j from "${t}" x`);
    out[t] = rows.map((r) => JSON.stringify(r.j)).sort();
  }
  return out;
}

/** Apply 0002 and check every row landed under the right profile, nothing
 *  was dropped, and the new keys hold. */
export async function migrateAndCheck(query) {
  const before = await contents(query);
  const learnerCols = (await query(`select column_name from information_schema.columns where table_name = 'learners'`)).map((r) => r.column_name);
  assert.ok(learnerCols.includes("target_language"), "at 0001 the learner holds its language");
  const { applied } = await applyMigrations(query);
  assert.equal(applied.length, 1, "only 0002 was missing");
  assert.equal((await migrationState(query)).status, "current");

  // Nothing lost or changed besides the moved columns.
  assert.deepEqual(await contents(query), before);

  // One profile per learner (archived ones too), from the learner's own columns.
  const profiles = await query(`select * from language_profiles order by created_at`);
  assert.equal(profiles.length, 4);
  const of = (learnerId) => profiles.filter((p) => p.learner_id === learnerId);
  for (const id of Object.values(L)) assert.equal(of(id).length, 1, `one profile for learner ${id}`);
  const sam = of(L.sam)[0];
  assert.deepEqual(
    { t: sam.target_language, v: sam.target_variant, l: sam.level, g: sam.goals, n: sam.notes },
    { t: "Spanish", v: "Mexican Spanish", l: "A2", g: "Order food.", n: "Likes direct corrections." },
  );
  assert.equal(of(L.pip)[0].level, "First words");
  assert.equal(of(L.old)[0].target_language, "Italian");
  assert.equal(of(L.old)[0].archived_at, null, "the archived learner's profile isn't archived itself");
  assert.equal(of(L.ana)[0].notes, "Prefers formal.");
  assert.ok(profiles.every((p) => p.last_used_at !== null), "each is its learner's last used");
  assert.equal(new Date(sam.created_at).toISOString(), "2026-10-01T09:00:00.000Z", "created with the learner");

  // Every row under its learner's profile.
  for (const t of ["packs", "pack_folders", "pack_revisions", "conversations", "turns"]) {
    const rows = await query(`select x.learner_id, x.language_profile_id, p.learner_id as profile_learner from "${t}" x left join language_profiles p on p.id = x.language_profile_id`);
    assert.ok(rows.length > 0, `${t} has rows`);
    for (const r of rows) assert.equal(r.profile_learner, r.learner_id, `${t}: under its own learner's profile`);
  }
  const count = async (t) => (await query(`select count(*)::int as n from "${t}"`))[0].n;
  assert.deepEqual(
    { packs: await count("packs"), folders: await count("pack_folders"), revisions: await count("pack_revisions"), conversations: await count("conversations"), turns: await count("turns") },
    { packs: 4, folders: 3, revisions: 6, conversations: 2, turns: 4 },
  );

  // Sessions: a learner's session practises its one language; none stays none.
  const sessions = Object.fromEntries((await query(`select id, language_profile_id from auth_sessions`)).map((r) => [r.id, r.language_profile_id]));
  assert.deepEqual(sessions, { "session-robin-sam": sam.id, "session-robin-none": null, "session-lee-ana": of(L.ana)[0].id });

  // The moved columns are gone from learners; conversations keep their own.
  const after = (await query(`select column_name from information_schema.columns where table_name = 'learners'`)).map((r) => r.column_name).sort();
  assert.deepEqual(after, ["archived_at", "created_at", "id", "mode", "name", "native_language", "user_id"]);

  // The new keys hold on the migrated rows: a pack can't move under another
  // learner's profile, a revision can't point at a pack in another profile,
  // and a second language may reuse a pack id.
  const fails = async (text, params, code) => {
    await assert.rejects(query(text, params), (e) => {
      assert.equal(e?.code ?? e?.cause?.code, code, String(e?.message));
      return true;
    });
  };
  await fails(`update packs set language_profile_id = $1 where id = $2`, [of(L.ana)[0].id, P.market], "23503");
  const [german] = await query(`insert into language_profiles (learner_id, target_language, level) values ($1, 'German', 'A1') returning id`, [L.sam]);
  await query(
    `insert into packs (learner_id, language_profile_id, folder, slug, title, created) values ($1, $2, 'oaxaca', '2026-10-19-market', 'Markt', '2026-10-19T09:30:00+02:00')`,
    [L.sam, german.id],
  );
  await fails(`insert into pack_revisions (pack_id, learner_id, language_profile_id, snapshot, action) values ($1, $2, $3, '{}', 'update')`, [P.market, L.sam, german.id], "23503");
  await fails(
    `insert into packs (learner_id, language_profile_id, folder, slug, title, created) values ($1, $2, 'oaxaca', '2026-10-19-market', 'Again', 'x')`,
    [L.sam, sam.id],
    "23505",
  );
  // A turn can't sit under another language than its conversation.
  await fails(
    `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, 9, 'learner', 'x')`,
    [C.sam, L.sam, german.id],
    "23503",
  );
  // The phrase bank's provenance into the conversation still holds.
  const [{ n }] = await query(`select count(*)::int as n from phrase_examples where conversation_id = $1 and turn_id is not null`, [C.sam]);
  assert.equal(n, 1);
}
