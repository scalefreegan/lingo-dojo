// The shared list of Mandarin readings (docs/DATA.md §Shared readings,
// migration 0015, bead ld-4i2): install-wide whole-word readings every
// learner's reader applies once active. The one data layer for it (the
// routes in web/server/readings.ts, the recap, the tests).
//
// Not personal: words, readings and a scope. The rows are never read
// through owned.ts because they have no owner; `suggested_by` and
// `confirmed_by` (user ids) leave this file only for the admin view
// (adminList), never in what a learner's browser gets (activeList,
// exportActive).
//
// How an entry becomes active (the rules of `propose`):
//   - an admin's correction is active at once, and the reading that was
//     active for the word before goes back to suggested;
//   - a learner's correction (`user`) and the recap's (`recap`) are
//     suggestions; one is activated when both have proposed the same
//     reading and no reading is active for the word yet, or when an admin
//     confirms it (`confirm`).
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "./owned.ts";
import { sharedReadingUses, sharedReadings, users } from "./schema.ts";

export type SharedSource = "admin" | "user" | "recap";
export type SharedStatus = "active" | "suggested";

export interface SharedEntry {
  word: string;
  key: string;
  reading: string;
  scope: "all" | "tw";
}

export interface SharedAdminRow extends SharedEntry {
  id: string;
  status: SharedStatus;
  source: SharedSource;
  byUser: boolean;
  byRecap: boolean;
  suggestedBy: string | null;
  confirmedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The most rows the list holds; past it, suggestions are refused (an
 *  admin clears some). Active entries are what every browser downloads. */
export const MAX_SHARED = 20_000;

/** Active entries, word order, for every browser (word, key, reading,
 *  scope only) and `version`: changes whenever the active list does (the
 *  browser's cache key). */
export async function activeList(db: Db): Promise<{ version: string; entries: SharedEntry[] }> {
  const rows = await db
    .select({ word: sharedReadings.word, key: sharedReadings.key, reading: sharedReadings.reading, scope: sharedReadings.scope, updatedAt: sharedReadings.updatedAt })
    .from(sharedReadings)
    .where(eq(sharedReadings.status, "active"))
    .orderBy(asc(sharedReadings.key), asc(sharedReadings.scope));
  const newest = rows.reduce((m, r) => Math.max(m, r.updatedAt.getTime()), 0);
  return { version: `${rows.length}.${newest}`, entries: rows.map(({ word, key, reading, scope }) => ({ word, key, reading, scope })) };
}

/** Every row, for the admin view: active first, then the newest. */
export async function adminList(db: Db): Promise<(SharedAdminRow & { suggestedByName: string | null; confirmedByName: string | null })[]> {
  const suggester = sql`(select ${users.username} from ${users} where ${users.id} = ${sharedReadings.suggestedBy})`;
  const confirmer = sql`(select ${users.username} from ${users} where ${users.id} = ${sharedReadings.confirmedBy})`;
  const rows = await db
    .select({ row: sharedReadings, suggestedByName: sql<string | null>`${suggester}`, confirmedByName: sql<string | null>`${confirmer}` })
    .from(sharedReadings)
    .orderBy(asc(sharedReadings.status), desc(sharedReadings.updatedAt))
    .limit(MAX_SHARED);
  return rows.map((r) => ({ ...r.row, suggestedByName: r.suggestedByName, confirmedByName: r.confirmedByName }));
}

/** Refused by propose: the list is full. */
export class SharedFullError extends Error {
  constructor() {
    super(`the shared readings list holds ${MAX_SHARED} entries: an admin needs to clear some first`);
    this.name = "SharedFullError";
  }
}

/**
 * Propose `entry` (already checked: zh.ts validateCorrection) from
 * `source`. Returns the row's status after the rules above.
 */
export async function propose(db: Db, entry: SharedEntry, source: SharedSource, userId: string | null): Promise<SharedStatus> {
  return db.transaction(async (tx) => {
    const same = and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.reading, entry.reading));
    let [row] = await tx.select().from(sharedReadings).where(same).for("update");
    if (!row) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sharedReadings);
      if (n >= MAX_SHARED) throw new SharedFullError();
      [row] = await tx
        .insert(sharedReadings)
        .values({ ...entry, status: "suggested", source, suggestedBy: source === "recap" ? null : userId })
        .onConflictDoNothing()
        .returning();
      // A proposal racing this one made it first: take that row.
      row ??= (await tx.select().from(sharedReadings).where(same).for("update"))[0];
    }
    const flags = { byUser: row.byUser || source === "user", byRecap: row.byRecap || source === "recap" };
    if (source === "admin") return activate(tx as unknown as Db, row.id, entry, userId, flags);
    await tx.update(sharedReadings).set({ ...flags, suggestedBy: row.suggestedBy ?? (source === "user" ? userId : null), updatedAt: sql`now()` }).where(eq(sharedReadings.id, row.id));
    if (row.status === "active") return "active";
    if (flags.byUser && flags.byRecap) {
      const [other] = await tx.select({ id: sharedReadings.id }).from(sharedReadings).where(and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.status, "active")));
      if (!other) {
        await tx.update(sharedReadings).set({ status: "active", updatedAt: sql`now()` }).where(eq(sharedReadings.id, row.id));
        return "active";
      }
    }
    return "suggested";
  });
}

/** Make row `id` the word's active reading, the one active before going
 *  back to suggested. */
async function activate(tx: Db, id: string, entry: Pick<SharedEntry, "key" | "scope">, adminId: string | null, flags: { byUser?: boolean; byRecap?: boolean } = {}): Promise<SharedStatus> {
  await tx
    .update(sharedReadings)
    .set({ status: "suggested", updatedAt: sql`now()` })
    .where(and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.status, "active"), ne(sharedReadings.id, id)));
  await tx.update(sharedReadings).set({ ...flags, status: "active", confirmedBy: adminId, updatedAt: sql`now()` }).where(eq(sharedReadings.id, id));
  return "active";
}

/** An admin confirms a suggestion: it becomes the word's active reading.
 *  False when there is no such row. */
export async function confirm(db: Db, id: string, adminId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(sharedReadings).where(eq(sharedReadings.id, id)).for("update");
    if (!row) return false;
    await activate(tx as unknown as Db, row.id, row, adminId);
    return true;
  });
}

/** An admin removes a row (active or not). False when there was none. */
export async function remove(db: Db, id: string): Promise<boolean> {
  const gone = await db.delete(sharedReadings).where(eq(sharedReadings.id, id)).returning({ id: sharedReadings.id });
  return gone.length > 0;
}

/** The active entries as the export writes them: words and readings, the
 *  word's other spelling (its key), the scope. Nothing about who. */
export async function exportActive(db: Db): Promise<SharedEntry[]> {
  return (await activeList(db)).entries;
}

/** How many readings the list changed in one session (the recap counts
 *  them); a recap made again replaces its count. */
export async function recordUses(db: Db, conversationId: string, changed: number): Promise<void> {
  await db
    .insert(sharedReadingUses)
    .values({ conversationId, changed })
    .onConflictDoUpdate({ target: sharedReadingUses.conversationId, set: { changed, countedAt: sql`now()` } });
}

/** Readings the list changed in the sessions recapped in the last `days` days. */
export async function usesSince(db: Db, days: number): Promise<{ changed: number; sessions: number }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [r] = await db
    .select({ changed: sql<number>`coalesce(sum(${sharedReadingUses.changed}), 0)::int`, sessions: sql<number>`count(*)::int` })
    .from(sharedReadingUses)
    .where(gte(sharedReadingUses.countedAt, since));
  return { changed: r?.changed ?? 0, sessions: r?.sessions ?? 0 };
}
