// Hidden library scenes (docs/DATA.md §Hidden scenes, migration 0009): the
// scenes and collections one language profile has hidden from its Scene tab
// and its random draws. The one data layer for them, shared by the routes
// (web/server/hidden.ts), the session start's draw (conversations.ts), the
// export (content.ts) and the tests.
//
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile (scripts/db/owned.ts), so another language's hides, of
// the same learner or any other, are neither seen nor removed. A hide is
// a preference, not a record worth keeping: unhide deletes the row, and
// hiding again inserts a new one (a repeat while hidden changes nothing).
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, asc, eq } from "drizzle-orm";
import { hiddenSetOf, type HiddenKind, type HiddenRef, type HiddenSet } from "../../web/shared/scenes.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { hiddenScenes } from "./schema.ts";

export interface HiddenRow extends HiddenRef {
  hiddenAt: Date;
}

const ref = (kind: HiddenKind, key: string) => and(eq(hiddenScenes.kind, kind), eq(hiddenScenes.key, key))!;

/** This language's hides, oldest first (the Scene tab lists them in that order). */
export async function listHidden(db: Db, profile: LanguageProfileRef): Promise<HiddenRow[]> {
  const rows = await forLanguageProfile(db, profile).list(hiddenScenes, undefined, { orderBy: [asc(hiddenScenes.hiddenAt), asc(hiddenScenes.kind), asc(hiddenScenes.key)] });
  return rows.map((r) => ({ kind: r.kind, key: r.key, hiddenAt: r.hiddenAt }));
}

/** This language's hides as the two lists the random draw filters on. */
export async function hiddenSet(db: Db, profile: LanguageProfileRef): Promise<HiddenSet> {
  return hiddenSetOf(await listHidden(db, profile));
}

/** Hide one scenario or collection; a second hide of the same one changes
 *  nothing (its first time stays). Returns the row as it stands and
 *  whether this call made it. */
export async function hideScene(db: Db, profile: LanguageProfileRef, kind: HiddenKind, key: string): Promise<{ row: HiddenRow; created: boolean }> {
  const mine = forLanguageProfile(db, profile);
  const [made] = await mine.insertOrIgnore(hiddenScenes, { kind, key }, { target: [hiddenScenes.kind, hiddenScenes.key] });
  const row = made ?? (await mine.get(hiddenScenes, ref(kind, key)));
  // Only an unhide racing this call between the two statements leaves
  // nothing; the hide then lost, as it would have a moment later.
  if (!row) return { row: { kind, key, hiddenAt: new Date() }, created: false };
  return { row: { kind: row.kind, key: row.key, hiddenAt: row.hiddenAt }, created: Boolean(made) };
}

/** Unhide: delete the row. False when this language had no such hide. */
export async function unhideScene(db: Db, profile: LanguageProfileRef, kind: HiddenKind, key: string): Promise<boolean> {
  const gone = await forLanguageProfile(db, profile).remove(hiddenScenes, ref(kind, key));
  return gone.length > 0;
}
