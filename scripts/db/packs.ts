// Saved packs in the database (docs/DATA.md §Packs, §Import): one language
// profile's packs, folders and pack revisions (a learner has one or more
// languages, and each has its own library). The one data layer for them, shared by
// the dev server (web/server/content.ts), the import CLI (scripts/import.mjs),
// the first run's seed (accounts.ts createFirstAdmin) and the tests.
//
// Packs used to be YAML files under content/**/packs, shared by every
// account and made undoable by a git commit per write. Now each pack is a row
// owned by one of a learner's language profiles, and undo is
// `pack_revisions`: every write (create, update, move, rename, delete,
// restore, import) stores a snapshot of the pack in the same transaction, and a delete only sets `deleted_at`. The
// wire shape is unchanged: a pack's id is `<slug>` or `<folder>/<slug>`, the
// path its file had, so the Library and Scene tabs did not change.
//
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile(tx, profile) (scripts/db/owned.ts), on the transaction
// it runs in, which filters on both the profile and its learner. Packs
// moved from the learner to the language profile in migration 0002; the
// routes and the UI did not change shape for it.
//
// Concurrency. Each write runs in one transaction and locks the row it
// changes (SELECT … FOR UPDATE), so two writes to one pack queue and the
// second sees the first's result: a delete racing a move finds the pack
// gone from its old id (404), never deletes it at the new one, and of two
// undeletes of one pack the second finds it live (409). The partial unique
// index (language profile, folder, slug) WHERE deleted_at IS NULL is the last word on
// ids: two creates of one id end as a create and an update (PUT is "write
// this pack", as the file was), and a move or rename into a taken id is a
// 409 whether the clash was there before or arrived meanwhile. Folders: a
// write into a folder takes that folder's row lock first (an upsert), and a
// folder delete locks the row before it counts the packs in it, so a pack
// can't land in a folder as it is deleted. The folder list is also the union
// with the live packs' folders, so a pack is never hidden.
//
// Errors carry an errno-style `code` (EINVAL, ENOENT, EEXIST, ENOTEMPTY, and
// ESTATE for "the pack is not in the state this action needs": undeleting a
// live pack, restoring a revision onto a deleted one), so the routes map
// them to 400/404/409.
//
// Erasable TypeScript only, like schema.ts: the CLI and the tests import it
// as is.

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
// Spelled from the repo root so it matches the typed declaration in
// web/server/mjs.d.ts (an ambient module is matched by pattern).
import { ID_RE, PACK_ID_RE, normalizePack, renamedStem, splitPackId } from "../../scripts/content.mjs";
import { readRandomScene } from "../../web/shared/scenes.ts";
import type { DeletedPack, Pack, PackAction, PackRevision, Problem } from "../../web/shared/wire.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { packFolders, packRevisions, packs } from "./schema.ts";

type PackRow = typeof packs.$inferSelect;
/** A pack's content columns (everything a revision restores). */
type Content = Pick<PackRow, "title" | "created" | "scenario" | "quickScenario" | "randomScene" | "units" | "overrides" | "notes">;

export class PackError extends Error {
  code: "EINVAL" | "ENOENT" | "EEXIST" | "ENOTEMPTY" | "ESTATE";
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
    quick_scenario: row.quickScenario, random_scene: row.randomScene ?? null, units: row.units, overrides: row.overrides, notes: row.notes,
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

/** A NUL anywhere in a value, keys included. Postgres refuses it in text
 *  (22021) and in jsonb strings, so it is a 400 here rather than a 500 there
 *  (and an import skips that pack rather than failing a first run). */
function hasNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k.includes("\u0000") || hasNul(x));
  return false;
}

/** A pack body (JSON from the UI, or a seed file) → the content columns. The
 *  title is required; everything else is coerced the way the loader always
 *  did (normalizePack). Keys outside the contract are not kept: a row has
 *  no place for them. */
function contentOf(raw: unknown): Content {
  const p = normalizePack(raw);
  const title = p.title.trim();
  if (!title) throw new PackError("EINVAL", "a pack needs a title");
  // A random scene is checked strictly (normalizePack reads a malformed one
  // as "not random"): a body that says random in a way that isn't
  // understood is refused, never saved as something else. A random pack
  // names no scene of its own, so the other two are cleared, not kept unused.
  const random = readRandomScene((raw as Record<string, unknown> | null)?.random_scene);
  if ("error" in random) throw new PackError("EINVAL", random.error);
  const randomScene = random.value;
  const content: Content = {
    title, created: p.created || new Date().toISOString(), scenario: randomScene ? "" : p.scenario, quickScenario: randomScene ? "" : p.quick_scenario,
    randomScene, units: p.units, overrides: p.overrides as Record<string, unknown>, notes: p.notes,
  };
  if (hasNul(content)) throw new PackError("EINVAL", "a pack can't contain a NUL character (\\u0000)");
  return content;
}

const liveAt = (folder: string, slug: string): SQL => and(eq(packs.folder, folder), eq(packs.slug, slug), isNull(packs.deletedAt))!;
/** The partial unique index: one live pack per (language profile, folder, slug). */
const LIVE_ID = { target: [packs.folder, packs.slug], targetWhere: sql`${packs.deletedAt} is null` };

/** The live pack at an id, locked for the rest of the transaction. */
async function lockLive(tx: Db, profile: LanguageProfileRef, folder: string, slug: string): Promise<PackRow | undefined> {
  const [row] = await tx.select().from(packs).where(forLanguageProfile(tx, profile).where(packs, liveAt(folder, slug))).for("update");
  return row;
}

async function record(tx: Db, profile: LanguageProfileRef, row: PackRow, action: PackAction): Promise<void> {
  await forLanguageProfile(tx, profile).insert(packRevisions, { packId: row.id, snapshot: toPack(row) as unknown as Record<string, unknown>, action });
}

/** Make sure a folder row exists, and hold its lock until the transaction
 *  ends (an upsert locks the row it finds), so a concurrent folder delete
 *  waits for this write and then sees the pack in it. "" is no folder. */
async function holdFolder(tx: Db, profile: LanguageProfileRef, name: string): Promise<void> {
  if (!name) return;
  await forLanguageProfile(tx, profile).upsert(packFolders, { name }, { target: [packFolders.name], set: { name: sql`excluded.name` } });
}

/** Run `fn` in a transaction; a unique violation inside it (an id taken
 *  meanwhile) becomes an EEXIST with `clash` as the message. */
async function inTx<T>(db: Db, clash: () => string, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((tx) => fn(tx));
  } catch (e) {
    if (isUniqueViolation(e)) throw new PackError("EEXIST", clash());
    throw e;
  }
}

async function revisionOf(tx: Db, profile: LanguageProfileRef, revisionId: unknown): Promise<typeof packRevisions.$inferSelect> {
  if (typeof revisionId !== "string" || !UUID_RE.test(revisionId)) throw new PackError("ENOENT", "no such revision");
  const rev = await forLanguageProfile(tx, profile).get(packRevisions, eq(packRevisions.id, revisionId));
  if (!rev) throw new PackError("ENOENT", "no such revision");
  return rev;
}

/** The pack a revision belongs to, not locked; ENOENT when the revision
 *  isn't this language's. */
async function peekByRevision(tx: Db, profile: LanguageProfileRef, revisionId: unknown): Promise<PackRow> {
  const rev = await revisionOf(tx, profile, revisionId);
  const row = await forLanguageProfile(tx, profile).get(packs, eq(packs.id, rev.packId));
  if (!row) throw new PackError("ENOENT", "no such revision");
  return row;
}

/** The pack a revision belongs to, locked; ENOENT when the revision isn't
 *  this language's. */
async function lockByRevision(tx: Db, profile: LanguageProfileRef, revisionId: unknown): Promise<{ rev: typeof packRevisions.$inferSelect; row: PackRow }> {
  const rev = await revisionOf(tx, profile, revisionId);
  const [row] = await tx.select().from(packs).where(forLanguageProfile(tx, profile).where(packs, eq(packs.id, rev.packId))).for("update");
  if (!row) throw new PackError("ENOENT", "no such revision");
  return { rev, row };
}

/* ---------------------------------- reads ---------------------------------- */

const byId = (a: Pack, b: Pack) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The language's live packs (sorted by id, as the file loader sorted them)
 *  and folders: every folder row, plus any folder a live pack is in. */
export async function listPacks(db: Db, profile: LanguageProfileRef): Promise<{ packs: Pack[]; folders: string[] }> {
  const mine = forLanguageProfile(db, profile);
  const rows = await mine.list(packs, isNull(packs.deletedAt));
  const folderRows = await mine.list(packFolders);
  const folders = new Set(folderRows.map((f) => f.name));
  for (const r of rows) if (r.folder) folders.add(r.folder);
  return { packs: rows.map(toPack).sort(byId), folders: [...folders].sort() };
}

export async function listFolders(db: Db, profile: LanguageProfileRef): Promise<string[]> {
  return (await listPacks(db, profile)).folders;
}

/** The live pack at an id, or undefined. */
export async function getPack(db: Db, profile: LanguageProfileRef, id: string): Promise<Pack | undefined> {
  const { folder, slug } = parsePackId(id);
  const row = await forLanguageProfile(db, profile).get(packs, liveAt(folder, slug));
  return row && toPack(row);
}

/* --------------------------------- writes ---------------------------------- */

/**
 * PUT: write the pack at `id`, creating it or replacing its content (the id
 * is the location; an `id` or `folder` in the body is ignored, as the file
 * write ignored them). A folder the id names is created. Returns the pack as
 * stored and whether it was new.
 */
export async function savePack(db: Db, profile: LanguageProfileRef, id: string, body: unknown): Promise<{ pack: Pack; created: boolean }> {
  const { folder, slug } = parsePackId(id);
  const content = contentOf(body);
  return inTx(db, () => `a pack "${id}" was written at the same moment; try again`, async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    await holdFolder(tx, profile, folder);
    // Twice at most: when the insert loses a race to a concurrent create of
    // the same id, that pack is committed by the time the insert returns, so
    // the second look finds it and this becomes an update of it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await lockLive(tx, profile, folder, slug);
      if (row) {
        const [updated] = await mine.update(packs, { ...content, updatedAt: sql`now()` }, eq(packs.id, row.id));
        await record(tx, profile, updated, "update");
        return { pack: toPack(updated), created: false };
      }
      const [inserted] = await mine.insertOrIgnore(packs, { ...content, folder, slug }, LIVE_ID);
      if (inserted) {
        await record(tx, profile, inserted, "create");
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
export async function movePack(db: Db, profile: LanguageProfileRef, id: string, folder: unknown): Promise<Pack> {
  const from = parsePackId(id);
  if (typeof folder !== "string") throw new PackError("EINVAL", 'folder must be a string ("" for no folder)');
  if (folder) checkFolder(folder);
  const target = joinPackId(folder, from.slug);
  const clash = () => `a pack "${target}" already exists`;
  return inTx(db, clash, async (tx) => {
    await holdFolder(tx, profile, folder);
    const row = await lockLive(tx, profile, from.folder, from.slug);
    if (!row) throw new PackError("ENOENT", `no pack "${id}"`);
    if (folder === row.folder) return toPack(row);
    if (await forLanguageProfile(tx, profile).get(packs, liveAt(folder, from.slug))) throw new PackError("EEXIST", clash());
    const [moved] = await forLanguageProfile(tx, profile).update(packs, { folder, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, profile, moved, "move");
    return toPack(moved);
  });
}

/** A new title, and the slug that goes with it (renamedStem: the date kept,
 *  the folder kept). EEXIST when another pack has the new id; a title whose
 *  slug does not change only retitles. */
export async function renamePack(db: Db, profile: LanguageProfileRef, id: string, title: unknown): Promise<Pack> {
  const from = parsePackId(id);
  if (typeof title !== "string" || !title.trim()) throw new PackError("EINVAL", "a pack needs a title");
  if (hasNul(title)) throw new PackError("EINVAL", "a title can't contain a NUL character (\\u0000)");
  let target = id;
  return inTx(db, () => `a pack "${target}" already exists`, async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const row = await lockLive(tx, profile, from.folder, from.slug);
    if (!row) throw new PackError("ENOENT", `no pack "${id}"`);
    const slug = renamedStem(row.slug, row.created, title);
    target = joinPackId(row.folder, slug);
    if (slug !== row.slug && (await mine.get(packs, liveAt(row.folder, slug)))) throw new PackError("EEXIST", `a pack "${target}" already exists`);
    const [renamed] = await mine.update(packs, { title: title.trim(), slug, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, profile, renamed, "rename");
    return toPack(renamed);
  });
}

/** Soft delete: the row stays (listed by listDeleted, undeletable) and its id
 *  is free for a new pack. False when there is no such live pack. */
export async function deletePack(db: Db, profile: LanguageProfileRef, id: string): Promise<boolean> {
  const { folder, slug } = parsePackId(id);
  return db.transaction(async (tx) => {
    const row = await lockLive(tx, profile, folder, slug);
    if (!row) return false;
    // The snapshot is the content that was deleted, which an undelete keeps.
    const [gone] = await forLanguageProfile(tx, profile).update(packs, { deletedAt: sql`now()`, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, profile, gone, "delete");
    return true;
  });
}

/** A new, empty folder; EEXIST when the language already has one by that
 *  name. Returns its folders. A folder holds no content of its
 *  own, so it records no revision (pack_revisions are per pack). */
export async function createFolder(db: Db, profile: LanguageProfileRef, name: unknown): Promise<string[]> {
  const folder = checkFolder(name);
  await db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const [made] = await mine.insertOrIgnore(packFolders, { name: folder });
    if (!made) throw new PackError("EEXIST", `folder "${folder}" already exists`);
    // A folder that only existed through a pack in it already "existed".
    if (await mine.get(packs, and(eq(packs.folder, folder), isNull(packs.deletedAt))!)) {
      throw new PackError("EEXIST", `folder "${folder}" already exists`);
    }
  });
  return listFolders(db, profile);
}

/** Delete a folder with no live packs in it (ENOTEMPTY otherwise: a pack is
 *  never deleted as a side effect). Deleted packs that were in it keep their
 *  folder; undeleting one brings the folder back. False when there was no
 *  such folder. */
export async function deleteFolder(db: Db, profile: LanguageProfileRef, name: unknown): Promise<boolean> {
  const folder = checkFolder(name);
  return db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    // Lock first, then count: a write into this folder holds the same lock
    // (holdFolder), so it either finished before (and is counted) or waits
    // and recreates the folder after.
    const [row] = await tx.select().from(packFolders).where(mine.where(packFolders, eq(packFolders.name, folder))).for("update");
    const [{ n }] = await tx
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

export const REVISION_PAGE = 100;
export const DELETED_PAGE = 50;

/** A page: the items and the offset of the next page (null after the last). */
export interface Page<T> {
  items: T[];
  next: number | null;
}

function offsetOf(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new PackError("EINVAL", "offset must be a whole number ≥ 0");
  return n;
}

function toRevision(r: typeof packRevisions.$inferSelect): PackRevision {
  return { revision: r.id, action: r.action, at: r.at.toISOString(), pack: r.snapshot as unknown as Pack };
}

/**
 * A pack's revisions, newest first, a page at a time (renames and moves
 * keep the history: they are the same row). The pack is named by `id` — the
 * live pack there, else the most recently deleted one that had it — or by
 * `revision`, any revision of it (which reaches an older deleted pack at an
 * id that has been reused since). ENOENT when there is no such pack.
 */
export async function listRevisions(
  db: Db,
  profile: LanguageProfileRef,
  which: { id?: string; revision?: string },
  page: { offset?: unknown; limit?: number } = {},
): Promise<Page<PackRevision>> {
  const mine = forLanguageProfile(db, profile);
  let packId: string | undefined;
  if (which.revision !== undefined) {
    if (!UUID_RE.test(which.revision)) throw new PackError("ENOENT", "no such revision");
    packId = (await mine.get(packRevisions, eq(packRevisions.id, which.revision)))?.packId;
    if (!packId) throw new PackError("ENOENT", "no such revision");
  } else {
    const { folder, slug } = parsePackId(which.id);
    const [row] = await mine.list(packs, and(eq(packs.folder, folder), eq(packs.slug, slug)), {
      // The live row first (deleted_at null sorts first descending), then the newest delete.
      orderBy: [sql`${packs.deletedAt} desc nulls first`],
      limit: 1,
    });
    if (!row) throw new PackError("ENOENT", `no pack "${which.id}"`);
    packId = row.id;
  }
  const offset = offsetOf(page.offset);
  const limit = page.limit ?? REVISION_PAGE;
  const revs = await db
    .select()
    .from(packRevisions)
    .where(mine.where(packRevisions, eq(packRevisions.packId, packId)))
    .orderBy(desc(packRevisions.seq))
    .limit(limit + 1)
    .offset(offset);
  return { items: revs.slice(0, limit).map(toRevision), next: revs.length > limit ? offset + limit : null };
}

/** The language's soft-deleted packs, most recently deleted first, a page at
 *  a time, each with the revision that deleted it (what undeletePack takes). */
export async function listDeleted(db: Db, profile: LanguageProfileRef, page: { offset?: unknown; limit?: number } = {}): Promise<Page<DeletedPack>> {
  const mine = forLanguageProfile(db, profile);
  const offset = offsetOf(page.offset);
  const limit = page.limit ?? DELETED_PAGE;
  const rows = await db
    .select()
    .from(packs)
    .where(mine.where(packs, isNotNull(packs.deletedAt)))
    .orderBy(desc(packs.deletedAt), asc(packs.id))
    .limit(limit + 1)
    .offset(offset);
  const next = rows.length > limit ? offset + limit : null;
  const shown = rows.slice(0, limit);
  if (!shown.length) return { items: [], next };
  const deletes = await mine.list(
    packRevisions,
    and(inArray(packRevisions.packId, shown.map((r) => r.id)), eq(packRevisions.action, "delete")),
    { orderBy: desc(packRevisions.seq) },
  );
  const latest = new Map<string, string>();
  for (const d of deletes) if (!latest.has(d.packId)) latest.set(d.packId, d.id);
  // Every deleted row has a delete revision (deletePack writes both); a row
  // without one could not be undeleted, so it is not offered.
  const items = shown.filter((r) => latest.has(r.id)).map((r) => ({ revision: latest.get(r.id)!, deletedAt: r.deletedAt!.toISOString(), pack: toPack(r) }));
  return { items, next };
}

/**
 * Undelete: the deleted pack a revision belongs to comes back, as it was
 * deleted, at the id it had, with its folder. ESTATE when it is not deleted
 * (any more): a second click, or another device's stale list, must not
 * touch a live pack. EEXIST when a live pack has taken the id since (move or
 * rename it first). Recorded as a `restore` revision.
 */
export async function undeletePack(db: Db, profile: LanguageProfileRef, revisionId: unknown): Promise<Pack> {
  let target = "";
  return inTx(db, () => `a pack "${target}" already exists; rename or move it, then restore`, async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    // The folder lock before the pack's, the order every write into a folder
    // takes them in. A deleted row's folder can't change (only a live pack
    // moves), so the unlocked peek names the right folder.
    const peek = await peekByRevision(tx, profile, revisionId);
    await holdFolder(tx, profile, peek.deletedAt ? peek.folder : "");
    const { row } = await lockByRevision(tx, profile, revisionId);
    target = joinPackId(row.folder, row.slug);
    if (!row.deletedAt) throw new PackError("ESTATE", `"${target}" is not deleted (it was restored already)`);
    if (await mine.get(packs, liveAt(row.folder, row.slug))) {
      throw new PackError("EEXIST", `a pack "${target}" already exists; rename or move it, then restore`);
    }
    const [back] = await mine.update(packs, { deletedAt: null, updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, profile, back, "restore");
    return toPack(back);
  });
}

/**
 * Restore a revision onto a live pack: it takes that revision's content
 * (title, created, scenario, units, overrides, notes) and keeps its id. The
 * restore is a revision too, so it can itself be undone. ESTATE when the
 * pack is deleted (undeletePack is that action; this one never brings a
 * pack back), ENOENT for a revision that isn't this language's.
 */
export async function restoreRevision(db: Db, profile: LanguageProfileRef, revisionId: unknown): Promise<Pack> {
  return db.transaction(async (tx) => {
    const { rev, row } = await lockByRevision(tx, profile, revisionId);
    if (row.deletedAt) throw new PackError("ESTATE", `"${joinPackId(row.folder, row.slug)}" is deleted; restore it from Recently deleted first`);
    const [restored] = await forLanguageProfile(tx, profile).update(packs, { ...contentOf(rev.snapshot), updatedAt: sql`now()` }, eq(packs.id, row.id));
    await record(tx, profile, restored, "restore");
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
  /** Pack ids skipped as imported before: the language has a pack at that id
   *  (live or deleted), or an `import` revision of it, wherever that pack
   *  lives now (renamed, moved, deleted). */
  present: string[];
  /** Ids that are not valid pack ids, or packs without a title or with a NUL
   *  character: skipped. */
  invalid: string[];
  /** Packs the database refused for another reason: skipped, the rest still
   *  imported, the error logged. */
  failed: string[];
  /** Folders added (folders that already existed are not listed). */
  folders: string[];
}

/**
 * Copy file packs into one language profile's packs, keeping folder, slug,
 * title and created; every folder (an empty one included) becomes a folder
 * row. Safe to re-run, per profile: a pack is skipped when it was imported
 * into this profile before (an `import` revision whose snapshot has its id,
 * wherever the pack lives now) or the profile has any row at its folder and
 * slug, deleted ones included, so a
 * renamed, moved or deleted seed pack is never imported twice. An emptied
 * folder deleted in the app does come back (a folder has no deleted state);
 * it is empty, so nothing else does. Each pack is its own savepoint, so one
 * bad pack is skipped (and logged) without undoing the others or poisoning
 * the caller's transaction: a first run is never blocked by a seed file.
 */
export async function importPacks(db: Db, profile: LanguageProfileRef, files: PackFiles): Promise<ImportResult> {
  const result: ImportResult = { imported: [], present: [], invalid: [], failed: [], folders: [] };
  await db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    for (const name of files.folders) {
      if (!ID_RE.test(name) || result.folders.includes(name)) continue;
      const [made] = await mine.insertOrIgnore(packFolders, { name });
      if (made) result.folders.push(name);
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
      const atId = await mine.get(packs, and(eq(packs.folder, at.folder), eq(packs.slug, at.slug))!);
      // Imported before into any of this learner's languages, not only this
      // one: the seed packs are the learner's once, so a re-run after the
      // learner took up another language adds nothing there. The one query
      // here not through a profile scope (forLearner refuses
      // pack_revisions), so it names the learner itself.
      const [importedBefore] = await tx
        .select({ id: packRevisions.id })
        .from(packRevisions)
        .where(and(eq(packRevisions.learnerId, profile.learnerId), eq(packRevisions.action, "import"), sql`${packRevisions.snapshot}->>'id' = ${p.id}`))
        .limit(1);
      if (atId || importedBefore) {
        result.present.push(p.id);
        continue;
      }
      try {
        // The pack's folder in the same savepoint, so a refused pack leaves
        // no folder behind (and reports none).
        const { row, folderMade } = await tx.transaction(async (sp) => {
          const sm = forLanguageProfile(sp, profile);
          const madeFolder = at.folder && !result.folders.includes(at.folder) ? (await sm.insertOrIgnore(packFolders, { name: at.folder })).length > 0 : false;
          const [inserted] = await sm.insertOrIgnore(packs, { ...content, folder: at.folder, slug: at.slug }, LIVE_ID);
          if (inserted) await record(sp, profile, inserted, "import");
          return { row: inserted, folderMade: madeFolder };
        });
        if (folderMade) result.folders.push(at.folder);
        if (row) result.imported.push(p.id);
        else result.present.push(p.id);
      } catch (e) {
        console.error(`[lingo-dojo] import: pack ${p.id} skipped:`, (e as Error)?.message ?? e);
        result.failed.push(p.id);
      }
    }
  });
  return result;
}
