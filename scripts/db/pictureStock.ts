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
import { pictureStockCalls, pictureStockConcepts } from "./schema.ts";

/** A concept as pictures.mjs mergeStock takes it. */
export interface CustomConcept {
  id: string;
  category: string;
  description: string;
  words: string[];
}

/** Every added concept, oldest first (the order they join their category). */
export async function customStockConcepts(db: Db): Promise<CustomConcept[]> {
  const rows = await db
    .select({ id: pictureStockConcepts.id, category: pictureStockConcepts.category, description: pictureStockConcepts.description, words: pictureStockConcepts.words })
    .from(pictureStockConcepts)
    .orderBy(asc(pictureStockConcepts.createdAt), asc(pictureStockConcepts.id));
  return rows;
}

/** Add a concept (already checked: pictures.mjs readNewConcept). False when
 *  its id was taken meanwhile. */
export async function addCustomStockConcept(db: Db, c: CustomConcept, createdBy: string): Promise<boolean> {
  const rows = await db
    .insert(pictureStockConcepts)
    .values({ id: c.id, category: c.category, description: c.description, words: c.words, createdBy })
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
