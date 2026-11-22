// The shared picture pool in the database (docs/DATA.md §The shared picture
// pool, migration 0020, bead ld-ec9): the words and levels the background
// naming call stored for concepts content/picture-words.yaml lacks, its
// ledger, learners' drawings shared into the stock set, and the one
// personal write: a pool word the learner answered for the first time,
// made a phrase of their bank (source `picture`) with its picture row.
// What decides is scripts/picture-pool.mjs (pure); the calls and routes
// web/server/picturePool.ts and web/server/pictures.ts.
//
// The pool's tables are install-wide (no owner column) and queried here
// alone, without owned.ts; a learner's rows go through forLanguageProfile.
//
// Erasable TypeScript only, like pictures.ts: the tests import it as is.

import { and, eq, gt, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { normKey } from "../match.mjs";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { absorbPending } from "./phrases.ts";
import type { StockPointer } from "./pictures.ts";
import { phraseDismissals, phrasePictures, phrases, picturePoolCalls, picturePoolLevels, picturePoolWords, pictureSharedRefused, pictureStockConcepts } from "./schema.ts";

/** The stored words and levels by concept: what the file lacks. */
export interface StoredPool {
  words: Map<string, Record<string, string>>;
  levels: Map<string, string>;
}

export async function storedPool(db: Db): Promise<StoredPool> {
  const [w, l] = await Promise.all([db.select().from(picturePoolWords), db.select().from(picturePoolLevels)]);
  const words = new Map<string, Record<string, string>>();
  for (const r of w) (words.get(r.conceptId) ?? words.set(r.conceptId, {}).get(r.conceptId)!)[r.key] = r.text;
  return { words, levels: new Map(l.map((r) => [r.conceptId, r.level])) };
}

/** Store what a naming call gave (already checked: picture-pool.mjs
 *  parsePoolWordsReply), once: a word or a level already there is kept. */
export async function storePoolWords(db: Db, items: { id: string; level: string; words: Record<string, string> }[]): Promise<void> {
  if (!items.length) return;
  await db.transaction(async (tx) => {
    await tx.insert(picturePoolLevels).values(items.map((i) => ({ conceptId: i.id, level: i.level }))).onConflictDoNothing();
    const words = items.flatMap((i) => Object.entries(i.words).map(([key, text]) => ({ conceptId: i.id, key, text })));
    if (words.length) await tx.insert(picturePoolWords).values(words).onConflictDoNothing();
  });
}

/** Forget a concept's stored words and level (its added row was deleted). */
export async function forgetPoolWords(db: Db, conceptId: string): Promise<void> {
  await db.delete(picturePoolWords).where(eq(picturePoolWords.conceptId, conceptId));
  await db.delete(picturePoolLevels).where(eq(picturePoolLevels.conceptId, conceptId));
}

/* ---------------------------------- ledger --------------------------------- */

/** Naming calls started since `since`, install-wide: what the cap counts. */
export async function poolCallsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(picturePoolCalls).where(gt(picturePoolCalls.createdAt, since));
  return Number(row?.n) || 0;
}

/** Enter a naming call as it starts (pruning rows before `prune`); its id. */
export async function poolCallStarted(db: Db, userId: string, concepts: number, prune: Date): Promise<string> {
  await db.delete(picturePoolCalls).where(lt(picturePoolCalls.createdAt, prune));
  const [row] = await db.insert(picturePoolCalls).values({ userId, concepts }).returning({ id: picturePoolCalls.id });
  return row.id;
}

export async function poolCallDone(db: Db, id: string, outcome: "ok" | "failed"): Promise<void> {
  await db.update(picturePoolCalls).set({ outcome }).where(eq(picturePoolCalls.id, id));
}

/* --------------------------------- drawings -------------------------------- */

/** The source files never to share (again): the ones shared already
 *  (picture_stock_concepts.source_file) and the ones an admin took out of
 *  the pool (picture_shared_refused). */
export async function sharedFiles(db: Db): Promise<Set<string>> {
  const [rows, refused] = await Promise.all([
    db.select({ f: pictureStockConcepts.sourceFile }).from(pictureStockConcepts).where(isNotNull(pictureStockConcepts.sourceFile)),
    db.select({ f: pictureSharedRefused.sourceFile }).from(pictureSharedRefused),
  ]);
  return new Set([...rows.map((r) => r.f!), ...refused.map((r) => r.f)]);
}

/** An admin took the drawing made from `sourceFile` out of the pool: it is
 *  never shared again (sharedFiles, shareDrawing). Idempotent. */
export async function refuseSharedFile(db: Db, sourceFile: string, by: string | null): Promise<void> {
  await db.insert(pictureSharedRefused).values({ sourceFile, refusedBy: by }).onConflictDoNothing();
}

/**
 * Share a learner's drawing: a `drawing` concept (its file already copied
 * into the stock folder by the caller) and its own word in the owner's
 * language, in one transaction. False when that file was shared already
 * (its id is made from the file, so a second run is a no-op).
 */
export async function shareDrawing(
  db: Db,
  d: { id: string; category: string; description: string; words: string[]; sourceFile: string; kidsSafe: boolean | null; createdBy: string; key: string | null; text: string | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Refused meanwhile (an admin removed it while the run read the list).
    const [refused] = await tx.select({ f: pictureSharedRefused.sourceFile }).from(pictureSharedRefused).where(eq(pictureSharedRefused.sourceFile, d.sourceFile));
    if (refused) return false;
    const rows = await tx
      .insert(pictureStockConcepts)
      .values({ id: d.id, category: d.category, description: d.description, words: d.words, origin: "drawing", sourceFile: d.sourceFile, kidsSafe: d.kidsSafe, createdBy: d.createdBy })
      .onConflictDoNothing()
      .returning({ id: pictureStockConcepts.id });
    if (rows.length !== 1) return false;
    if (d.key && d.text) await tx.insert(picturePoolWords).values({ conceptId: d.id, key: d.key, text: d.text }).onConflictDoNothing();
    return true;
  });
}

/** Unshare the drawing made from `sourceFile` (its owner removed or redrew
 *  that picture): the concept and its words go; returns its id for the
 *  caller to delete the stock file, or null when it wasn't shared. */
export async function unshareDrawing(db: Db, sourceFile: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [gone] = await tx.delete(pictureStockConcepts).where(eq(pictureStockConcepts.sourceFile, sourceFile)).returning({ id: pictureStockConcepts.id });
    if (!gone) return null;
    await forgetPoolWords(tx, gone.id);
    return gone.id;
  });
}

/** Shared drawings made from these files whose kids check isn't done:
 *  `{ id, sourceFile, description, words }`. */
export async function uncheckedDrawings(db: Db, files: string[]): Promise<{ id: string; sourceFile: string; description: string; words: string[] }[]> {
  if (!files.length) return [];
  const rows = await db
    .select({ id: pictureStockConcepts.id, sourceFile: pictureStockConcepts.sourceFile, description: pictureStockConcepts.description, words: pictureStockConcepts.words })
    .from(pictureStockConcepts)
    .where(and(eq(pictureStockConcepts.origin, "drawing"), isNull(pictureStockConcepts.kidsSafe), inArray(pictureStockConcepts.sourceFile, files)) as SQL);
  return rows.map((r) => ({ ...r, sourceFile: r.sourceFile! }));
}

/** A shared drawing's kids check, stored once. */
export async function setDrawingKidsSafe(db: Db, id: string, safe: boolean): Promise<void> {
  await db
    .update(pictureStockConcepts)
    .set({ kidsSafe: safe })
    .where(and(eq(pictureStockConcepts.id, id), eq(pictureStockConcepts.origin, "drawing"), isNull(pictureStockConcepts.kidsSafe)) as SQL);
}

/* ------------------------------- the learner ------------------------------- */

/** The word keys (phrases.norm) a pool word may not take for this language:
 *  the bank's words (suspended ones too) and the ones the learner deleted
 *  (phrase_dismissals 'text'), so a pool word never doubles one of theirs
 *  nor comes back after a delete. */
export async function takenNorms(db: Db, profile: LanguageProfileRef): Promise<Set<string>> {
  const mine = forLanguageProfile(db, profile);
  const [own, gone] = await Promise.all([
    db.select({ norm: phrases.norm }).from(phrases).where(mine.where(phrases, isNotNull(phrases.norm))),
    db.select({ key: phraseDismissals.key }).from(phraseDismissals).where(mine.where(phraseDismissals, eq(phraseDismissals.kind, "text"))),
  ]);
  return new Set([...own.map((r) => r.norm!), ...gone.map((r) => r.key)]);
}

/** Which of `ids` (this profile's pool ids, picture-pool.mjs poolId) are
 *  phrases of its bank: pool words adopted, edited or not (poolWords
 *  leaves their concepts out). */
export async function ownPoolIds(db: Db, profile: LanguageProfileRef, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ id: phrases.id }).from(phrases).where(forLanguageProfile(db, profile).where(phrases, inArray(phrases.id, ids)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The first answer to a pool word: it becomes a phrase of this bank, with
 * the id the game gave it (picture-pool.mjs poolId), source `picture`, not
 * starred, and a ready picture row (the given id) pointing at the stock
 * picture, so from now on it is one of the learner's words with its listen
 * card, like any other. A pending phrase of that meaning is folded in, as
 * an add does. When the bank already has those words (added meanwhile),
 * nothing is made and that phrase's id is returned: the caller answers
 * against it (a stale round, as for any edit).
 */
export async function adoptPoolWord(
  db: Db,
  profile: LanguageProfileRef,
  w: { phraseId: string; lang: string; text: string; meaning: string; picture: { id: string; phraseKey: string; description: string; stock: StockPointer } },
): Promise<{ phraseId: string; created: boolean }> {
  const norm = normKey(w.text);
  return db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    // No conflict target: the words (the identity index) or the id taken
    // both leave the row unmade, and are told apart below.
    const [made] = await mine.insertOrIgnore(phrases, { id: w.phraseId, lang: w.lang, text: w.text, norm, meaning: w.meaning, source: "picture", starred: false });
    if (!made) {
      const had = await mine.get(phrases, and(isNotNull(phrases.text), eq(phrases.norm, norm)) as SQL);
      if (had) return { phraseId: had.id, created: false };
      // The id is taken but not by these words: an earlier adoption edited
      // since. That phrase is the learner's now; nothing is made.
      return { phraseId: w.phraseId, created: false };
    }
    await absorbPending(tx, profile, [{ id: made.id, meaningNorm: normKey(w.meaning) || null }]);
    await mine.insertOrIgnore(
      phrasePictures,
      { id: w.picture.id, phraseId: made.id, phraseKey: w.picture.phraseKey, status: "ready", description: w.picture.description, ...w.picture.stock, kidsSafe: null },
      { target: [phrasePictures.phraseId] },
    );
    return { phraseId: made.id, created: true };
  });
}
