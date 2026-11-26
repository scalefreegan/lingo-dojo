// Reports of shared pictures (ld-ur3, docs/DATA.md §Picture reports): made
// by a grown-up's Draw again with a reason on a word that pointed at a stock
// concept or someone's shared drawing; read and resolved by an admin in the
// picture library. Install-wide rows like the stock tables (pictureStock.ts),
// so no forLanguageProfile: the only learner-side write is the insert, with
// the session's own user and language profile.
//
// Erasable TypeScript only, like pictures.ts: the tests import it as is.

import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "./owned.ts";
import { pictureReports } from "./schema.ts";

export type ReportReason = "wrong" | "lookalike" | "kids" | "style";
export const REPORT_REASONS: readonly ReportReason[] = ["wrong", "lookalike", "kids", "style"];
/** Reports a user may make in any 24 hours. A plain count before the
 *  insert, not under a lock: two at once may make it 21, which is harmless
 *  (the cap only keeps a stuck button from filling the admin's list). */
export const PICTURE_DAILY_REPORTS = 20;

/** Whether this user may make another report today (asked before the
 *  redraw, so a capped one changes nothing). */
export async function mayReport(db: Db, userId: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pictureReports)
    .where(and(eq(pictureReports.userId, userId), gt(pictureReports.createdAt, since)) as SQL);
  return n < PICTURE_DAILY_REPORTS;
}

/** Store a report (after the redraw it came with went through). */
export async function addPictureReport(
  db: Db,
  r: { userId: string; languageProfileId: string; conceptId: string; reason: ReportReason; note: string | null },
): Promise<string> {
  const [row] = await db.insert(pictureReports).values(r).returning({ id: pictureReports.id });
  return row.id;
}

/** Concepts with an open "not right for kids" report: kept from kids. */
export async function kidsReportedConcepts(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: pictureReports.conceptId })
    .from(pictureReports)
    .where(and(eq(pictureReports.reason, "kids"), isNull(pictureReports.resolvedAt)) as SQL)
    .orderBy(asc(pictureReports.conceptId));
  return rows.map((x) => x.id);
}

/** Every open report, oldest first (the admin's list). */
export async function openPictureReports(db: Db) {
  return db
    .select({ id: pictureReports.id, conceptId: pictureReports.conceptId, reason: pictureReports.reason, note: pictureReports.note, createdAt: pictureReports.createdAt })
    .from(pictureReports)
    .where(isNull(pictureReports.resolvedAt))
    .orderBy(asc(pictureReports.createdAt));
}

/** Resolve every open report of the concept report `id` names; how many
 *  (0: no such report, or already resolved). */
export async function resolvePictureReports(db: Db, id: string, by: string, now = new Date()): Promise<number> {
  const [one] = await db.select({ conceptId: pictureReports.conceptId }).from(pictureReports).where(eq(pictureReports.id, id));
  if (!one) return 0;
  const rows = await db
    .update(pictureReports)
    .set({ resolvedAt: now, resolvedBy: by })
    .where(and(eq(pictureReports.conceptId, one.conceptId), isNull(pictureReports.resolvedAt)) as SQL)
    .returning({ id: pictureReports.id });
  return rows.length;
}

