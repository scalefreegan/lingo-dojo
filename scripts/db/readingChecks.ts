// The ledger of a kids session's background reading checks (docs/DATA.md
// §Kids: resolving uncertain readings, migration 0017, bead ld-0mn): one
// row per tool-less model call, entered as it starts, so the language's
// daily cap counts every call made (a failure too) and survives a restart.
// The answers themselves go to reading_corrections (scripts/db/readings.ts).
//
// Owner scoping lives here: every query goes through forLanguageProfile
// (scripts/db/owned.ts). Erasable TypeScript only, like schema.ts.

import { eq, gt, lt, sql } from "drizzle-orm";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { readingCheckCalls } from "./schema.ts";

/** Enter a call for `words` words before it is made, and prune this
 *  language's entries from before `prune` (older than the cap's window:
 *  nothing reads them). Returns the entry's id, for readingCheckDone. */
export async function readingCheckStarted(db: Db, profile: LanguageProfileRef, words: number, prune: Date): Promise<string> {
  const mine = forLanguageProfile(db, profile);
  await mine.remove(readingCheckCalls, lt(readingCheckCalls.createdAt, prune));
  const [row] = await mine.insert(readingCheckCalls, { words });
  return row.id;
}

/** How many words a call settled (for diagnosis). */
export async function readingCheckDone(db: Db, profile: LanguageProfileRef, id: string, settled: number): Promise<void> {
  await forLanguageProfile(db, profile).update(readingCheckCalls, { settled }, eq(readingCheckCalls.id, id));
}

/** How many calls this language made since `since`. */
export async function readingChecksSince(db: Db, profile: LanguageProfileRef, since: Date): Promise<number> {
  const mine = forLanguageProfile(db, profile);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(readingCheckCalls)
    .where(mine.where(readingCheckCalls, gt(readingCheckCalls.createdAt, since)));
  return Number(row?.n) || 0;
}
