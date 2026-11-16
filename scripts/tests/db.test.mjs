// The database foundation (docs/DATA.md): the constraints the committed
// migration creates, the owned-row helper, and trigram search. Every test runs
// on its own in-process PGlite database (testdb.mjs), so nothing here needs a
// Postgres server or can touch the dev database. Migration bookkeeping and the
// schema/SQL drift check are in db-migrations.test.mjs.
//   node --test scripts/tests/db.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { freshDb } from "./testdb.mjs";
import { DEFAULT_DATABASE_URL, READER_ROLE, databaseName, databaseUrl, isLinkedWorktree, readerRole, redact } from "../db/config.mjs";
import { forLanguageProfile, forLearner, forUser } from "../db/owned.ts";
import { fromRow, newCard, review, toRow } from "../fsrs.mjs";
import {
  agentMessages, authSessions, cards, clozeItems, conversations, languageProfiles, learners, packFolders, packRevisions, packs, phraseExamples, phrases,
  reviews, turns, users,
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

/** A card's FSRS state as a review stores it (reviews.card_before). */
const BEFORE = { due: "2026-11-15T00:00:00Z", stability: 0, difficulty: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 };

/** A user with one learner per name, each with one language profile;
 *  returns their ids and the profiles ({ id, learnerId }, what
 *  forLanguageProfile takes). */
async function seed(db, username, ...names) {
  const [user] = await db.insert(users).values({ username, passwordHash: "scrypt$test" }).returning();
  const rows = await forUser(db, user.id).insert(
    learners,
    names.map((name) => ({ name, mode: "adult" })),
  );
  const profiles = [];
  for (const r of rows) {
    const [p] = await forLearner(db, r.id).insert(languageProfiles, { targetLanguage: "Spanish", targetVariant: "Mexican Spanish" });
    profiles.push({ id: p.id, learnerId: r.id });
  }
  return { userId: user.id, learnerIds: rows.map((r) => r.id), profiles };
}

/** A complete phrase (target form known). */
const word = (text, extra = {}) => ({ lang: "es-MX", text, norm: text.toLowerCase(), source: "gloss", ...extra });

/** The gloss upsert: one row per (language profile, norm) among complete
 *  phrases; a repeat sighting bumps it. */
const glossUpsert = (scope, values) =>
  scope.upsert(phrases, values, {
    target: [phrases.norm],
    targetWhere: sql`${phrases.text} is not null`,
    set: { seenCount: sql`${phrases.seenCount} + 1`, lastSeenAt: sql`excluded.last_seen_at` },
  });

/* ------------------------------- constraints ------------------------------ */

test("the migration builds every table, with pg_trgm", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((r) => r.tablename);
  assert.deepEqual(tables, [
    "agent_messages", "auth_sessions", "cards", "cloze_calls", "cloze_items", "conversations", "language_profiles", "learners",
    "pack_folders", "pack_revisions", "packs", "phrase_dismissals", "phrase_examples", "phrase_sightings", "phrases", "reviews",
    "turns", "user_settings", "users",
  ]);
  assert.equal((await query(`select extname from pg_extension where extname = 'pg_trgm'`)).length, 1);
});

test("a complete phrase's identity is (language profile, norm), and the gloss upsert bumps it", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  const [first] = await glossUpsert(ana, word("¿A cómo?", { norm: "a como", seenCount: 1 }));
  assert.equal(first.learnerId, a, "upsert stamps the owners");
  assert.equal(first.languageProfileId, pa.id);
  const [again] = await glossUpsert(ana, word("¿a cómo?", { norm: "a como", seenCount: 1 }));
  assert.equal(again.id, first.id);
  assert.equal(again.seenCount, 2);
  await rejectsWith(ana.insert(phrases, word("a cómo", { norm: "a como" })), UNIQUE);
  // Another variant of the language is the same phrase: lang is where it
  // was first met, not part of its identity.
  const [variant] = await glossUpsert(ana, word("¿A cómo?", { norm: "a como", lang: "es-ES" }));
  assert.equal(variant.id, first.id);
  assert.equal(variant.lang, "es-MX");
  // Another learner, another of Ana's languages, or an accent (DATA.md:
  // papa ≠ papá) are different phrases.
  const [bens] = await glossUpsert(forLanguageProfile(db, pb), word("¿A cómo?", { norm: "a como" }));
  assert.equal(bens.seenCount, 0, "Ben's sighting is Ben's own row");
  const [de] = await forLearner(db, a).insert(languageProfiles, { targetLanguage: "German" });
  const [german] = await glossUpsert(forLanguageProfile(db, { id: de.id, learnerId: a }), word("¿A cómo?", { norm: "a como" }));
  assert.notEqual(german.id, first.id, "Ana's German bank is its own");
  await glossUpsert(ana, word("a cómo", { norm: "a cómo" }));
  assert.equal((await ana.list(phrases)).length, 2);
  assert.equal((await ana.get(phrases, eq(phrases.id, first.id))).seenCount, 3, "Ben's and the German upsert never touched this row");
});

test("pending phrases have their own namespace (meaning_norm)", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const ana = forLanguageProfile(db, pa);
  /** A scenario `phrases:` line: an English meaning, no target form yet. */
  const pending = (meaning) => ({ lang: "es-MX", meaning, meaningNorm: meaning.toLowerCase(), source: "scenario" });

  // Collision 1: a pending "taxi" (English) must not capture the target word
  // "taxi" when it is glossed later.
  const [pendingTaxi] = await ana.insert(phrases, pending("taxi"));
  assert.equal(pendingTaxi.norm, null);
  const [glossTaxi] = await glossUpsert(ana, word("taxi", { meaning: "taxi" }));
  assert.notEqual(glossTaxi.id, pendingTaxi.id);
  assert.equal(glossTaxi.seenCount, 0, "a fresh complete row, not an update of the pending one");
  // The same scenario line doesn't pend twice.
  await rejectsWith(ana.insert(phrases, pending("Taxi")), UNIQUE);

  // Collision 2: the merge rule. A target form found for a pending row fills
  // it in only if no complete phrase has that norm…
  const [pendingChange] = await ana.insert(phrases, pending("the change (coins back)"));
  const [filled] = await ana.update(phrases, { text: "la vuelta", norm: "la vuelta", meaningNorm: null, source: "extraction" }, eq(phrases.id, pendingChange.id));
  assert.equal(filled.text, "la vuelta");
  // …otherwise filling it in would collide, so the pending row is deleted and
  // the complete one kept.
  const [pendingHotel] = await ana.insert(phrases, pending("hotel"));
  await glossUpsert(ana, word("hotel"));
  await rejectsWith(ana.update(phrases, { text: "hotel", norm: "hotel", meaningNorm: null }, eq(phrases.id, pendingHotel.id)), UNIQUE);
  assert.equal((await ana.remove(phrases, eq(phrases.id, pendingHotel.id))).length, 1);
  assert.equal((await ana.list(phrases, eq(phrases.norm, "hotel"))).length, 1);

  // A row is complete (text + norm) or pending (neither, plus meaning_norm).
  await rejectsWith(ana.insert(phrases, { lang: "es-MX", text: "hola", source: "manual" }), CHECK);
  await rejectsWith(ana.insert(phrases, { lang: "es-MX", meaning: "hello", source: "scenario" }), CHECK);
});

test("deleting a learner cascades to everything they own", async (t) => {
  const { db, query, close } = await freshDb();
  t.after(close);
  const { userId, learnerIds: [a, b], profiles } = await seed(db, "ana", "Ana", "Ben");
  for (const i of [0, 1]) {
    const lang = forLanguageProfile(db, profiles[i]);
    const mine = lang;
    const [conv] = await lang.insert(conversations, { packSnapshot: {}, mode: "adult" });
    const [turn] = await lang.insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "hola" });
    const [ph] = await mine.insert(phrases, word("hola"));
    await mine.insert(phraseExamples, { phraseId: ph.id, conversationId: conv.id, turnId: turn.id, sentence: "hola" });
    const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "recognize" });
    await mine.insert(reviews, { cardId: card.id, mode: "session", rating: 3, conversationId: conv.id, cardBefore: BEFORE });
    const [pack] = await lang.insert(packs, { slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" });
    await lang.insert(packRevisions, { packId: pack.id, snapshot: {}, action: "create" });
    await lang.insert(packFolders, { name: "trips" });
  }
  await forUser(db, userId).remove(learners, eq(learners.id, a));
  for (const table of ["language_profiles", "conversations", "turns", "phrases", "phrase_examples", "cards", "reviews", "packs", "pack_revisions", "pack_folders"]) {
    const rows = await query(`select learner_id from ${table}`);
    assert.deepEqual(rows.map((r) => r.learner_id), [b], `${table}: only the other learner's row is left`);
  }
  // And a user takes their learners with them.
  await db.delete(users).where(eq(users.id, userId));
  assert.equal((await query(`select count(*)::int as n from phrases`))[0].n, 0);
});

test("deleting a conversation nulls only the provenance links, keeping the memory", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a], profiles: [pa] } = await seed(db, "ana", "Ana");
  const lang = forLanguageProfile(db, pa);
  const mine = lang;
  const [conv] = await lang.insert(conversations, { packSnapshot: { title: "Market" }, mode: "adult" });
  const [turn] = await lang.insert(turns, { conversationId: conv.id, idx: 0, role: "master", lines: [] });
  const [ph] = await mine.insert(phrases, word("la vuelta", { source: "extraction" }));
  const [ex] = await mine.insert(phraseExamples, { phraseId: ph.id, conversationId: conv.id, turnId: turn.id, sentence: "Aquí tiene la vuelta." });
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "produce" });
  const [rev] = await mine.insert(reviews, { cardId: card.id, mode: "session", rating: 1, conversationId: conv.id, cardBefore: BEFORE });

  await lang.remove(conversations, eq(conversations.id, conv.id));
  assert.equal((await lang.list(turns)).length, 0, "turns go with their conversation");
  const example = await mine.get(phraseExamples, eq(phraseExamples.id, ex.id));
  assert.equal(example.conversationId, null);
  assert.equal(example.turnId, null);
  assert.equal(example.learnerId, a, "SET NULL (col) leaves the owner column alone");
  const review = await mine.get(reviews, eq(reviews.id, rev.id));
  assert.equal(review.conversationId, null, "the review survives, unlinked");
  assert.equal(review.learnerId, a);
  assert.deepEqual(review.cardBefore, BEFORE, "the pre-review card state is kept for an override");

  // A phrase takes its cards and their reviews with it.
  await mine.remove(phrases, eq(phrases.id, ph.id));
  assert.equal((await mine.list(cards)).length, 0);
  assert.equal((await mine.list(reviews)).length, 0);
});

test("an example's conversation and turn, and a review's conversation, are in the phrase's own language", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a], profiles: [es] } = await seed(db, "ana", "Ana");
  const [deRow] = await forLearner(db, a).insert(languageProfiles, { targetLanguage: "German" });
  const de = forLanguageProfile(db, { id: deRow.id, learnerId: a });
  const mine = forLanguageProfile(db, es);
  // The same learner's German conversation and turn.
  const [conv] = await de.insert(conversations, { packSnapshot: {}, mode: "adult" });
  const [turn] = await de.insert(turns, { conversationId: conv.id, idx: 0, role: "master", lines: [] });
  const [ph] = await mine.insert(phrases, word("hola"));
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "recognize" });
  await rejectsWith(mine.insert(phraseExamples, { phraseId: ph.id, conversationId: conv.id, sentence: "Hola." }), FOREIGN_KEY);
  await rejectsWith(mine.insert(phraseExamples, { phraseId: ph.id, turnId: turn.id, sentence: "Hola." }), FOREIGN_KEY);
  await rejectsWith(mine.insert(reviews, { cardId: card.id, mode: "session", rating: 3, conversationId: conv.id, cardBefore: BEFORE }), FOREIGN_KEY);
});

test("deleting a learner nulls only an auth session's active learner", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { userId, learnerIds: [a] } = await seed(db, "ana", "Ana", "Kiddo");
  const mine = forUser(db, userId);
  await mine.insert(authSessions, { id: "hash-1", learnerId: a, expiresAt: new Date(Date.now() + 86_400_000) });
  await mine.remove(learners, eq(learners.id, a));
  const session = await mine.get(authSessions, eq(authSessions.id, "hash-1"));
  assert.equal(session.learnerId, null, "back to the picker");
  assert.equal(session.userId, userId, "still signed in");
});

test("no reference can reach another owner's row", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const ana = await seed(db, "ana", "Ana");
  const ben = await seed(db, "ben", "Ben");
  const [a] = ana.learnerIds;
  const [b] = ben.learnerIds;
  const [conv] = await forLanguageProfile(db, ana.profiles[0]).insert(conversations, { packSnapshot: {}, mode: "adult" });
  const [turn] = await forLanguageProfile(db, ana.profiles[0]).insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "private" });
  const [ph] = await forLanguageProfile(db, ana.profiles[0]).insert(phrases, word("hola"));
  const benScope = forLanguageProfile(db, ben.profiles[0]);
  // Ben's scope stamps Ben's id; the composite keys refuse Ana's parents…
  await rejectsWith(forLanguageProfile(db, ben.profiles[0]).insert(turns, { conversationId: conv.id, idx: 1, role: "learner", text: "x" }), FOREIGN_KEY);
  // …and a scope that names Ana's profile with Ben as its learner can't
  // write anything: the profile isn't Ben's.
  await rejectsWith(forLanguageProfile(db, { id: ana.profiles[0].id, learnerId: b }).insert(conversations, { packSnapshot: {}, mode: "adult" }), FOREIGN_KEY);
  await rejectsWith(benScope.insert(cards, { phraseId: ph.id, skill: "listen" }), FOREIGN_KEY);
  // …and the nullable provenance links too: no reading Ana's turn text
  // through Ben's example.
  const [bph] = await benScope.insert(phrases, word("hola"));
  await rejectsWith(benScope.insert(phraseExamples, { phraseId: bph.id, turnId: turn.id, sentence: "x" }), FOREIGN_KEY);
  await rejectsWith(benScope.insert(phraseExamples, { phraseId: bph.id, conversationId: conv.id, sentence: "x" }), FOREIGN_KEY);
  const [bcard] = await benScope.insert(cards, { phraseId: bph.id, skill: "produce" });
  await rejectsWith(benScope.insert(reviews, { cardId: bcard.id, mode: "session", rating: 3, conversationId: conv.id, cardBefore: BEFORE }), FOREIGN_KEY);
  // An auth session's active learner must be one of its own user's, and
  // its active language one of that learner's.
  await rejectsWith(
    forUser(db, ben.userId).insert(authSessions, { id: "hash-2", learnerId: a, expiresAt: new Date(Date.now() + 86_400_000) }),
    FOREIGN_KEY,
  );
  await rejectsWith(
    forUser(db, ben.userId).insert(authSessions, { id: "hash-3", learnerId: b, languageProfileId: ana.profiles[0].id, expiresAt: new Date(Date.now() + 86_400_000) }),
    FOREIGN_KEY,
  );
});

test("one learner's two languages: no row can sit under the other, and each has its own pack ids", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { userId, learnerIds: [a], profiles: [es] } = await seed(db, "ana", "Ana");
  const [zh] = await forLearner(db, a).insert(languageProfiles, { targetLanguage: "Mandarin Chinese", level: "A1" });
  const de = { id: zh.id, learnerId: a };
  const spanish = forLanguageProfile(db, es);
  const chinese = forLanguageProfile(db, de);
  const [conv] = await spanish.insert(conversations, { packSnapshot: {}, mode: "adult" });
  const [pack] = await spanish.insert(packs, { folder: "trips", slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" });
  // The other language's scope neither sees nor reaches them…
  assert.deepEqual(await chinese.list(conversations), []);
  assert.deepEqual(await chinese.list(packs), []);
  assert.equal(await chinese.get(packs, eq(packs.id, pack.id)), undefined);
  assert.deepEqual(await chinese.update(packs, { title: "Mine now" }, eq(packs.id, pack.id)), []);
  assert.deepEqual(await chinese.remove(conversations, eq(conversations.id, conv.id)), []);
  // …and the composite keys refuse a child under the other language's parent.
  await rejectsWith(chinese.insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "x" }), FOREIGN_KEY);
  await rejectsWith(chinese.insert(packRevisions, { packId: pack.id, snapshot: {}, action: "update" }), FOREIGN_KEY);
  // A pack id is per language: Chinese may have its own trips/market.
  await chinese.insert(packs, { folder: "trips", slug: "market", title: "市场", created: "2026-11-15T09:00:00+08:00" });
  await rejectsWith(spanish.insert(packs, { folder: "trips", slug: "market", title: "Again", created: "x" }), UNIQUE);
  // Folders too: (profile, name).
  await spanish.insert(packFolders, { name: "trips" });
  await chinese.insert(packFolders, { name: "trips" });
  await rejectsWith(chinese.insert(packFolders, { name: "trips" }), UNIQUE);
  // The phrase bank too: each language has its own, and a card can't sit
  // under the other language's phrase.
  const [hola] = await spanish.insert(phrases, word("hola"));
  assert.deepEqual(await chinese.list(phrases), []);
  await rejectsWith(chinese.insert(cards, { phraseId: hola.id, skill: "recognize" }), FOREIGN_KEY);
  await rejectsWith(chinese.insert(phraseExamples, { phraseId: hola.id, sentence: "x" }), FOREIGN_KEY);
  // A session's language must be its learner's.
  await forUser(db, userId).insert(authSessions, { id: "hash-z", learnerId: a, languageProfileId: zh.id, expiresAt: new Date(Date.now() + 86_400_000) });
  // Deleting a language profile nulls only the session's language.
  await forLearner(db, a).remove(languageProfiles, eq(languageProfiles.id, zh.id));
  const session = await forUser(db, userId).get(authSessions, eq(authSessions.id, "hash-z"));
  assert.equal(session.languageProfileId, null);
  assert.equal(session.learnerId, a, "the learner stays picked");
  assert.equal((await chinese.list(packs)).length, 0, "its packs went with it");
  assert.equal((await spanish.list(packs)).length, 1, "the other language's stayed");
});

test("the other named constraints hold", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const lang = forLanguageProfile(db, pa);
  const mine = lang;
  // Usernames are stored lowercased.
  await rejectsWith(db.insert(users).values({ username: "Ana2", passwordHash: "x" }), CHECK);
  await rejectsWith(db.insert(users).values({ username: "ana", passwordHash: "x" }), UNIQUE);
  // One card per phrase and skill.
  const [ph] = await mine.insert(phrases, word("hola"));
  await mine.insert(cards, { phraseId: ph.id, skill: "produce" });
  await rejectsWith(mine.insert(cards, { phraseId: ph.id, skill: "produce" }), UNIQUE);
  await rejectsWith(mine.insert(cards, { phraseId: ph.id, skill: "write" }), CHECK);
  // Turn positions are unique within a conversation.
  const [conv] = await lang.insert(conversations, { packSnapshot: {}, mode: "kids" });
  await lang.insert(turns, { conversationId: conv.id, idx: 0, role: "learner", text: "a" });
  await rejectsWith(lang.insert(turns, { conversationId: conv.id, idx: 0, role: "master" }), UNIQUE);
  // A live pack's (folder, slug) is unique; a soft-deleted one frees it.
  const pack = { folder: "trips", slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" };
  const [first] = await lang.insert(packs, pack);
  await rejectsWith(lang.insert(packs, pack), UNIQUE);
  await lang.update(packs, { deletedAt: new Date() }, eq(packs.id, first.id));
  await lang.insert(packs, pack);
  // Ratings are FSRS's 1-4, and a review keeps the card it changed.
  const [card] = await mine.list(cards);
  await rejectsWith(mine.insert(reviews, { cardId: card.id, mode: "flashcard", rating: 5, cardBefore: BEFORE }), CHECK);
  await rejectsWith(mine.insert(reviews, { cardId: card.id, mode: "flashcard", rating: 3 }), "23502");
});

test("at most one session review per card per conversation", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const lang = forLanguageProfile(db, pa);
  const mine = lang;
  const [ph] = await mine.insert(phrases, word("hola"));
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "produce" });
  const [conv] = await lang.insert(conversations, { packSnapshot: {}, mode: "adult" });
  const review = { cardId: card.id, mode: "session", rating: 3, conversationId: conv.id, cardBefore: BEFORE };
  await mine.insert(reviews, review);
  await rejectsWith(mine.insert(reviews, { ...review, rating: 1 }), UNIQUE);
  // Practice reviews in the same conversation's span are not limited.
  await mine.insert(reviews, { ...review, mode: "flashcard" });
  await mine.insert(reviews, { ...review, mode: "flashcard" });
  // Nor is the same card in another conversation.
  const [conv2] = await lang.insert(conversations, { packSnapshot: {}, mode: "adult" });
  await mine.insert(reviews, { ...review, conversationId: conv2.id });
});

test("agent messages and pack revisions keep insertion order within one transaction", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { userId, profiles: [pa] } = await seed(db, "ana", "Ana");
  const [pack] = await forLanguageProfile(db, pa).insert(packs, { slug: "market", title: "Market", created: "2026-11-15T09:00:00-06:00" });
  await db.transaction(async (tx) => {
    await forUser(tx, userId).insert(agentMessages, [{ role: "user", text: "first" }, { role: "assistant", text: "second" }]);
    await forUser(tx, userId).insert(agentMessages, { role: "commit", text: "third" });
    for (const action of ["create", "update", "rename"]) {
      await forLanguageProfile(tx, pa).insert(packRevisions, { packId: pack.id, snapshot: {}, action });
    }
  });
  const msgs = await forUser(db, userId).list(agentMessages, undefined, { orderBy: agentMessages.seq });
  assert.equal(new Set(msgs.map((m) => m.ts.getTime())).size, 1, "now() ties within the transaction");
  assert.deepEqual(msgs.map((m) => m.text), ["first", "second", "third"]);
  const revs = await forLanguageProfile(db, pa).list(packRevisions, eq(packRevisions.packId, pack.id), { orderBy: packRevisions.seq });
  assert.deepEqual(revs.map((r) => r.action), ["create", "update", "rename"]);
});

test("a card holds every field of a ts-fsrs Card", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const mine = forLanguageProfile(db, pa);
  const [ph] = await mine.insert(phrases, word("hola"));
  const [card] = await mine.insert(cards, { phraseId: ph.id, skill: "recognize" });
  // ts-fsrs 6 `Card`, with its own snake_case names (fsrs.mjs toRow/fromRow).
  for (const k of ["due", "stability", "difficulty", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review"]) {
    assert.ok(k in card, `cards.${k}`);
  }
  assert.ok("stability_fast" in card, "FSRS-7's extra stability");
  assert.equal(card.state, 0);
  assert.ok(card.due instanceof Date);
  const [moved] = await mine.update(cards, { scheduled_days: 4.78, stability_fast: 3.14, state: 2, reps: 1, last_review: new Date() }, eq(cards.id, card.id));
  assert.equal(moved.scheduled_days, 4.78, "fractional days survive");
});

test("fsrs.mjs card state round-trips through the cards table", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const mine = forLanguageProfile(db, pa);
  const [ph] = await mine.insert(phrases, word("hola"));
  const t0 = new Date("2026-11-15T15:00:00Z");
  const fresh = newCard(t0);
  const [row] = await mine.insert(cards, { phraseId: ph.id, skill: "produce", ...toRow(fresh) });
  assert.deepEqual(fromRow(row), fresh, "a new card reads back as written");

  // Review twice (Good, then Again a day later), writing each result back.
  let card = fromRow(row);
  for (const [rating, at] of [[3, t0], [1, new Date("2026-11-16T15:00:00Z")]]) {
    const before = card;
    const next = review(card, rating, at).card;
    await mine.insert(reviews, { cardId: row.id, mode: "flashcard", rating, cardBefore: before });
    const [saved] = await mine.update(cards, toRow(next), eq(cards.id, row.id));
    card = fromRow(saved);
    assert.deepEqual(card, next, `rating ${rating}: the reviewed card reads back unchanged`);
  }
  assert.equal(card.reps, 2);
  assert.equal(typeof card.learning_steps, "number");
  // The stored pre-review state is the card as fsrs.mjs had it.
  const [first] = await mine.list(reviews, undefined, { orderBy: reviews.id, limit: 1 });
  assert.deepEqual(first.cardBefore, fresh);
});

/* ----------------------------- owned-row helper --------------------------- */

test("a scope sees, changes and deletes only its own owner's rows", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  const ben = forLanguageProfile(db, pb);
  const rows = await ana.insert(phrases, [word("hola"), word("adiós", { norm: "adios" })]);
  assert.ok(rows.every((r) => r.learnerId === a), "insert stamps the owner");
  const [bensHola] = await ben.insert(phrases, word("hola"));

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
});

test("a raw `or` condition cannot escape the owner filter", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  const ben = forLanguageProfile(db, pb);
  await ana.insert(phrases, [word("hola", { meaning: "hello" }), word("taxi", { meaning: "taxi" })]);
  await ben.insert(phrases, [word("hola", { meaning: "hello" }), word("gracias", { meaning: "thanks" })]);
  // The natural trigram filter: text %> q or meaning %> q. Unparenthesized,
  // `learner_id = $1 and A or B` would match Ben's "hello" through B.
  const either = (q) => sql`${phrases.text} = ${q} or ${phrases.meaning} = ${q}`;
  const owners = (rows) => [...new Set(rows.map((r) => r.learnerId))];

  assert.deepEqual(owners(await ana.list(phrases, either("hello"))), [a], "read");
  assert.deepEqual(owners(await ana.list(phrases, sql`true or true`)), [a], "read, worst case");
  assert.equal((await ana.get(phrases, sql`false or ${phrases.text} = 'gracias'`)), undefined, "get");
  const updated = await ana.update(phrases, { starred: true }, either("hello"));
  assert.deepEqual(owners(updated), [a], "update");
  assert.equal((await ben.list(phrases, eq(phrases.starred, true))).length, 0, "Ben's rows untouched by the update");
  const removed = await ana.remove(phrases, either("thanks"));
  assert.deepEqual(removed, [], "remove: Ana has no 'thanks'");
  await ana.remove(phrases, sql`true or true`);
  assert.equal((await ben.list(phrases)).length, 2, "Ben's rows survive Ana's remove");
  assert.equal((await ana.list(phrases)).length, 0);
  // where() for hand-written queries parenthesizes the same way.
  const rows = await db.select().from(phrases).where(ben.where(phrases, sql`true or true`));
  assert.deepEqual(owners(rows), [b]);
});

test("owned-row rules hold at runtime for untyped callers", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { userId, learnerIds: [a, b], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  await ana.insert(phrases, [word("hola"), word("adiós", { norm: "adios" })]);
  await forLanguageProfile(db, pb).insert(phrases, word("hola"));
  // A table with no owner column.
  await assert.rejects(forLearner(db, a).list(users), /no learnerId column/);
  await assert.rejects(ana.list(users), /no languageProfileId column/);
  await assert.rejects(forUser(db, userId).insert(turns, { idx: 0, role: "learner" }), /no userId column/);
  // No condition, no update or remove.
  await assert.rejects(ana.update(phrases, { starred: true }), /needs a condition/);
  await assert.rejects(ana.remove(phrases), /needs a condition/);
  await assert.rejects(ana.get(phrases), /needs a condition/);
  // The owner is the scope's to set: not in values, set or upsert.
  await assert.rejects(ana.insert(phrases, { ...word("x"), learnerId: b }), /sets learnerId itself/);
  await assert.rejects(ana.update(phrases, { learnerId: b }, eq(phrases.norm, "hola")), /sets learnerId itself/);
  await assert.rejects(
    ana.upsert(phrases, word("hola"), { target: [phrases.norm], targetWhere: sql`${phrases.text} is not null`, set: { learnerId: b } }),
    /sets learnerId itself/,
  );
  await assert.rejects(ana.update(phrases, { languageProfileId: pb.id }, eq(phrases.norm, "hola")), /sets languageProfileId itself/);
  // No owner, no scope.
  assert.throws(() => forLearner(db, ""), /need a learnerId/);
  assert.throws(() => forLearner(db, undefined), /need a learnerId/);
  assert.throws(() => forLanguageProfile(db, { id: "", learnerId: a }), /need a languageProfileId/);
  assert.throws(() => forLanguageProfile(db, { id: a, learnerId: "" }), /need a learnerId/);
  assert.throws(() => forLanguageProfile(db, undefined), /need a/);
  // A language's rows only through a language scope: a learner scope would
  // reach every one of the learner's languages at once.
  for (const table of [packs, packFolders, packRevisions, conversations, turns, phrases, phraseExamples, cards, reviews, clozeItems]) {
    await assert.rejects(forLearner(db, a).list(table), /belong to a language profile: use forLanguageProfile, not forLearner/);
  }
  // …and a language scope reaches only tables that belong to a language.
  await assert.rejects(ana.list(languageProfiles), /no languageProfileId column/);
  // Removing everything is its own verb, and still only the owner's rows.
  assert.equal((await ana.removeAllOwned(phrases)).length, 2);
  assert.equal((await forLanguageProfile(db, pb).list(phrases)).length, 1);
});

test("insertOrIgnore: stamps the owner, skips a conflict (the owner is always in the target), returns only what it inserted", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { learnerIds: [a, b], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  const pack = { folder: "", slug: "2026-10-19-x", title: "X", created: "2026-10-19T00:00:00Z" };
  const live = { target: [packs.folder, packs.slug], targetWhere: sql`${packs.deletedAt} is null` };
  const [made] = await ana.insertOrIgnore(packs, pack, live);
  assert.equal(made.learnerId, a);
  assert.equal(made.languageProfileId, pa.id, "both owners stamped");
  assert.deepEqual(await ana.insertOrIgnore(packs, { ...pack, title: "Again" }, live), [], "a conflict inserts nothing");
  assert.equal((await ana.list(packs)).length, 1);
  // Ben's identical row is not a conflict with Ana's.
  assert.equal((await forLanguageProfile(db, pb).insertOrIgnore(packs, pack, live)).length, 1);
  // No target: any unique conflict skips.
  assert.deepEqual(await ana.insertOrIgnore(packs, pack), []);
  await assert.rejects(ana.insertOrIgnore(packs, { ...pack, learnerId: b }), /sets learnerId itself/);
  await assert.rejects(ana.insertOrIgnore(packs, { ...pack, languageProfileId: pb.id }), /sets languageProfileId itself/);
});

test("where() keeps the owner filter in hand-written queries", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  const [ph] = await ana.insert(phrases, word("hola"));
  await ana.insert(cards, [{ phraseId: ph.id, skill: "recognize" }, { phraseId: ph.id, skill: "produce" }]);
  const [bph] = await forLanguageProfile(db, pb).insert(phrases, word("hola"));
  await forLanguageProfile(db, pb).insert(cards, { phraseId: bph.id, skill: "produce" });
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
  const { learnerIds: [a], profiles: [pa, pb] } = await seed(db, "ana", "Ana", "Ben");
  const ana = forLanguageProfile(db, pa);
  await ana.insert(phrases, [
    word("¿A cómo?", { norm: "a como", meaning: "how much?" }),
    word("¿Me lo envuelve?", { norm: "me lo envuelve", meaning: "could you wrap it for me?", source: "extraction" }),
    word("la vuelta", { meaning: "the change (coins back)" }),
  ]);
  const [jp] = await forLearner(db, a).insert(languageProfiles, { targetLanguage: "Japanese" });
  const japanese = forLanguageProfile(db, { id: jp.id, learnerId: a });
  await japanese.insert(phrases, word("いくらですか", { lang: "ja-JP", meaning: "how much is it?" }));
  await forLanguageProfile(db, pb).insert(phrases, word("¿A cómo?", { norm: "a como", meaning: "how much?" }));

  /** The bank's best matches for a message, on either side, in one
   *  language's bank. word_similarity(phrase, message): how well the phrase
   *  appears somewhere in the (longer) message. Per profile, so a scan; see
   *  DATA.md. */
  const search = async (scope, message) => {
    const score = sql`greatest(word_similarity(coalesce(${phrases.text}, ''), ${message}), word_similarity(coalesce(${phrases.meaning}, ''), ${message}))`;
    return db
      .select({ text: phrases.text, score: sql`${score}::float` })
      .from(phrases)
      .where(scope.where(phrases, sql`${score} > 0.3`))
      .orderBy(desc(score))
      .limit(6);
  };

  const hits = await search(ana, "Oiga, ¿a cómo están los mangos?");
  assert.equal(hits[0].text, "¿A cómo?");
  assert.ok(hits.every((h) => h.text !== "いくらですか"), "the Japanese bank is another profile's");
  assert.equal(hits.filter((h) => h.text === "¿A cómo?").length, 1, "the other learner's copy is not a hit");
  // The native-language side matches too.
  const byMeaning = await search(ana, "could you wrap it for me please?");
  assert.equal(byMeaning[0].text, "¿Me lo envuelve?");
  // Trigrams work without word boundaries, which is why the doc chose them
  // over full-text search for Japanese and Mandarin.
  const ja = await search(japanese, "このりんごはいくらですか");
  assert.equal(ja[0]?.text, "いくらですか");
});

test("LOOKUP-direction search (query inside phrases) with the trigram operator", async (t) => {
  const { db, query, close } = await freshDb();
  t.after(close);
  const { profiles: [pa] } = await seed(db, "ana", "Ana");
  const ana = forLanguageProfile(db, pa);
  await ana.insert(phrases, [word("¿Me lo envuelve?", { norm: "me lo envuelve" }), word("la vuelta")]);
  // `q <% text`: the query found inside a phrase. This is the direction the
  // GIN indexes can serve.
  const rows = await ana.list(phrases, sql`${"envuelve"} <% ${phrases.text}`);
  assert.deepEqual(rows.map((r) => r.text), ["¿Me lo envuelve?"]);
  const idx = await query(`select indexname from pg_indexes where tablename = 'phrases' and indexdef like '%gin_trgm_ops%' order by 1`);
  assert.deepEqual(idx.map((r) => r.indexname), ["phrases_meaning_trgm", "phrases_text_trgm"]);
});

/* --------------------------------- config --------------------------------- */

test("DATABASE_URL: the shell, then .env.local, then the default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-env-"));
  fs.mkdirSync(path.join(dir, ".git")); // a main checkout
  const file = path.join(dir, ".env.local");
  assert.equal(databaseUrl({}, path.join(dir, "missing"), dir), DEFAULT_DATABASE_URL);
  fs.writeFileSync(file, "# keys\nELEVENLABS_API_KEY=x\nDATABASE_URL='postgres://localhost/from_file'\n");
  assert.equal(databaseUrl({}, file, dir), "postgres://localhost/from_file");
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://localhost/from_shell" }, file, dir), "postgres://localhost/from_shell");
  assert.equal(databaseName(DEFAULT_DATABASE_URL), "lingo_dojo");
  assert.equal(databaseName("postgres://u:p@db.local:5433/other?sslmode=disable"), "other");
  assert.throws(() => databaseName("postgres://localhost/"), /names no database/);
  assert.equal(redact("postgres://u:secret@localhost/x"), "postgres://u:***@localhost/x");
  assert.ok(!redact("postgres://u@localhost/x?password=hunter2&sslmode=prefer").includes("hunter2"));
});

test("a linked worktree never defaults to the real database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-wt-"));
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
  assert.equal(isLinkedWorktree(dir), true);
  assert.throws(() => databaseUrl({}, path.join(dir, ".env.local"), dir), /linked git worktree[\s\S]*scratch database/);
  // An explicit URL, from the shell or the worktree's own .env.local, is fine.
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://localhost/lingo_dojo_scratch_x" }, path.join(dir, ".env.local"), dir), "postgres://localhost/lingo_dojo_scratch_x");
  fs.writeFileSync(path.join(dir, ".env.local"), "DATABASE_URL=postgres://localhost/lingo_dojo_scratch_y\n");
  assert.equal(databaseUrl({}, path.join(dir, ".env.local"), dir), "postgres://localhost/lingo_dojo_scratch_y");
});

test("the reader role: the shell, then .env.local, then lingo_reader, except in a linked worktree, which must name one", () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-env-"));
  fs.mkdirSync(path.join(main, ".git"));
  assert.equal(readerRole({}, path.join(main, "missing"), main), READER_ROLE);
  fs.writeFileSync(path.join(main, ".env.local"), "LINGO_READER_ROLE=lingo_reader_from_file\n");
  assert.equal(readerRole({}, path.join(main, ".env.local"), main), "lingo_reader_from_file");
  assert.equal(readerRole({ LINGO_READER_ROLE: "lingo_reader_shell" }, path.join(main, ".env.local"), main), "lingo_reader_shell");
  assert.throws(() => readerRole({ LINGO_READER_ROLE: "postgres" }, path.join(main, "missing"), main), /must look like/);

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-wt-"));
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
  assert.throws(() => readerRole({}, path.join(wt, ".env.local"), wt), /linked git worktree[\s\S]*LINGO_READER_ROLE/);
  assert.equal(readerRole({ LINGO_READER_ROLE: "lingo_reader_scratch_x" }, path.join(wt, ".env.local"), wt), "lingo_reader_scratch_x");
  fs.writeFileSync(path.join(wt, ".env.local"), "LINGO_READER_ROLE=lingo_reader_scratch_y\n");
  assert.equal(readerRole({}, path.join(wt, ".env.local"), wt), "lingo_reader_scratch_y");
});
