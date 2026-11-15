// Saved packs in the database (docs/DATA.md §Packs, §Import): one learner's
// packs, folders and pack revisions. The one data layer for them, shared by
// the dev server (web/server/content.ts), the import CLI (scripts/import.mjs),
// the first run's seed (accounts.ts createFirstAdmin) and the tests.
//
// Packs used to be YAML files under content/**/packs, shared by every
// account and made undoable by a git commit per write. Now each pack is a row
// owned by a learner, and undo is `pack_revisions`: every write (create,
// update, move, rename, delete, restore, import) stores a snapshot of the
// pack in the same transaction, and a delete only sets `deleted_at`. The
// wire shape is unchanged: a pack's id is `<slug>` or `<folder>/<slug>`, the
// path its file had, so the Library and Scene tabs did not change.
//
// Concurrency. Each write runs in one transaction and locks the live row it
// changes (SELECT … FOR UPDATE), so two writes to one pack queue and the
// second sees the first's result: a delete racing a move finds the pack
// gone from its old id (404), never deletes it at the new one. The partial
// unique index (learner, folder, slug) WHERE deleted_at IS NULL is the last
// word on ids: two creates of one id end as a create and an update (PUT is
// "write this pack", as the file was), and a move or rename into a taken id
// is a 409 whether the clash was there before or arrived meanwhile.
// Folders: a write into a folder takes that folder's row lock first (an
// upsert), and a folder delete locks the row before it counts the packs in
// it, so a pack can't land in a folder as it is deleted. The folder list is
// also the union with the live packs' folders, so a pack is never hidden.
//
// Errors carry an errno-style `code` (EINVAL, ENOENT, EEXIST, ENOTEMPTY), as
// the file functions did, so the routes map them to 400/404/409.
//
// Erasable TypeScript only, like schema.ts: the CLI and the tests import it
// as is.

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
// Spelled from the repo root so it matches the typed declaration in
// web/server/mjs.d.ts (an ambient module is matched by pattern).
import { ID_RE, PACK_ID_RE, normalizePack, renamedStem, splitPackId } from "../../scripts/content.mjs";
import type { DeletedPack, Pack, PackAction, PackRevision, Problem } from "../../web/shared/wire.ts";
import { forLearner, type Db } from "./owned.ts";
import { packFolders, packRevisions, packs } from "./schema.ts";

type PackRow = typeof packs.$inferSelect;
/** A pack's content columns (everything a revision restores). */
type Content = Pick<PackRow, "title" | "created" | "scenario" | "quickScenario" | "units" | "overrides" | "notes">;

export class PackError extends Error {
  code: "EINVAL" | "ENOENT" | "EEXIST" | "ENOTEMPTY";
  constructor(code: PackError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** node-postgres puts the SQLSTATE on the error, Drizzle on its cause. */
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === "23505";
};

export const joinPackId = (folder: string, slug: string) => (folder ? `${folder}/${slug}` : slug);

/** A row as the wire's Pack. */
export function toPack(row: PackRow): Pack {
  return {
    id: joinPackId(row.folder, row.slug), folder: row.folder, title: row.title, created: row.created, scenario: row.scenario,
    quick_scenario: row.quickScenario, units: row.units, overrides: row.overrides, notes: row.notes,
  };
}

/** A pack id from a request → its folder and slug; EINVAL when it is not
 *  `<slug>` or `<folder>/<slug>` of kebab segments (one folder deep). */
export function parsePackId(id: unknown): { folder: string; slug: string } {
  if (typeof id !== "string" || !PACK_ID_RE.test(id)) {
    throw new PackError("EINVAL", `invalid id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens, with at most one folder`);
  }
  const { folder, stem } = splitPackId(id);
  return { folder, slug: stem };
}

function checkFolder(name: unknown, what = "folder name"): string {
  if (typeof name !== "string" || !ID_RE.test(name)) {
    throw new PackError("EINVAL", `invalid ${what} ${JSON.stringify(name)}: use lowercase letters, digits and hyphens`);
  }
  return name;
}

/** A pack body (JSON from the UI, or a seed file) → the content columns. The
 *  title is required; everything else is coerced the way the loader always
 *  did (normalizePack). Keys outside the contract are not kept: a row has
 *  no place for them. */
function contentOf(raw: unknown): Content {
  const p = normalizePack(raw);
  const title = p.title.trim();
  if (!title) throw new PackError("EINVAL", "a pack needs a title");
  return {
    title, created: p.created || new Date().toISOString(), scenario: p.scenario, quickScenario: p.quick_scenario, units: p.units,
    overrides: p.overrides as Record<string, unknown>, notes: p.notes,
  };
}

const liveAt = (folder: string, slug: string): SQL => and(eq(packs.folder, folder), eq(packs.slug, slug), isNull(packs.deletedAt))!;

/** The live pack at an id, locked for the rest of the transaction. */
async function lockLive(tx: Db, learnerId: string, folder: string, slug: string): Promise<PackRow | undefined> {
  const [row] = await tx.select().from(packs).where(forLearner(tx, learnerId).where(packs, liveAt(folder, slug))).for("update");
  return row;
}

async function record(tx: Db, learnerId: string, row: PackRow, action: PackAction): Promise<void> {
  await forLearner(tx, learnerId).insert(packRevisions, { packId: row.id, snapshot: toPack(row) as unknown as Record<string, unknown>, action });
}

/** Make sure a folder row exists, and hold its lock until the transaction
 *  ends (an upsert locks the row it finds), so a concurrent folder delete
 *  waits for this write and then sees the pack in it. "" is no folder. */
async function holdFolder(tx: Db, learnerId: string, name: string): Promise<void> {
  if (!name) return;
  await forLearner(tx, learnerId).upsert(packFolders, { name }, { target: [packFolders.name], set: { name: sql`excluded.name` } });
}

/** Run `fn` in a transaction; a unique violation inside it (an id taken
 *  meanwhile) becomes an EEXIST with `clash` as the message. */
async function inTx<T>(db: Db, clash: () => string, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((tx) => fn(tx as unknown as Db));
  } catch (e) {
    if (isUniqueViolation(e)) throw new PackError("EEXIST", clash());
    throw e;
  }
}

/* ---------------------------------- reads ---------------------------------- */

const byId = (a: Pack, b: Pack) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The learner's live packs (sorted by id, as the file loader sorted them)
 *  and folders: every folder row, plus any folder a live pack is in. */
export async function listPacks(db: Db, learnerId: string): Promise<{ packs: Pack[]; folders: string[] }> {
  const mine = forLearner(db, learnerId);
  const rows = await mine.list(packs, isNull(packs.deletedAt));
  const folderRows = await mine.list(packFolders);
  const folders = new Set(folderRows.map((f) => f.name));
  for (const r of rows) if (r.folder) folders.add(r.folder);
  return { packs: rows.map(toPack).sort(byId), folders: [...folders].sort() };
}

export async function listFolders(db: Db, learnerId: string): Promise<string[]> {
  return (await listPacks(db, learnerId)).folders;
}

/** The live pack at an id, or undefined. */
export async function getPack(db: Db, learnerId: string, id: string): Promise<Pack | undefined> {
  const { folder, slug } = parsePackId(id);
  const row = await forLearner(db, learnerId).get(packs, liveAt(folder, slug));
  return row && toPack(row);
}

/* --------------------------------- writes ---------------------------------- */

/**
 * PUT: write the pack at `id`, creating it or replacing its content (the id
 * is the location; an `id` or `folder` in the body is ignored, as the file
 * write ignored them). A folder the id names is created. Returns the pack as
 * stored and whether it was new.
 */
export async function savePack(db: Db, learnerId: string, id: string, body: unknown): Promise<{ pack: Pack; created: boolean }> {
  const { folder, slug } = parsePackId(id);
  const content = contentOf(body);
  return inTx(db, () => `a pack "${id}" was written at the same moment; try again`, async (tx) => {
    const mine = forLearner(tx, learnerId);
    await holdFolder(tx, learnerId, folder);
    // Twice at most: when the insert loses a race to a concurrent create of
    // the same id, that pack is committed by the time the insert returns, so
    // the second look finds it and this becomes an update of it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await lockLive(tx, learnerId, folder, slug);
      if (row) {
        const [updated] = await mine.update(packs, { ...content, updatedAt: sql`now()` }, eq(packs.id, row.id));
        await record(tx, learnerId, updated, "update");
        return { pack: toPack(updated), created: false };
      }
      // The owner is set by hand: the scope's insert can't say "nothing on
      // conflict". It is the same learner id the scope uses.
      const [inserted] = await tx
        .insert(packs)
        .values({ ...content, learnerId, folder, slug })
        .onConflictDoNothing({ target: [packs.learnerId, packs.folder, packs.slug], where: sql`${packs.deletedAt} is null` })
        .returning();
      if (inserted) {
        await record(tx, learnerId, inserted, "create");
        return { pack: toPack(inserted), created: true };
      }
    }
    throw new Error(`pack ${id} kept changing during the write`);
  });
}

/** Move the pack into `folder` ("" for the top level); returns the pack at
 *  its new id. ENOENT when there is no such pack, EEXIST when the target id
 *  is taken (nothing is overwritten by a move). Moving a pack to where it
 *  already is changes nothing and records nothing. */
export async function movePack(db: Db, learnerId: string, id: string, folder: unknown): Promise<Pack> {
  const from = parsePackId(id);
  if (typeof folder !== "string") throw new PackError("EINVAL", 'folder must be a string ("" for no folder)');
  if (folder) checkFolder(folder);
  const target = joinPackId(folder, from.slug);
  const clash = () => `a pack "${target}" already exists`;
  return inTx(db, clash, async (tx) => {
    await holdFolder(tx, learnerId, folder);
    const row = await lockLive(tx, learnerId, from.folder, from.slug);
    if (!row) throw new PackError("ENOENT", `no pack "${id}"`);
    if (folder === row.folder) return toPack(row);
    if (await forLearner(tx, learnerId).get(packs, liveAt(folder, from.slug))) throw new PackError("EEXIST", clash());
    const [moved] = await forLearner(tx, learnerId).update(packs, { folder, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, learnerId, moved, "move");
    return toPack(moved);
  });
}

/** A new title, and the slug that goes with it (renamedStem: the date kept,
 *  the folder kept). EEXIST when another pack has the new id; a title whose
 *  slug does not change only retitles. */
export async function renamePack(db: Db, learnerId: string, id: string, title: unknown): Promise<Pack> {
  const from = parsePackId(id);
  if (typeof title !== "string" || !title.trim()) throw new PackError("EINVAL", "a pack needs a title");
  let target = id;
  return inTx(db, () => `a pack "${target}" already exists`, async (tx) => {
    const mine = forLearner(tx, learnerId);
    const row = await lockLive(tx, learnerId, from.folder, from.slug);
    if (!row) throw new PackError("ENOENT", `no pack "${id}"`);
    const slug = renamedStem(row.slug, row.created, title);
    target = joinPackId(row.folder, slug);
    if (slug !== row.slug && (await mine.get(packs, liveAt(row.folder, slug)))) throw new PackError("EEXIST", `a pack "${target}" already exists`);
    const [renamed] = await mine.update(packs, { title: title.trim(), slug, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, learnerId, renamed, "rename");
    return toPack(renamed);
  });
}

/** Soft delete: the row stays (listed by listDeleted, restorable) and its id
 *  is free for a new pack. False when there is no such live pack. */
export async function deletePack(db: Db, learnerId: string, id: string): Promise<boolean> {
  const { folder, slug } = parsePackId(id);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const row = await lockLive(t, learnerId, folder, slug);
    if (!row) return false;
    // The snapshot is the content that was deleted, so restoring the delete
    // revision brings back exactly that.
    const [gone] = await forLearner(t, learnerId).update(packs, { deletedAt: sql`now()`, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(t, learnerId, gone, "delete");
    return true;
  });
}

/** A new, empty folder; EEXIST when the learner already has one by that
 *  name. Returns the learner's folders. A folder holds no content of its
 *  own, so it records no revision (pack_revisions are per pack). */
export async function createFolder(db: Db, learnerId: string, name: unknown): Promise<string[]> {
  const folder = checkFolder(name);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [made] = await t.insert(packFolders).values({ learnerId, name: folder }).onConflictDoNothing().returning();
    if (!made) throw new PackError("EEXIST", `folder "${folder}" already exists`);
    // A folder that only existed through a pack in it already "existed".
    if (await forLearner(t, learnerId).get(packs, and(eq(packs.folder, folder), isNull(packs.deletedAt))!)) {
      throw new PackError("EEXIST", `folder "${folder}" already exists`);
    }
  });
  return listFolders(db, learnerId);
}

/** Delete a folder with no live packs in it (ENOTEMPTY otherwise: a pack is
 *  never deleted as a side effect). Deleted packs that were in it keep their
 *  folder; restoring one brings the folder back. False when there was no
 *  such folder. */
export async function deleteFolder(db: Db, learnerId: string, name: unknown): Promise<boolean> {
  const folder = checkFolder(name);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const mine = forLearner(t, learnerId);
    // Lock first, then count: a write into this folder holds the same lock
    // (holdFolder), so it either finished before (and is counted) or waits
    // and recreates the folder after.
    const [row] = await t.select().from(packFolders).where(mine.where(packFolders, eq(packFolders.name, folder))).for("update");
    const [{ n }] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(packs)
      .where(mine.where(packs, and(eq(packs.folder, folder), isNull(packs.deletedAt))));
    if (n > 0) throw new PackError("ENOTEMPTY", `folder "${folder}" is not empty (${n} pack${n === 1 ? "" : "s"}); move or delete its packs first`);
    if (!row) return false;
    await mine.remove(packFolders, eq(packFolders.name, folder));
    return true;
  });
}

/* ---------------------------------- undo ----------------------------------- */

const REVISION_LIMIT = 100;
const DELETED_LIMIT = 50;

function toRevision(r: typeof packRevisions.$inferSelect): PackRevision {
  return { revision: r.id, action: r.action, at: r.at.toISOString(), pack: r.snapshot as unknown as Pack };
}

/** A live pack's revisions, newest first (the newest 100). ENOENT when there
 *  is no such pack. */
export async function listRevisions(db: Db, learnerId: string, id: string): Promise<PackRevision[]> {
  const { folder, slug } = parsePackId(id);
  const mine = forLearner(db, learnerId);
  const row = await mine.get(packs, liveAt(folder, slug));
  if (!row) throw new PackError("ENOENT", `no pack "${id}"`);
  const revs = await mine.list(packRevisions, eq(packRevisions.packId, row.id), { orderBy: desc(packRevisions.seq), limit: REVISION_LIMIT });
  return revs.map(toRevision);
}

/** The learner's soft-deleted packs, most recently deleted first (the newest
 *  50), each with the revision that deleted it. */
export async function listDeleted(db: Db, learnerId: string): Promise<DeletedPack[]> {
  const mine = forLearner(db, learnerId);
  const rows = await mine.list(packs, isNotNull(packs.deletedAt), { orderBy: [desc(packs.deletedAt), asc(packs.slug)], limit: DELETED_LIMIT });
  if (!rows.length) return [];
  const deletes = await mine.list(
    packRevisions,
    and(inArray(packRevisions.packId, rows.map((r) => r.id)), eq(packRevisions.action, "delete")),
    { orderBy: desc(packRevisions.seq) },
  );
  const latest = new Map<string, string>();
  for (const d of deletes) if (!latest.has(d.packId)) latest.set(d.packId, d.id);
  // An imported row can't be deleted without a delete revision, so every
  // row has one; a row without one is skipped rather than offered with no
  // way to restore it.
  return rows.filter((r) => latest.has(r.id)).map((r) => ({ revision: latest.get(r.id)!, deletedAt: r.deletedAt!.toISOString(), pack: toPack(r) }));
}

/**
 * Restore a revision: the pack takes that revision's content (title,
 * created, scenario, units, overrides, notes). A live pack keeps its id; a
 * deleted one comes back at the id it had, and its folder with it (EEXIST
 * when a live pack has taken that id since). The restore is a revision too,
 * so it can itself be undone. ENOENT for a revision that isn't this
 * learner's.
 */
export async function restoreRevision(db: Db, learnerId: string, revisionId: unknown): Promise<Pack> {
  if (typeof revisionId !== "string" || !UUID_RE.test(revisionId)) throw new PackError("ENOENT", "no such revision");
  let target = "";
  return inTx(db, () => `a pack "${target}" already exists; rename or move it, then restore`, async (tx) => {
    const mine = forLearner(tx, learnerId);
    const rev = await mine.get(packRevisions, eq(packRevisions.id, revisionId));
    if (!rev) throw new PackError("ENOENT", "no such revision");
    const [row] = await tx.select().from(packs).where(mine.where(packs, eq(packs.id, rev.packId))).for("update");
    target = joinPackId(row.folder, row.slug);
    const content = contentOf(rev.snapshot);
    if (row.deletedAt) {
      if (await mine.get(packs, liveAt(row.folder, row.slug))) {
        throw new PackError("EEXIST", `a pack "${target}" already exists; rename or move it, then restore`);
      }
      await holdFolder(tx, learnerId, row.folder);
    }
    const [restored] = await mine.update(packs, { ...content, deletedAt: null, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, learnerId, restored, "restore");
    return toPack(restored);
  });
}

/* --------------------------------- import ---------------------------------- */

/** A tree's pack files (scripts/content.mjs loadPackFiles). */
export interface PackFiles {
  packs: Pack[];
  folders: string[];
  problems?: Problem[];
}

export interface ImportResult {
  /** Pack ids added. */
  imported: string[];
  /** Pack ids skipped because the learner already has a pack there, live or
   *  deleted (a deleted one is not brought back by a re-run). */
  present: string[];
  /** Ids that are not valid pack ids, or packs without a title: skipped. */
  invalid: string[];
  /** Folders added (folders that already existed are not listed). */
  folders: string[];
}

/**
 * Copy file packs into a learner's packs, keeping folder, slug, title and
 * created; every folder (an empty one included) becomes a folder row. Safe
 * to re-run: a pack is skipped when the learner has any row at its folder
 * and slug, deleted ones included, so a pack deleted in the app stays
 * deleted. An emptied folder deleted in the app does come back (a folder has
 * no deleted state); it is empty, so nothing else does. One transaction:
 * all or nothing. Each imported pack gets an `import` revision.
 */
export async function importPacks(db: Db, learnerId: string, files: PackFiles): Promise<ImportResult> {
  const result: ImportResult = { imported: [], present: [], invalid: [], folders: [] };
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const mine = forLearner(t, learnerId);
    const addFolder = async (name: string) => {
      const [made] = await t.insert(packFolders).values({ learnerId, name }).onConflictDoNothing().returning();
      if (made) result.folders.push(name);
    };
    for (const name of files.folders) {
      if (ID_RE.test(name)) await addFolder(name);
    }
    for (const p of files.packs) {
      let at: { folder: string; slug: string };
      let content: Content;
      try {
        at = parsePackId(p.id);
        content = contentOf(p);
      } catch {
        result.invalid.push(String(p.id));
        continue;
      }
      if (await mine.get(packs, and(eq(packs.folder, at.folder), eq(packs.slug, at.slug))!)) {
        result.present.push(p.id);
        continue;
      }
      if (at.folder && !result.folders.includes(at.folder)) await addFolder(at.folder);
      const [row] = await t
        .insert(packs)
        .values({ ...content, learnerId, folder: at.folder, slug: at.slug })
        .onConflictDoNothing({ target: [packs.learnerId, packs.folder, packs.slug], where: sql`${packs.deletedAt} is null` })
        .returning();
      if (!row) {
        result.present.push(p.id);
        continue;
      }
      await record(t, learnerId, row, "import");
      result.imported.push(p.id);
    }
  });
  return result;
}
