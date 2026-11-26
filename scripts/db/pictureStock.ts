// The shared stock pictures' rows (docs/DATA.md §Stock pictures, migration
// 0013, bead ld-318): the concepts an admin added from the picture library
// page (merged with content/pictures.yaml's by pictures.mjs mergeStock) and
// the ledger of stock pictures drawn from that page, which the install-wide
// daily cap (pictures.mjs PICTURE_DAILY_STOCK) counts.
//
// Install-wide, not personal: no owner column, so these are the one place
// the stock tables are queried, without owned.ts. Every write here is an
// admin's (the routes are mounted with wrap's auth "admin"); reads are for
// any logged-in user (the shared set is everyone's).
//
// Erasable TypeScript only, like pictures.ts: the tests import it as is.

import { and, asc, eq, gt, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "./owned.ts";
import { loadPictureStock } from "../content.mjs";
import { forgetPoolWords, refuseSharedFile } from "./picturePool.ts";
import { pictureStockAdults, pictureStockCalls, pictureStockConcepts } from "./schema.ts";

/** The ids content/pictures.yaml has (a shadowed added row shares one). */
const shadowedIds = (): Set<string> => {
  try {
    return new Set(loadPictureStock().concepts.map((c: { id: string }) => c.id));
  } catch {
    return new Set();
  }
};

/** A concept as pictures.mjs mergeStock takes it. */
export interface CustomConcept {
  id: string;
  category: string;
  description: string;
  words: string[];
  /** Adults only: never offered to, matched for or shown to a kids learner. */
  adults?: boolean;
  /** Its look-alike group (migration 0019): never two of one in a round. */
  group?: string | null;
  /** How it came (migration 0020): an admin's, or a learner's shared drawing. */
  origin?: "admin" | "drawing";
  /** A shared drawing's kids check (true, false, or null: not asked). */
  kidsSafe?: boolean | null;
}

/** Every added concept, oldest first (the order they join their category). */
export async function customStockConcepts(db: Db): Promise<CustomConcept[]> {
  const rows = await db
    .select({
      id: pictureStockConcepts.id, category: pictureStockConcepts.category, description: pictureStockConcepts.description, words: pictureStockConcepts.words,
      adults: pictureStockConcepts.adults, group: pictureStockConcepts.group, origin: pictureStockConcepts.origin, kidsSafe: pictureStockConcepts.kidsSafe,
    })
    .from(pictureStockConcepts)
    .orderBy(asc(pictureStockConcepts.createdAt), asc(pictureStockConcepts.id));
  return rows;
}

/** Add a concept (already checked: pictures.mjs readNewConcept). False when
 *  its id was taken meanwhile. */
export async function addCustomStockConcept(db: Db, c: CustomConcept, createdBy: string): Promise<boolean> {
  const rows = await db
    .insert(pictureStockConcepts)
    .values({ id: c.id, category: c.category, description: c.description, words: c.words, adults: c.adults === true, group: c.group ?? null, createdBy })
    .onConflictDoNothing()
    .returning({ id: pictureStockConcepts.id });
  return rows.length === 1;
}

/** Delete an added concept; false when there is no such row (a concept of
 *  content/pictures.yaml is never a row, so it can't be deleted here). */
export async function deleteCustomStockConcept(db: Db, id: string, by: string | null = null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(pictureStockConcepts).where(eq(pictureStockConcepts.id, id)).returning({ id: pictureStockConcepts.id, sourceFile: pictureStockConcepts.sourceFile });
    // A learner's shared drawing stays out: its owner's picture is still
    // ready, and the next picture run would share it again (ld-ec9).
    if (rows[0]?.sourceFile) await refuseSharedFile(tx, rows[0].sourceFile, by);
    // Its words in the picture pool go with it (picturePool.ts), unless the
    // file has a concept of that id (a shadowed row): the file's then own them.
    if (rows.length === 1 && !shadowedIds().has(id)) await forgetPoolWords(tx, id);
    return rows.length === 1;
  });
}

/** Set or clear an added concept's Adults only flag; false when there is
 *  no such row. */
export async function setCustomStockAdults(db: Db, id: string, adults: boolean): Promise<boolean> {
  const rows = await db.update(pictureStockConcepts).set({ adults }).where(eq(pictureStockConcepts.id, id)).returning({ id: pictureStockConcepts.id });
  return rows.length === 1;
}

/** Set or clear (null) an added concept's look-alike group (already
 *  checked: pictures.mjs readStockGroup); false when there is no such row. */
export async function setCustomStockGroup(db: Db, id: string, group: string | null): Promise<boolean> {
  // Written on purpose: a cleared group stays clear (no fill re-derives it).
  const rows = await db.update(pictureStockConcepts).set({ group, groupSet: true }).where(eq(pictureStockConcepts.id, id)).returning({ id: pictureStockConcepts.id });
  return rows.length === 1;
}

/**
 * The one-off fill of a look-alike group for learners' drawings shared
 * before 0021 (ld-44x), for each `drawing` concept never marked written
 * (`look_alike_set` false):
 *  - one that already has a group (an admin set it from the picture
 *    library before 0021) keeps it and is only marked;
 *  - one with none gets `groupOf(description)` (pictures.mjs lookAlikeOf:
 *    free, no call) and is marked.
 * So each is filled once, an admin's group is never overwritten, and an
 * admin's later clear sticks. Idempotent and safe beside another read
 * doing the same (every update is guarded by the flag, the second also by
 * a null group); after the first pass it is a read that finds nothing.
 * Returns how many rows it marked.
 */
export async function fillDrawingGroups(db: Db, groupOf: (description: string) => string | null): Promise<number> {
  const unset = and(eq(pictureStockConcepts.origin, "drawing"), eq(pictureStockConcepts.groupSet, false)) as SQL;
  const kept = await db
    .update(pictureStockConcepts)
    .set({ groupSet: true })
    .where(and(unset, isNotNull(pictureStockConcepts.group)) as SQL)
    .returning({ id: pictureStockConcepts.id });
  let n = kept.length;
  const none = and(unset, isNull(pictureStockConcepts.group)) as SQL;
  const rows = await db.select({ id: pictureStockConcepts.id, description: pictureStockConcepts.description }).from(pictureStockConcepts).where(none);
  for (const r of rows) {
    const done = await db
      .update(pictureStockConcepts)
      .set({ group: groupOf(r.description), groupSet: true })
      .where(and(eq(pictureStockConcepts.id, r.id), none) as SQL)
      .returning({ id: pictureStockConcepts.id });
    n += done.length;
  }
  return n;
}

/** An admin's Adults only setting for a content/pictures.yaml concept, as
 *  pictures.mjs mergeStock takes it (`adultsOverrides`). */
export interface AdultsOverride {
  id: string;
  adults: boolean;
  /** An open kids report (ld-ur3, stockPictures.ts adultsOverrides):
   *  kept from kids, added concepts too (pictures.mjs mergeStock). */
  held?: boolean;
}

/** Every Adults only setting an admin made on a file concept (migration 0018). */
export async function stockAdultsOverrides(db: Db): Promise<AdultsOverride[]> {
  return db.select({ id: pictureStockAdults.conceptId, adults: pictureStockAdults.adults }).from(pictureStockAdults).orderBy(asc(pictureStockAdults.conceptId));
}

/** Set a file concept's Adults only flag to `adults`, install-wide. `fileValue`
 *  is the file's own flag: the same value deletes the row (the file is
 *  followed again), another one is stored. */
export async function setStockAdultsOverride(db: Db, id: string, adults: boolean, fileValue: boolean, setBy: string): Promise<void> {
  if (adults === fileValue) {
    await db.delete(pictureStockAdults).where(eq(pictureStockAdults.conceptId, id));
    return;
  }
  await db
    .insert(pictureStockAdults)
    .values({ conceptId: id, adults, setBy })
    .onConflictDoUpdate({ target: pictureStockAdults.conceptId, set: { adults, setBy, updatedAt: sql`now()` } });
}

/** Stock draws started since `since`, install-wide: what the daily cap counts. */
export async function stockCallsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pictureStockCalls).where(gt(pictureStockCalls.createdAt, since));
  return row?.n ?? 0;
}

/** Enter a stock draw in the ledger as it starts (pruning rows past the
 *  window, `since`); its id, for stockCallDone. */
export async function stockCallStarted(db: Db, userId: string, conceptId: string, since: Date): Promise<string> {
  await db.delete(pictureStockCalls).where(lt(pictureStockCalls.createdAt, since));
  const [row] = await db.insert(pictureStockCalls).values({ userId, conceptId }).returning({ id: pictureStockCalls.id });
  return row.id;
}

/** How a stock draw ended, for diagnosis. */
export async function stockCallDone(db: Db, id: string, outcome: "ok" | "refused" | "failed"): Promise<void> {
  await db.update(pictureStockCalls).set({ outcome }).where(eq(pictureStockCalls.id, id));
}
