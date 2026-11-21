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
//   - a learner's correction or confirmation (`user`) and a recap's answer
//     (`recap`) are suggestions, each a vote of one user
//     (`shared_reading_votes`; a recap's is its conversation owner's, so a
//     learner agreeing with the recap of their own session is one vote,
//     not two: their own lines can steer that answer). One is activated
//     when two different users have voted for it and no reading is active
//     for the word yet, or when an admin confirms it (`confirm`);
//   - a user adds at most MAX_DAILY_VOTES votes a day (SharedLimitError),
//     so no one person fills the list for everyone.
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "./owned.ts";
import { sharedReadingUses, sharedReadingVotes, sharedReadings, users } from "./schema.ts";

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
  /** How many different users voted for it. */
  votes: number;
}

/** The most rows the list holds; past it, suggestions are refused (an
 *  admin clears some). Active entries are what every browser downloads. */
export const MAX_SHARED = 20_000;

/** The most votes (suggestions, confirmations, recap answers) one user
 *  adds to the list in 24 hours: far past what a learner checks by hand
 *  (a recap asks about at most 12 words), small enough that no one fills
 *  the list. */
export const MAX_DAILY_VOTES = 50;

/** Votes from this many different users activate a suggestion. */
export const VOTES_TO_ACTIVATE = 2;

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
  const votes = sql`(select count(*)::int from ${sharedReadingVotes} where ${sharedReadingVotes.sharedReadingId} = ${sharedReadings.id})`;
  const rows = await db
    .select({ row: sharedReadings, suggestedByName: sql<string | null>`${suggester}`, confirmedByName: sql<string | null>`${confirmer}`, votes: sql<number>`${votes}` })
    .from(sharedReadings)
    .orderBy(asc(sharedReadings.status), desc(sharedReadings.updatedAt))
    .limit(MAX_SHARED);
  return rows.map((r) => ({ ...r.row, votes: r.votes, suggestedByName: r.suggestedByName, confirmedByName: r.confirmedByName }));
}

/** Refused by propose: the list is full. */
export class SharedFullError extends Error {
  constructor() {
    super(`the shared readings list holds ${MAX_SHARED} entries: an admin needs to clear some first`);
    this.name = "SharedFullError";
  }
}

/** Refused by propose: this user's votes for the day are used up. */
export class SharedLimitError extends Error {
  constructor() {
    super(`at most ${MAX_DAILY_VOTES} shared-reading suggestions a day`);
    this.name = "SharedLimitError";
  }
}

/**
 * Propose `entry` (already checked: zh.ts validateCorrection) from
 * `source`: an admin's (`userId` the admin), a learner's (`userId` theirs)
 * or a recap's (`userId` the conversation's owner). Returns the row's
 * status after the rules above. A row that is already active is left as
 * it is (its `updated_at` is the browsers' cache version).
 */
export async function propose(db: Db, entry: SharedEntry, source: SharedSource, userId: string | null): Promise<SharedStatus> {
  return db.transaction(async (tx) => {
    const same = and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.reading, entry.reading));
    let [row] = await tx.select().from(sharedReadings).where(same).for("update");
    if (source === "admin") {
      if (!row) row = await insertRow(tx as unknown as Db, entry, source, userId, same);
      if (row.status === "active") return "active";
      return activate(tx as unknown as Db, row.id, entry, userId);
    }
    // A vote needs a person; without one (no owner) nothing is written.
    if (!userId) return row?.status ?? "suggested";
    const voted = row ? (await tx.select({ u: sharedReadingVotes.userId }).from(sharedReadingVotes).where(and(eq(sharedReadingVotes.sharedReadingId, row.id), eq(sharedReadingVotes.userId, userId)))).length > 0 : false;
    if (!voted) {
      const since = new Date(Date.now() - 86_400_000);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sharedReadingVotes).where(and(eq(sharedReadingVotes.userId, userId), gte(sharedReadingVotes.createdAt, since)));
      if (n >= MAX_DAILY_VOTES) throw new SharedLimitError();
    }
    if (!row) row = await insertRow(tx as unknown as Db, entry, source, userId, same);
    if (!voted) await tx.insert(sharedReadingVotes).values({ sharedReadingId: row.id, userId, source }).onConflictDoNothing();
    // Who stood behind it, for the admin view: no `updated_at` (the browsers'
    // cache version) for this.
    const flags = { byUser: row.byUser || source === "user", byRecap: row.byRecap || source === "recap" };
    if (flags.byUser !== row.byUser || flags.byRecap !== row.byRecap) await tx.update(sharedReadings).set(flags).where(eq(sharedReadings.id, row.id));
    if (row.status === "active") return "active";
    const [{ voters }] = await tx.select({ voters: sql<number>`count(distinct ${sharedReadingVotes.userId})::int` }).from(sharedReadingVotes).where(eq(sharedReadingVotes.sharedReadingId, row.id));
    if (voters >= VOTES_TO_ACTIVATE) {
      const [other] = await tx.select({ id: sharedReadings.id }).from(sharedReadings).where(and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.status, "active")));
      if (!other) {
        await tx.update(sharedReadings).set({ status: "active", updatedAt: sql`now()` }).where(eq(sharedReadings.id, row.id));
        return "active";
      }
    }
    return "suggested";
  });
}

/** A new suggested row for `entry` (the list's size checked), or the one a
 *  proposal racing this one made first. */
async function insertRow(tx: Db, entry: SharedEntry, source: SharedSource, userId: string | null, same: ReturnType<typeof and>): Promise<typeof sharedReadings.$inferSelect> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sharedReadings);
  if (n >= MAX_SHARED) throw new SharedFullError();
  const [row] = await tx.insert(sharedReadings).values({ ...entry, status: "suggested", source, suggestedBy: userId }).onConflictDoNothing().returning();
  return row ?? (await tx.select().from(sharedReadings).where(same).for("update"))[0];
}

/** Make row `id` the word's active reading, the one active before going
 *  back to suggested. */
async function activate(tx: Db, id: string, entry: Pick<SharedEntry, "key" | "scope">, adminId: string | null): Promise<SharedStatus> {
  await tx
    .update(sharedReadings)
    .set({ status: "suggested", updatedAt: sql`now()` })
    .where(and(eq(sharedReadings.key, entry.key), eq(sharedReadings.scope, entry.scope), eq(sharedReadings.status, "active"), ne(sharedReadings.id, id)));
  await tx.update(sharedReadings).set({ status: "active", confirmedBy: adminId, updatedAt: sql`now()` }).where(eq(sharedReadings.id, id));
  return "active";
}

/** An admin confirms a suggestion: it becomes the word's active reading.
 *  False when there is no such row. */
export async function confirm(db: Db, id: string, adminId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(sharedReadings).where(eq(sharedReadings.id, id)).for("update");
    if (!row) return false;
    if (row.status === "active") return true;
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
