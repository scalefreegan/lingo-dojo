// The database foundation (docs/DATA.md): the committed migrations, the
// constraints they create, the owned-row helper, and trigram search. Every
// test runs on its own in-process PGlite database (testdb.mjs), so nothing
// here needs a Postgres server or can touch the dev database.
//   node --test scripts/tests/db.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { freshDb } from "./testdb.mjs";
import { DEFAULT_DATABASE_URL, databaseName, databaseUrl, pendingMigrations, redact } from "../db/config.mjs";
import { migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { forLearner, forUser } from "../db/owned.ts";
import {
  cards, conversations, learners, packs, phraseExamples, phrases, reviews, turns, users,
} from "../db/schema.ts";

/** The Postgres SQLSTATE of a failed query (drizzle may wrap the driver's
 *  error, keeping it as `cause`). */
const sqlState = (e) => e?.code ?? e?.cause?.code;
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (e) => {
    assert.equal(sqlState(e), code, `expected SQLSTATE ${code}, got ${sqlState(e)}: ${e?.cause?.message ?? e?.message}`);
    return true;
  });
const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const CHECK = "23514";

/** A user with one learner per name; returns their ids. */
async function seed(db, username, ...names) {
  const [user] = await db.insert(users).values({ username, passwordHash: "scrypt$test" }).returning();
  const rows = await forUser(db, user.id).insert(
    learners,
    names.map((name) => ({ name, mode: "adult", targetVariant: "Mexican Spanish" })),
  );
  return { userId: user.id, learnerIds: rows.map((r) => r.id) };
}

/* ------------------------------- migrations ------------------------------- */

test("the committed migrations apply unchanged and leave the schema current", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((r) => r.tablename);
  assert.deepEqual(tables, [
    "agent_messages", "auth_sessions", "cards", "cloze_items", "conversations", "learners",
    "pack_folders", "pack_revisions", "packs", "phrase_examples", "phrases", "reviews",
    "turns", "user_settings", "users",
  ]);
  const ext = await query(`select extname from pg_extension where extname = 'pg_trgm'`);
  assert.equal(ext.length, 1, "pg_trgm is installed by the first migration");
  // The boot check's own read, on a migrated database.
  const state = await migrationState(query);
  assert.equal(state.pending, 0);
  assert.equal(state.total, migrationsOnDisk().length);
  assert.ok(state.total >= 1);
});

test("migrationState reports an unmigrated database as behind", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  await query(`drop schema drizzle cascade`);
  const state = await migrationState(query);
  assert.equal(state.latestApplied, null);
  assert.equal(state.pending, state.total);
});

test("pendingMigrations counts what drizzle's migrator would still apply", () => {
  const ms = [{ folderMillis: 10 }, { folderMillis: 20 }, { folderMillis: 30 }];
  assert.equal(pendingMigrations(ms, null).length, 3);
  assert.equal(pendingMigrations(ms, 20).length, 1);
  assert.equal(pendingMigrations(ms, "30").length, 0); // bigint arrives as text
});

/* ------------------------------- constraints ------------------------------ */

test("a phrase's identity is (learner, lang, norm)", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  const phrase = { lang: "es-MX", norm: "a como", text: "¿A cómo?", source: "gloss" };
  await forLearner(db, a).insert(phrases, phrase);
  await rejectsWith(forLearner(db, a).insert(phrases, { ...phrase, text: "a cómo" }), UNIQUE);
  // Another language, another learner, or an accent (DATA.md: papa ≠ papá)
  // are different phrases.
  await forLearner(db, a).insert(phrases, { ...phrase, lang: "es-ES" });
  await forLearner(db, b).insert(phrases, phrase);
  await forLearner(db, a).insert(phrases, { ...phrase, norm: "a cómo" });
  // The identity is what a gloss upserts on: a second sighting bumps the row.
  await db
    .insert(phrases)
    .values({ ...phrase, learnerId: a, seenCount: 1 })
    .onConflictDoUpdate({
      target: [phrases.learnerId, phrases.lang, phrases.norm],
      set: { seenCount: sql`${phrases.seenCount} + 1` },
    });
  const [row] = await forLearner(db, a).list(phrases, and(eq(phrases.lang, "es-MX"), eq(phrases.norm, "a como")));
  assert.equal(row.seenCount, 1);
  assert.equal((await forLearner(db, a).list(phrases)).length, 3);
});

test("deleting a learner cascades to everything they own", async (t) => {
  const { db, query, close } = await freshDb();
  t.after(close);
  const { userId, learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  for (const id of [a, b]) {
    const mine = forLearner(db, id);
    const [conv] = await mine.insert(conversations, { packSnapshot: {}, mode: "adult" });
    const [turn] = await mine.insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "hola" });
    const [ph] = await mine.insert(phrases, { lang: "es-MX", norm: "hola", text: "hola", source: "gloss" });
    await mine.insert(phraseExamples, { phraseId: ph.id, conversationId: conv.id, turnId: turn.id, sentence: "hola" });
    const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "recognize" });
    await mine.insert(reviews, { cardId: card.id, mode: "session", rating: 3, conversationId: conv.id });
    await mine.insert(packs, { slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" });
  }
  await forUser(db, userId).remove(learners, eq(learners.id, a));
  for (const table of ["conversations", "turns", "phrases", "phrase_examples", "cards", "reviews", "packs"]) {
    const rows = await query(`select learner_id from ${table}`);
    assert.deepEqual(rows.map((r) => r.learner_id), [b], `${table}: only the other learner's row is left`);
  }
  // And a user takes their learners with them.
  await db.delete(users).where(eq(users.id, userId));
  assert.equal((await query(`select count(*)::int as n from phrases`))[0].n, 0);
});

test("ending a conversation's life keeps the memory it fed", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a] } = await seed(db, "ana", "Ana");
  const mine = forLearner(db, a);
  const [conv] = await mine.insert(conversations, { packSnapshot: { title: "Market" }, mode: "adult" });
  const [turn] = await mine.insert(turns, { conversationId: conv.id, idx: 0, role: "master", lines: [] });
  const [ph] = await mine.insert(phrases, { lang: "es-MX", norm: "la vuelta", text: "la vuelta", source: "extraction" });
  const [ex] = await mine.insert(phraseExamples, { phraseId: ph.id, conversationId: conv.id, turnId: turn.id, sentence: "Aquí tiene la vuelta." });
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "produce" });
  const [rev] = await mine.insert(reviews, { cardId: card.id, mode: "session", rating: 1, conversationId: conv.id });

  await mine.remove(conversations, eq(conversations.id, conv.id));
  assert.equal((await mine.list(turns)).length, 0, "turns go with their conversation");
  const example = await mine.get(phraseExamples, eq(phraseExamples.id, ex.id));
  assert.equal(example.conversationId, null);
  assert.equal(example.turnId, null);
  const review = await mine.get(reviews, eq(reviews.id, rev.id));
  assert.equal(review.conversationId, null, "the review survives, unlinked");

  // A phrase takes its cards and their reviews with it.
  await mine.remove(phrases, eq(phrases.id, ph.id));
  assert.equal((await mine.list(cards)).length, 0);
  assert.equal((await mine.list(reviews)).length, 0);
});

test("a child row cannot belong to a different learner than its parent", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  const [conv] = await forLearner(db, a).insert(conversations, { packSnapshot: {}, mode: "adult" });
  const [ph] = await forLearner(db, a).insert(phrases, { lang: "es-MX", norm: "hola", source: "manual" });
  // Ben's scope stamps Ben's id; the composite key refuses Ana's parent.
  await rejectsWith(forLearner(db, b).insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "x" }), FOREIGN_KEY);
  await rejectsWith(forLearner(db, b).insert(cards, { phraseId: ph.id, skill: "listen" }), FOREIGN_KEY);
});

test("the other named constraints hold", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a] } = await seed(db, "ana", "Ana");
  const mine = forLearner(db, a);
  // Usernames are stored lowercased.
  await rejectsWith(db.insert(users).values({ username: "Ana2", passwordHash: "x" }), CHECK);
  await rejectsWith(db.insert(users).values({ username: "ana", passwordHash: "x" }), UNIQUE);
  // One card per phrase and skill.
  const [ph] = await mine.insert(phrases, { lang: "es-MX", norm: "hola", source: "manual" });
  await mine.insert(cards, { phraseId: ph.id, skill: "produce" });
  await rejectsWith(mine.insert(cards, { phraseId: ph.id, skill: "produce" }), UNIQUE);
  await rejectsWith(mine.insert(cards, { phraseId: ph.id, skill: "write" }), CHECK);
  // Turn positions are unique within a conversation.
  const [conv] = await mine.insert(conversations, { packSnapshot: {}, mode: "kids" });
  await mine.insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "a" });
  await rejectsWith(mine.insert(turns, { conversationId: conv.id, idx: 0, role: "master" }), UNIQUE);
  // A live pack's (folder, slug) is unique; a soft-deleted one frees it.
  const pack = { folder: "trips", slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" };
  const [first] = await mine.insert(packs, pack);
  await rejectsWith(mine.insert(packs, pack), UNIQUE);
  await mine.update(packs, { deletedAt: new Date() }, eq(packs.id, first.id));
  await mine.insert(packs, pack);
  // Ratings are FSRS's 1-4.
  const [card] = await mine.list(cards);
  await rejectsWith(mine.insert(reviews, { cardId: card.id, mode: "flashcard", rating: 5 }), CHECK);
});

test("a card holds every field of a ts-fsrs Card", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a] } = await seed(db, "ana", "Ana");
  const mine = forLearner(db, a);
  const [ph] = await mine.insert(phrases, { lang: "es-MX", norm: "hola", source: "manual" });
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "recognize" });
  // ts-fsrs 6 `Card` (snake_case there, camelCase in Drizzle).
  for (const k of ["due", "stability", "difficulty", "scheduledDays", "learningSteps", "reps", "lapses", "state", "lastReview"]) {
    assert.ok(k in card, `cards.${k}`);
  }
  assert.ok("stabilityFast" in card, "FSRS-7's extra stability");
  assert.equal(card.state, 0);
  assert.ok(card.due instanceof Date);
  const [moved] = await mine.update(cards, { scheduledDays: 4.78, stabilityFast: 3.14, state: 2, reps: 1, lastReview: new Date() }, eq(cards.id, card.id));
  assert.equal(moved.scheduledDays, 4.78, "fractional days survive");
});

/* ----------------------------- owned-row helper --------------------------- */

test("forLearner sees, changes and deletes only its own learner's rows", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLearner(db, a);
  const ben = forLearner(db, b);
  const rows = await ana.insert(phrases, [
    { lang: "es-MX", norm: "hola", text: "hola", source: "gloss" },
    { lang: "es-MX", norm: "adios", text: "adiós", source: "gloss" },
  ]);
  assert.ok(rows.every((r) => r.learnerId === a), "insert stamps the owner");
  const [bensHola] = await ben.insert(phrases, { lang: "es-MX", norm: "hola", text: "hola", source: "gloss" });

  assert.deepEqual((await ana.list(phrases, undefined, { orderBy: phrases.norm })).map((r) => r.norm), ["adios", "hola"]);
  assert.deepEqual((await ben.list(phrases)).map((r) => r.id), [bensHola.id]);
  // Even naming another learner's row by id finds nothing.
  assert.equal(await ana.get(phrases, eq(phrases.id, bensHola.id)), undefined);
  assert.deepEqual(await ana.update(phrases, { starred: true }, eq(phrases.id, bensHola.id)), []);
  assert.deepEqual(await ana.remove(phrases, eq(phrases.id, bensHola.id)), []);
  assert.equal((await ben.get(phrases, eq(phrases.id, bensHola.id))).starred, false);

  // update/remove act on the owner's matches only.
  const starred = await ana.update(phrases, { starred: true }, eq(phrases.norm, "hola"));
  assert.equal(starred.length, 1);
  assert.equal(starred[0].learnerId, a);
  assert.equal((await ana.remove(phrases, eq(phrases.norm, "adios"))).length, 1);
  assert.equal((await ben.list(phrases)).length, 1);

  // Ordering and limits pass through.
  assert.equal((await ana.list(phrases, undefined, { orderBy: [desc(phrases.createdAt)], limit: 0 })).length, 0);
  // The owner can't be moved, even by a caller that slipped past the types.
  await assert.rejects(ana.update(phrases, { learnerId: b }, eq(phrases.norm, "hola")), /cannot change learnerId/);
  // No owner, no scope.
  assert.throws(() => forLearner(db, ""), /need a learnerId/);
});

test("where() keeps the owner filter in hand-written queries", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLearner(db, a);
  const [ph] = await ana.insert(phrases, { lang: "es-MX", norm: "hola", text: "hola", source: "gloss" });
  await ana.insert(cards, [{ phraseId: ph.id, skill: "recognize" }, { phraseId: ph.id, skill: "produce" }]);
  const [bph] = await forLearner(db, b).insert(phrases, { lang: "es-MX", norm: "hola", text: "hola", source: "gloss" });
  await forLearner(db, b).insert(cards, { phraseId: bph.id, skill: "produce" });
  // A join and an aggregate: the bank's "cards per phrase".
  const rows = await db
    .select({ norm: phrases.norm, n: sql`count(${cards.id})::int` })
    .from(phrases)
    .innerJoin(cards, eq(cards.phraseId, phrases.id))
    .where(ana.where(phrases))
    .groupBy(phrases.norm);
  assert.deepEqual(rows, [{ norm: "hola", n: 2 }]);
});

test("forUser scopes account rows", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const one = await seed(db, "ana", "Ana", "Kiddo");
  const two = await seed(db, "ben", "Ben");
  assert.deepEqual((await forUser(db, one.userId).list(learners, undefined, { orderBy: learners.name })).map((r) => r.name), ["Ana", "Kiddo"]);
  assert.deepEqual((await forUser(db, two.userId).list(learners)).map((r) => r.name), ["Ben"]);
});

/* ------------------------------- trigram search --------------------------- */

test("pg_trgm word_similarity ranks the phrase bank (per-turn retrieval)", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLearner(db, a);
  await ana.insert(phrases, [
    { lang: "es-MX", norm: "a como", text: "¿A cómo?", meaning: "how much?", source: "gloss" },
    { lang: "es-MX", norm: "me lo envuelve", text: "¿Me lo envuelve?", meaning: "could you wrap it for me?", source: "extraction" },
    { lang: "es-MX", norm: "la vuelta", text: "la vuelta", meaning: "the change (coins back)", source: "gloss" },
    { lang: "ja-JP", norm: "いくらですか", text: "いくらですか", meaning: "how much is it?", source: "gloss" },
  ]);
  await forLearner(db, b).insert(phrases, { lang: "es-MX", norm: "a como", text: "¿A cómo?", meaning: "how much?", source: "gloss" });

  /** The bank's best matches for a message, on either side, in a language.
   *  word_similarity(phrase, message): how well the phrase appears somewhere
   *  in the (longer) message. */
  const search = async (message, langPrefix) => {
    const score = sql`greatest(word_similarity(coalesce(${phrases.text}, ''), ${message}), word_similarity(coalesce(${phrases.meaning}, ''), ${message}))`;
    return db
      .select({ text: phrases.text, score: sql`${score}::float` })
      .from(phrases)
      .where(ana.where(phrases, and(sql`${phrases.lang} like ${langPrefix + "%"}`, sql`${score} > 0.3`)))
      .orderBy(desc(score))
      .limit(6);
  };

  const hits = await search("Oiga, ¿a cómo están los mangos?", "es");
  assert.equal(hits[0].text, "¿A cómo?");
  assert.ok(hits.every((h) => h.text !== "いくらですか"), "the language prefix keeps Japanese out");
  assert.equal(hits.filter((h) => h.text === "¿A cómo?").length, 1, "the other learner's copy is not a hit");
  // The native-language side matches too.
  const byMeaning = await search("could you wrap it for me please?", "es");
  assert.equal(byMeaning[0].text, "¿Me lo envuelve?");
  // Trigrams work without word boundaries, which is why the doc chose them
  // over full-text search for Japanese and Mandarin.
  const ja = await search("このりんごはいくらですか", "ja");
  assert.equal(ja[0]?.text, "いくらですか");
});

test("the trigram GIN indexes exist on text and meaning", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  const rows = await query(`select indexname, indexdef from pg_indexes where tablename = 'phrases' and indexdef like '%gin_trgm_ops%' order by 1`);
  assert.deepEqual(rows.map((r) => r.indexname), ["phrases_meaning_trgm", "phrases_text_trgm"]);
});

/* --------------------------------- config --------------------------------- */

test("DATABASE_URL: the shell, then .env.local, then the default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-env-"));
  const file = path.join(dir, ".env.local");
  assert.equal(databaseUrl({}, path.join(dir, "missing")), DEFAULT_DATABASE_URL);
  fs.writeFileSync(file, "# keys\nELEVENLABS_API_KEY=x\nDATABASE_URL='postgres://localhost/from_file'\n");
  assert.equal(databaseUrl({}, file), "postgres://localhost/from_file");
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://localhost/from_shell" }, file), "postgres://localhost/from_shell");
  assert.equal(databaseName(DEFAULT_DATABASE_URL), "lingo_dojo");
  assert.equal(databaseName("postgres://u:p@db.local:5433/other?sslmode=disable"), "other");
  assert.throws(() => databaseName("postgres://localhost/"), /names no database/);
  assert.equal(redact("postgres://u:secret@localhost/x"), "postgres://u:***@localhost/x");
});
