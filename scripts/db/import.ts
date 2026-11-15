// The file → database pack import (docs/DATA.md §Import), behind
// `npm run db:import` (scripts/import.mjs). Its own module, apart from the
// CLI's argv and printing, so the tests run it on PGlite.
//
// Which account: the one named (refused when it is disabled: its packs
// would land where nobody can log in to see them), else the first admin
// (oldest, not disabled). Which learner: that account's first live learner of each mode
// (listLearners' order). Nothing is created: with no such account or
// learner, that part is skipped and the report says why. The import itself
// is packs.ts importPacks, which skips any pack the learner already has at
// that id (deleted ones included) or imported before (wherever it lives
// now), so a re-run adds only what is new.
//
// Erasable TypeScript only: the CLI and the tests import it as is.

import { and, asc, eq, isNull } from "drizzle-orm";
import { findUserByUsername, listLearners, type User } from "./accounts.ts";
import type { Db } from "./owned.ts";
import { importPacks, type ImportResult, type PackFiles } from "./packs.ts";
import { users } from "./schema.ts";

export type ImportMode = "adult" | "kids";

export interface ModeReport {
  mode: ImportMode;
  /** The learner the packs went to; null when the account has none of this
   *  mode (then `skipped` says so and nothing was imported). */
  learner: { id: string; name: string } | null;
  skipped?: string;
  result?: ImportResult;
  /** Pack files that did not load (bad YAML, no title): never imported. */
  unreadable: { file: string; message: string }[];
}

export interface ImportReport {
  user: { id: string; username: string; isAdmin: boolean };
  modes: ModeReport[];
}

/** The account to import into: `username` (already normalized; not a
 *  disabled one), else the oldest admin that is not disabled. Throws a
 *  sentence when there is none. */
async function targetUser(db: Db, username?: string): Promise<User> {
  if (username) {
    const u = await findUserByUsername(db, username);
    if (!u) throw new Error(`no account named ${username}`);
    if (u.disabledAt) throw new Error(`account ${username} is disabled; \`npm run user -- enable ${username}\` first, or name another account`);
    return u;
  }
  const [admin] = await db.select().from(users).where(and(eq(users.isAdmin, true), isNull(users.disabledAt))).orderBy(asc(users.createdAt), asc(users.username)).limit(1);
  if (!admin) {
    throw new Error("no admin account yet: create one with the app's first-run screen (which imports the packs itself) or `npm run user -- add <name> --admin`");
  }
  return admin;
}

export async function importFilePacks(db: Db, opts: { username?: string; files: Record<ImportMode, PackFiles> }): Promise<ImportReport> {
  const user = await targetUser(db, opts.username);
  const learners = await listLearners(db, user.id);
  const modes: ModeReport[] = [];
  for (const mode of ["adult", "kids"] as const) {
    const files = opts.files[mode];
    const unreadable = (files.problems ?? []).filter((p) => p.level === "error").map((p) => ({ file: p.file, message: p.message }));
    const learner = learners.find((l) => l.mode === mode);
    if (!learner) {
      modes.push({ mode, learner: null, skipped: `${user.username} has no ${mode} learner (add one in the app, then re-run)`, unreadable });
      continue;
    }
    const result = await importPacks(db, learner.id, files);
    modes.push({ mode, learner: { id: learner.id, name: learner.name }, result, unreadable });
  }
  return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin }, modes };
}

/** The report as the CLI prints it, one line per pack:
 *
 *    packs → robin (admin)
 *    adult (content/packs/) → Sam: 1 imported, 1 already there, 1 folder added
 *      + oaxaca/2026-10-20-mezcal
 *      = 2026-10-19-market-gentle (already there)
 *      + folder oaxaca
 *    kids (content/kids/packs/): skipped, robin has no kids learner (add one in the app, then re-run)
 */
export function formatImportReport(report: ImportReport, trees: Record<ImportMode, string>): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const out = [`packs → ${report.user.username}${report.user.isAdmin ? " (admin)" : ""}`];
  for (const m of report.modes) {
    if (!m.learner || !m.result) {
      out.push(`${m.mode} (${trees[m.mode]}): skipped, ${m.skipped}`);
      continue;
    }
    const r = m.result;
    const parts = [`${r.imported.length} imported`, `${r.present.length} already there`, n(r.folders.length, "folder added", "folders added")];
    if (r.invalid.length) parts.push(`${r.invalid.length} invalid`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    if (m.unreadable.length) parts.push(n(m.unreadable.length, "unreadable file"));
    out.push(`${m.mode} (${trees[m.mode]}) → ${m.learner.name}: ${parts.join(", ")}`);
    for (const id of r.imported) out.push(`  + ${id}`);
    for (const id of r.present) out.push(`  = ${id} (already there)`);
    for (const f of r.folders) out.push(`  + folder ${f}`);
    for (const id of r.invalid) out.push(`  ! ${id}: not a valid pack id, no title, or a NUL character; skipped`);
    for (const id of r.failed) out.push(`  ! ${id}: the database refused it (logged above); skipped`);
    for (const u of m.unreadable) out.push(`  ! ${u.file}: ${u.message}; skipped`);
  }
  return out;
}
