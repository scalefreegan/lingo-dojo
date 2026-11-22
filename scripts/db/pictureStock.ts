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

import { asc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "./owned.ts";
import { pictureStockAdults, pictureStockCalls, pictureStockConcepts } from "./schema.ts";

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
}

/** Every added concept, oldest first (the order they join their category). */
export async function customStockConcepts(db: Db): Promise<CustomConcept[]> {
  const rows = await db
    .select({
      id: pictureStockConcepts.id, category: pictureStockConcepts.category, description: pictureStockConcepts.description, words: pictureStockConcepts.words,
      adults: pictureStockConcepts.adults, group: pictureStockConcepts.group,
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
export async function deleteCustomStockConcept(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(pictureStockConcepts).where(eq(pictureStockConcepts.id, id)).returning({ id: pictureStockConcepts.id });
  return rows.length === 1;
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
  const rows = await db.update(pictureStockConcepts).set({ group }).where(eq(pictureStockConcepts.id, id)).returning({ id: pictureStockConcepts.id });
  return rows.length === 1;
}

/** An admin's Adults only setting for a content/pictures.yaml concept, as
 *  pictures.mjs mergeStock takes it (`adultsOverrides`). */
export interface AdultsOverride {
  id: string;
  adults: boolean;
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
