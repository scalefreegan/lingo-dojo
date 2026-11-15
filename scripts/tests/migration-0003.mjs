// Migration 0003 (the phrase bank moves under language profiles) against a
// database that already has data: built at 0002, filled the way rows could
// be written before 0003 (a bank keyed by learner and `lang`, with one
// phrase met in two variants, which the new per-profile identity makes one
// row), then migrated. Shared by the PGlite test (db-migration-0003.test.mjs)
// and the real-Postgres one (migration-0003.pg.test.mjs, PostgreSQL 17 under
// LINGO_TEST_PG_URL). Not a test itself (the npm glob is *.test.mjs). Every
// name here is made up.

import assert from "node:assert/strict";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";

/** The migrations up to and including 0002. */
export function migrationsBefore0003() {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes('CREATE TABLE "language_profiles"')));
  assert.ok(i >= 0, "0002 is on disk");
  return disk.slice(0, i + 1);
}

/** The migrations up to and including 0003. */
export function migrationsThrough0003() {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes('CREATE TEMPORARY TABLE "phrase_merge"')));
  assert.ok(i >= 0, "0003 is on disk");
  return disk.slice(0, i + 1);
}

const U = { robin: "00000000-0000-4000-8000-000000000001", lee: "00000000-0000-4000-8000-000000000002" };
const L = { sam: "00000000-0000-4000-8000-0000000000a1", ana: "00000000-0000-4000-8000-0000000000b1" };
/** Sam's Spanish (the oldest: what the bank was in) and German (added later). */
const LP = {
  samEs: "00000000-0000-4000-8000-0000000000e1",
  samDe: "00000000-0000-4000-8000-0000000000e2",
  ana: "00000000-0000-4000-8000-0000000000e3",
};
const C = { sam: "00000000-0000-4000-8000-0000000000d1", samDe: "00000000-0000-4000-8000-0000000000d2" };
const PH = {
  keep: "00000000-0000-4000-8000-0000000000f1", // ¿A cómo? (es-MX), the older
  dupe: "00000000-0000-4000-8000-0000000000f2", // a cómo (es-ES): merged into keep
  hola: "00000000-0000-4000-8000-0000000000f3",
  taxi: "00000000-0000-4000-8000-0000000000f4", // pending, es-MX
  taxi2: "00000000-0000-4000-8000-0000000000f5", // pending, es-ES: merged into taxi
  ana: "00000000-0000-4000-8000-0000000000f6",
};
const CARD = {
  keepRecognize: "00000000-0000-4000-8000-000000000101",
  dupeRecognize: "00000000-0000-4000-8000-000000000102",
  dupeProduce: "00000000-0000-4000-8000-000000000103",
  hola: "00000000-0000-4000-8000-000000000104",
  ana: "00000000-0000-4000-8000-000000000105",
};

/** Fill a database at 0002: two accounts, a learner with two languages,
 *  conversations and turns, and a bank (phrases, examples, cards, reviews,
 *  a cloze item) keyed by learner and lang. */
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
  const [turn] = await query(`select id from turns where conversation_id = $1`, [C.sam]);
  await query(
    `insert into phrases (id, learner_id, lang, text, norm, meaning, meaning_norm, source, alternates, starred, first_seen_at, last_seen_at, seen_count, last_practiced_at, created_at) values
       ($1, $7, 'es-MX', '¿A cómo?', 'a cómo', 'how much?', null, 'gloss', '["a como"]', false, '2026-10-02T09:00:00Z', '2026-10-03T09:00:00Z', 2, null, '2026-10-02T09:00:00Z'),
       ($2, $7, 'es-ES', 'a cómo', 'a cómo', null, null, 'manual', '["¿a cómo?", "a como"]', true, '2026-10-01T09:00:00Z', '2026-10-09T09:00:00Z', 1, '2026-10-08T09:00:00Z', '2026-10-04T09:00:00Z'),
       ($3, $7, 'es-MX', 'hola', 'hola', 'hello', null, 'gloss', '[]', false, null, null, 0, null, '2026-10-02T09:00:00Z'),
       ($4, $7, 'es-MX', null, null, 'taxi', 'taxi', 'scenario', '[]', false, null, null, 0, null, '2026-10-02T09:00:00Z'),
       ($5, $7, 'es-ES', null, null, 'Taxi', 'taxi', 'scenario', '[]', true, null, null, 0, null, '2026-10-06T09:00:00Z'),
       ($6, $8, 'fr-FR', 'bonjour', 'bonjour', 'hello', null, 'gloss', '[]', false, null, null, 1, null, '2026-10-06T09:00:00Z')`,
    [PH.keep, PH.dupe, PH.hola, PH.taxi, PH.taxi2, PH.ana, L.sam, L.ana],
  );
  await query(
    `insert into phrase_examples (phrase_id, learner_id, conversation_id, turn_id, sentence) values
       ($1, $3, $4, $5, '¿A cómo el kilo?'), ($2, $3, null, null, 'Y esto, ¿a cómo?')`,
    [PH.keep, PH.dupe, L.sam, C.sam, turn.id],
  );
  await query(`insert into cloze_items (phrase_id, learner_id, sentence, blank_start, blank_end, origin) values ($1, $2, 'Y esto, ¿a cómo?', 9, 15, 'example')`, [PH.dupe, L.sam]);
  await query(
    `insert into cards (id, phrase_id, learner_id, skill, reps, stability, state) values
       ($1, $6, $9, 'recognize', 1, 1.5, 1), ($2, $7, $9, 'recognize', 3, 9, 2), ($3, $7, $9, 'produce', 2, 4, 2),
       ($4, $8, $9, 'recognize', 0, 0, 0), ($5, $10, $11, 'recognize', 0, 0, 0)`,
    [CARD.keepRecognize, CARD.dupeRecognize, CARD.dupeProduce, CARD.hola, CARD.ana, PH.keep, PH.dupe, PH.hola, L.sam, PH.ana, L.ana],
  );
  await query(
    `insert into reviews (card_id, learner_id, mode, rating, conversation_id, card_before) values
       ($1, $4, 'session', 3, $5, '{"state":1}'),
       ($2, $4, 'session', 1, $5, '{"state":2}'),
       ($2, $4, 'flashcard', 3, null, '{"state":2}'),
       ($3, $4, 'session', 3, $5, '{"state":2}')`,
    [CARD.keepRecognize, CARD.dupeRecognize, CARD.dupeProduce, L.sam, C.sam],
  );
}

const SAME = ["users", "learners", "language_profiles", "conversations", "turns", "packs", "pack_folders", "pack_revisions", "auth_sessions"];

async function contents(query) {
  const out = {};
  for (const t of SAME) out[t] = (await query(`select to_jsonb(x) as j from "${t}" x`)).map((r) => JSON.stringify(r.j)).sort();
  return out;
}

const fails = async (query, text, params, code) => {
  await assert.rejects(query(text, params), (e) => {
    assert.equal(e?.code ?? e?.cause?.code, code, String(e?.message));
    return true;
  });
};

/** Apply 0003 and check every bank row: under the learner's oldest
 *  profile, the two-variant duplicates merged as hand-edits.mjs says,
 *  nothing else changed, and the new keys hold. */
export async function migrateAndCheck0003(query) {
  const before = await contents(query);
  const { applied } = await applyMigrations(query, migrationsThrough0003());
  assert.equal(applied.length, 1, "only 0003 was missing");
  assert.equal((await migrationState(query, migrationsThrough0003())).status, "current");
  assert.deepEqual(await contents(query), before, "nothing outside the bank changed");

  // Every bank row is under its learner's oldest profile (Sam's Spanish, not
  // the newer German), and every child under its parent's.
  const phrases = await query(`select * from phrases order by created_at, id`);
  for (const p of phrases) assert.equal(p.language_profile_id, p.learner_id === L.sam ? LP.samEs : LP.ana, `phrase ${p.id}`);
  for (const t of ["phrase_examples", "cards", "cloze_items"]) {
    const bad = await query(`select x.id from "${t}" x join phrases p on p.id = x.phrase_id where x.language_profile_id is distinct from p.language_profile_id`);
    assert.deepEqual(bad, [], `${t} under its phrase's profile`);
  }
  assert.deepEqual(await query(`select r.id from reviews r join cards c on c.id = r.card_id where r.language_profile_id is distinct from c.language_profile_id`), []);

  // The duplicates are one row each, the older kept, knowing what both did.
  assert.deepEqual(phrases.map((p) => p.id).sort(), [PH.keep, PH.hola, PH.taxi, PH.ana].sort());
  const keep = phrases.find((p) => p.id === PH.keep);
  assert.equal(keep.text, "¿A cómo?", "the kept row's own text");
  assert.equal(keep.lang, "es-MX");
  assert.equal(keep.seen_count, 3);
  assert.equal(new Date(keep.first_seen_at).toISOString(), "2026-10-01T09:00:00.000Z", "the earliest first sighting");
  assert.equal(new Date(keep.last_seen_at).toISOString(), "2026-10-09T09:00:00.000Z", "the latest sighting");
  assert.equal(new Date(keep.last_practiced_at).toISOString(), "2026-10-08T09:00:00.000Z");
  assert.equal(keep.starred, true, "starred if either was");
  assert.equal(keep.meaning, "how much?");
  assert.deepEqual([...keep.alternates].sort(), ["a como", "¿a cómo?"].sort(), "alternates united");
  const taxi = phrases.find((p) => p.id === PH.taxi);
  assert.equal(taxi.text, null, "still pending");
  assert.equal(taxi.starred, true);

  const examples = await query(`select phrase_id, conversation_id, turn_id from phrase_examples order by sentence`);
  assert.equal(examples.length, 2);
  assert.ok(examples.every((e) => e.phrase_id === PH.keep), "examples follow the kept phrase");
  assert.equal(examples.filter((e) => e.conversation_id === C.sam && e.turn_id).length, 1, "provenance kept");
  assert.deepEqual((await query(`select phrase_id from cloze_items`)).map((r) => r.phrase_id), [PH.keep]);

  // Per skill one card: the kept phrase's own recognize card (the other
  // phrase's, though it had more reps, is merged into it) and the other's
  // produce card, moved over.
  const cards = await query(`select id, phrase_id, skill from cards order by skill, id`);
  assert.deepEqual(
    cards.filter((c) => c.phrase_id === PH.keep).map((c) => [c.skill, c.id]),
    [["produce", CARD.dupeProduce], ["recognize", CARD.keepRecognize]],
  );
  assert.equal(cards.length, 4);
  // Reviews: the merged card's flashcard review moves to the survivor; its
  // session review in a conversation the survivor already has one for is
  // the one row dropped.
  const reviews = await query(`select card_id, mode, rating from reviews order by card_id, mode`);
  assert.deepEqual(
    reviews.map((r) => [r.card_id, r.mode, r.rating]),
    [
      [CARD.keepRecognize, "flashcard", 3],
      [CARD.keepRecognize, "session", 3],
      [CARD.dupeProduce, "session", 3],
    ],
  );
  assert.equal((await query(`select to_regclass('phrase_merge')::text as t`))[0].t, null, "the merge table is gone");

  // The new keys: one row per target form per profile; another of Sam's
  // languages may have the same one; a child can't sit under another profile
  // than its parent, nor a phrase under another learner's profile.
  await fails(query, `insert into phrases (learner_id, language_profile_id, lang, text, norm, source) values ($1, $2, 'es-AR', 'A cómo', 'a cómo', 'gloss')`, [L.sam, LP.samEs], "23505");
  await query(`insert into phrases (learner_id, language_profile_id, lang, text, norm, source) values ($1, $2, 'de-DE', 'a cómo', 'a cómo', 'gloss')`, [L.sam, LP.samDe]);
  await fails(query, `insert into phrases (learner_id, language_profile_id, lang, meaning, meaning_norm, source) values ($1, $2, 'es-MX', 'TAXI', 'taxi', 'scenario')`, [L.sam, LP.samEs], "23505");
  await fails(query, `insert into cards (phrase_id, learner_id, language_profile_id, skill) values ($1, $2, $3, 'listen')`, [PH.keep, L.sam, LP.samDe], "23503");
  await fails(query, `insert into phrases (learner_id, language_profile_id, lang, text, norm, source) values ($1, $2, 'fr-FR', 'x', 'x', 'manual')`, [L.sam, LP.ana], "23503");
  await fails(query, `insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) values ($1, $2, $3, 'flashcard', 3, '{}')`, [CARD.hola, L.sam, LP.samDe], "23503");
}
