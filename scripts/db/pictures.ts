// The word game's pictures in the database (docs/DATA.md §Kids word game):
// one row per phrase (its picturable verdict, what to draw, and the file
// once drawn) and the ledger of paid calls the daily caps count. What
// decides is scripts/pictures.mjs (pure); the calls and routes are
// web/server/pictures.ts; the files scripts/picture-store.mjs.
//
// Owner scoping lives here: every query goes through forLanguageProfile.
// Nothing here locks a phrase or a card: a picture row is written outside
// any answer's transaction (an answer reads it only to check a tap), and the
// provider is called with no transaction open.
//
// Erasable TypeScript only, like practice.ts: the tests import it as is.

import { and, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { phrasePictures, pictureCalls } from "./schema.ts";

export type PictureRow = typeof phrasePictures.$inferSelect;
type Status = PictureRow["status"];

/** This language's picture rows, by phrase id. */
export async function pictureRows(db: Db, profile: LanguageProfileRef): Promise<Map<string, PictureRow>> {
  const rows = await forLanguageProfile(db, profile).list(phrasePictures);
  return new Map(rows.map((r) => [r.phraseId, r]));
}

/** One of this language's picture rows by its id, or undefined. */
export async function pictureById(db: Db, profile: LanguageProfileRef, id: string): Promise<PictureRow | undefined> {
  return forLanguageProfile(db, profile).get(phrasePictures, eq(phrasePictures.id, id));
}

/** One phrase's picture row, or undefined. */
export async function pictureOf(db: Db, profile: LanguageProfileRef, phraseId: string): Promise<PictureRow | undefined> {
  return forLanguageProfile(db, profile).get(phrasePictures, eq(phrasePictures.phraseId, phraseId));
}

/**
 * Store a picturable verdict for a phrase's words and meaning (`phraseKey`):
 * `pending` with what to draw, or `none`. Only over no row or a stale one
 * (another key): a verdict for the words as they are is never replaced, so
 * a word is judged once. Returns the row written (undefined when a current
 * one was already there, or the phrase is gone) and the file the stale row
 * held, for the caller to delete.
 */
export async function storeVerdict(
  db: Db,
  profile: LanguageProfileRef,
  v: { phraseId: string; phraseKey: string; status: "pending" | "none"; description: string | null },
): Promise<{ row?: PictureRow; oldFile: string | null }> {
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, eq(phrasePictures.phraseId, v.phraseId));
  if (before?.phraseKey === v.phraseKey) return { oldFile: null };
  try {
    if (!before) {
      const [row] = await mine.insertOrIgnore(phrasePictures, { phraseId: v.phraseId, phraseKey: v.phraseKey, status: v.status, description: v.description }, { target: [phrasePictures.phraseId] });
      return { row, oldFile: null };
    }
    // Only the stale row this call read: a verdict stored meanwhile stays.
    const [row] = await mine.update(
      phrasePictures,
      { phraseKey: v.phraseKey, status: v.status, description: v.description, file: null, contentType: null, updatedAt: sql`now()` },
      and(eq(phrasePictures.id, before.id), eq(phrasePictures.phraseKey, before.phraseKey)) as SQL,
    );
    return { row, oldFile: row ? before.file : null };
  } catch (err) {
    // The phrase went while it was judged (its foreign key): nothing to keep.
    console.warn(`[lingo-dojo] pictures: a verdict for phrase ${v.phraseId} wasn't kept:`, String((err as Error)?.message || err));
    return { oldFile: null };
  }
}

/** A drawn picture: the pending row for these words and meaning becomes
 *  ready with `file`. Undefined when it is no longer pending for them (an
 *  edit, a removal meanwhile): the caller deletes the file. */
export async function markReady(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string, file: string, contentType: string): Promise<PictureRow | undefined> {
  const [row] = await forLanguageProfile(db, profile).update(
    phrasePictures,
    { status: "ready", file, contentType, updatedAt: sql`now()` },
    and(eq(phrasePictures.phraseId, phraseId), eq(phrasePictures.phraseKey, phraseKey), eq(phrasePictures.status, "pending")) as SQL,
  );
  return row;
}

/** The provider refused the picture or gave none: `failed`, not tried
 *  again by itself (a grown-up can ask for a redraw). */
export async function markFailed(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string): Promise<void> {
  await forLanguageProfile(db, profile).update(
    phrasePictures,
    { status: "failed", updatedAt: sql`now()` },
    and(eq(phrasePictures.phraseId, phraseId), eq(phrasePictures.phraseKey, phraseKey), eq(phrasePictures.status, "pending")) as SQL,
  );
}

/**
 * A grown-up's change to a phrase's picture: `remove` (out of the game,
 * the file deleted; from ready, pending or failed) or `redraw` (pending
 * again with the same description, the old file deleted; from ready,
 * failed or removed, and only with a description to draw). Returns the row
 * after and the file it no longer holds, or a reason it can't.
 */
export async function changePicture(
  db: Db,
  profile: LanguageProfileRef,
  phraseId: string,
  phraseKey: string,
  action: "remove" | "redraw",
): Promise<{ row: PictureRow; oldFile: string | null } | { problem: "none" | "stale" | "state" }> {
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, eq(phrasePictures.phraseId, phraseId));
  if (!before) return { problem: "none" };
  if (before.phraseKey !== phraseKey) return { problem: "stale" };
  const from: Status[] = action === "remove" ? ["ready", "pending", "failed"] : ["ready", "failed", "removed"];
  if (!from.includes(before.status) || (action === "redraw" && !before.description)) return { problem: "state" };
  const [row] = await mine.update(
    phrasePictures,
    { status: action === "remove" ? "removed" : "pending", file: null, contentType: null, updatedAt: sql`now()` },
    and(eq(phrasePictures.id, before.id), eq(phrasePictures.phraseKey, phraseKey), inArray(phrasePictures.status, from)) as SQL,
  );
  if (!row) return { problem: "state" };
  return { row, oldFile: before.file };
}

/**
 * A grown-up's override of the check's "no clear picture" (ld-of0): the
 * `none` row for these words and meaning becomes pending with the
 * description they gave (cleaned by the caller: pictures.mjs
 * grownUpDescription), and is then drawn like any other pending word, under
 * the same ledger and cap. Only from `none`: a failed or removed picture
 * has Draw again. Returns the row after, or a reason it can't.
 */
export async function drawAnyway(
  db: Db,
  profile: LanguageProfileRef,
  phraseId: string,
  phraseKey: string,
  description: string,
): Promise<{ row: PictureRow } | { problem: "none" | "stale" | "state" }> {
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, eq(phrasePictures.phraseId, phraseId));
  if (!before) return { problem: "none" };
  if (before.phraseKey !== phraseKey) return { problem: "stale" };
  if (before.status !== "none") return { problem: "state" };
  const [row] = await mine.update(
    phrasePictures,
    { status: "pending", description, updatedAt: sql`now()` },
    and(eq(phrasePictures.id, before.id), eq(phrasePictures.phraseKey, phraseKey), eq(phrasePictures.status, "none")) as SQL,
  );
  return row ? { row } : { problem: "state" };
}

/**
 * Whether any picture row still names this file (ld-0dl), asked before a
 * file is deleted from disk. Across every owner on purpose, and the one
 * query here outside forLanguageProfile: a file on disk belongs to whichever
 * rows name it, and the answer is a yes/no about a random key, nothing of
 * anyone's.
 */
export async function pictureFileInUse(db: Db, file: string): Promise<boolean> {
  const [row] = await db.select({ id: phrasePictures.id }).from(phrasePictures).where(eq(phrasePictures.file, file)).limit(1);
  return !!row;
}

/** Nothing left to draw for a pending word (its description held only a
 *  learner's name, or filler: scripts/pictures.mjs cleanDescription): `none`,
 *  out of the game, as if the check had said so. */
export async function markNone(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string): Promise<void> {
  await forLanguageProfile(db, profile).update(
    phrasePictures,
    { status: "none", description: null, updatedAt: sql`now()` },
    and(eq(phrasePictures.phraseId, phraseId), eq(phrasePictures.phraseKey, phraseKey), eq(phrasePictures.status, "pending")) as SQL,
  );
}

/* ---------------------------------- ledger --------------------------------- */

/**
 * Enter a paid call in this language's ledger before it is made, so it
 * counts toward the day's cap whatever it then gives (a failure too), and
 * prune the language's entries from before `prune`. Returns its id.
 */
export async function pictureCallStarted(db: Db, profile: LanguageProfileRef, kind: "judge" | "image", words: number, prune: Date): Promise<string> {
  const mine = forLanguageProfile(db, profile);
  await mine.remove(pictureCalls, lt(pictureCalls.createdAt, prune));
  const [row] = await mine.insert(pictureCalls, { kind, words });
  return row.id;
}

/** How a call ended (diagnosis only: it counts already). */
export async function pictureCallDone(db: Db, profile: LanguageProfileRef, id: string, outcome: "ok" | "refused" | "failed"): Promise<void> {
  await forLanguageProfile(db, profile).update(pictureCalls, { outcome }, eq(pictureCalls.id, id));
}

/** Calls of `kind` this language made since `since`, from the ledger. */
export async function pictureCallsSince(db: Db, profile: LanguageProfileRef, kind: "judge" | "image", since: Date): Promise<number> {
  const mine = forLanguageProfile(db, profile);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pictureCalls)
    .where(mine.where(pictureCalls, and(eq(pictureCalls.kind, kind), gt(pictureCalls.createdAt, since)) as SQL));
  return Number(row?.n) || 0;
}
