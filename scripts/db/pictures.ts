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

import { and, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { phrasePictures, pictureCalls } from "./schema.ts";

export type PictureRow = typeof phrasePictures.$inferSelect;
type Status = PictureRow["status"];

/** A word pointing at a shared stock picture (pictures.mjs stockKey). */
export interface StockPointer {
  stockId: string;
  theme: string;
  file: string;
  contentType: string;
}

/** The file a row holds of its own, for the caller to delete once no row
 *  names it: never a stock picture's key (that file is shared, and lives
 *  apart: picture-store.mjs). */
const ownFile = (row: PictureRow | undefined): string | null => (row && !row.stockId ? row.file : null);

/** What every change that takes a picture away sets: no file, no theme,
 *  no stock, nothing waiting. */
const NO_FILE = { file: null, contentType: null, theme: null, stockId: null, restyle: null } as const;

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
 * `pending` with what to draw, `none`, or `ready` pointing at a stock
 * picture (`stock`: the check matched the word to a drawn stock concept;
 * no image call, no ledger row). Only over no row or a stale one (another
 * key): a verdict for the words as they are is never replaced, so a word
 * is judged once. Returns the row written (undefined when a current one
 * was already there, or the phrase is gone) and the file of its own the
 * stale row held, for the caller to delete.
 */
export async function storeVerdict(
  db: Db,
  profile: LanguageProfileRef,
  v: { phraseId: string; phraseKey: string; status: "pending" | "none" | "ready"; description: string | null; stock?: StockPointer },
): Promise<{ row?: PictureRow; oldFile: string | null }> {
  if ((v.status === "ready") !== !!v.stock) throw new Error("a ready verdict is a stock picture's, and only it");
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, eq(phrasePictures.phraseId, v.phraseId));
  if (before?.phraseKey === v.phraseKey) return { oldFile: null };
  const values = { phraseKey: v.phraseKey, status: v.status, description: v.description, ...NO_FILE, ...(v.stock ?? {}) };
  try {
    if (!before) {
      const [row] = await mine.insertOrIgnore(phrasePictures, { phraseId: v.phraseId, ...values }, { target: [phrasePictures.phraseId] });
      return { row, oldFile: null };
    }
    // Only the stale row this call read: a verdict stored meanwhile stays.
    const [row] = await mine.update(
      phrasePictures,
      { ...values, updatedAt: sql`now()` },
      and(eq(phrasePictures.id, before.id), eq(phrasePictures.phraseKey, before.phraseKey)) as SQL,
    );
    return { row, oldFile: row ? ownFile(before) : null };
  } catch (err) {
    // The phrase went while it was judged (its foreign key): nothing to keep.
    console.warn(`[lingo-dojo] pictures: a verdict for phrase ${v.phraseId} wasn't kept:`, String((err as Error)?.message || err));
    return { oldFile: null };
  }
}

/** A drawn picture: the pending row for these words and meaning becomes
 *  ready with `file`, drawn in `theme` (pictures.mjs drawnTheme).
 *  Undefined when it is no longer pending for them (an edit, a removal
 *  meanwhile): the caller deletes the file. */
export async function markReady(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string, file: string, contentType: string, theme: string): Promise<PictureRow | undefined> {
  const [row] = await forLanguageProfile(db, profile).update(
    phrasePictures,
    { status: "ready", file, contentType, theme, stockId: null, restyle: null, updatedAt: sql`now()` },
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
    { status: action === "remove" ? "removed" : "pending", ...NO_FILE, updatedAt: sql`now()` },
    and(eq(phrasePictures.id, before.id), eq(phrasePictures.phraseKey, phraseKey), inArray(phrasePictures.status, from)) as SQL,
  );
  if (!row) return { problem: "state" };
  // A stock picture's file is shared: only the pointer goes.
  return { row, oldFile: ownFile(before) };
}

/* ------------------------------ in the theme ------------------------------ */

/**
 * A grown-up's Redraw all in the current style: these ready rows (ids, from
 * pictures.mjs restyleTargets) wait for it, `check` (ask the check whether
 * a stock picture fits first) or `draw`. Only rows still ready with nothing
 * waiting. Their picture stays in place meanwhile. Returns how many.
 */
export async function requestRestyle(db: Db, profile: LanguageProfileRef, ids: string[], restyle: "check" | "draw"): Promise<number> {
  if (!ids.length) return 0;
  const rows = await forLanguageProfile(db, profile).update(
    phrasePictures,
    { restyle, updatedAt: sql`now()` },
    and(inArray(phrasePictures.id, ids), eq(phrasePictures.status, "ready"), isNull(phrasePictures.restyle)) as SQL,
  );
  return rows.length;
}

/** The ready row waiting for its restyle (`from`), for these words. */
const waiting = (phraseId: string, phraseKey: string, from: "check" | "draw") =>
  and(eq(phrasePictures.phraseId, phraseId), eq(phrasePictures.phraseKey, phraseKey), eq(phrasePictures.status, "ready"), eq(phrasePictures.restyle, from)) as SQL;

/** The check found a stock picture for a word waiting to be restyled: it
 *  points there now (no image call). Returns the row and the file of its
 *  own it no longer holds, or undefined when it isn't waiting any more. */
export async function restyleToStock(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string, stock: StockPointer): Promise<{ row: PictureRow; oldFile: string | null } | undefined> {
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, waiting(phraseId, phraseKey, "check"));
  if (!before) return undefined;
  const [row] = await mine.update(phrasePictures, { ...stock, restyle: null, updatedAt: sql`now()` }, and(eq(phrasePictures.id, before.id), waiting(phraseId, phraseKey, "check")) as SQL);
  return row ? { row, oldFile: before.file === row.file ? null : ownFile(before) } : undefined;
}

/** No stock picture fits a word waiting to be restyled: it is drawn again. */
export async function restyleToDraw(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string): Promise<void> {
  await forLanguageProfile(db, profile).update(phrasePictures, { restyle: "draw", updatedAt: sql`now()` }, waiting(phraseId, phraseKey, "check"));
}

/** A restyled picture is drawn: the row takes the new file and theme, and
 *  gives back the old one (its own, else null) for the caller to delete.
 *  Undefined when it isn't waiting any more (an edit, a removal): the
 *  caller deletes the new file. */
export async function restyleDone(
  db: Db,
  profile: LanguageProfileRef,
  phraseId: string,
  phraseKey: string,
  pic: { file: string; contentType: string; theme: string },
): Promise<{ row: PictureRow; oldFile: string | null } | undefined> {
  const mine = forLanguageProfile(db, profile);
  const before = await mine.get(phrasePictures, waiting(phraseId, phraseKey, "draw"));
  if (!before) return undefined;
  const [row] = await mine.update(
    phrasePictures,
    { ...pic, stockId: null, restyle: null, updatedAt: sql`now()` },
    and(eq(phrasePictures.id, before.id), eq(phrasePictures.file, before.file!), waiting(phraseId, phraseKey, "draw")) as SQL,
  );
  return row ? { row, oldFile: ownFile(before) } : undefined;
}

/** The provider refused to restyle a word: it keeps its picture as it was,
 *  and nothing tries again by itself. */
export async function restyleDropped(db: Db, profile: LanguageProfileRef, phraseId: string, phraseKey: string): Promise<void> {
  await forLanguageProfile(db, profile).update(phrasePictures, { restyle: null, updatedAt: sql`now()` }, waiting(phraseId, phraseKey, "draw"));
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
