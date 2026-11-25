// The learner's kept choices (docs/DATA.md §Kept choices, migration 0023):
// one row per language profile and choice. The one data layer for them.
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile (scripts/db/owned.ts), so another language's choices,
// of the same learner or any other, are neither seen nor changed.
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, eq, lt } from "drizzle-orm";
import { isPrefKey, type PrefMap, type PrefRequest } from "../../web/shared/prefs.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { languagePrefs } from "./schema.ts";

/** This language's kept choices. A key the app no longer knows is left out. */
export async function listPrefs(db: Db, profile: LanguageProfileRef): Promise<PrefMap> {
  const out: PrefMap = {};
  for (const r of await forLanguageProfile(db, profile).list(languagePrefs)) {
    if (isPrefKey(r.key)) out[r.key] = { value: r.value, at: r.changedAt.getTime() };
  }
  return out;
}

/** Keep one choice, unless one made later is kept already (a slow request,
 *  another device): false then. A time ahead of the server's clock counts as
 *  now, so one device with a wrong clock can't hold a choice for good. */
export async function savePref(db: Db, profile: LanguageProfileRef, p: PrefRequest, now = Date.now()): Promise<boolean> {
  const mine = forLanguageProfile(db, profile);
  const changedAt = new Date(Math.min(p.at, now));
  const newer = and(eq(languagePrefs.key, p.key), lt(languagePrefs.changedAt, changedAt))!;
  const set = { value: p.value, changedAt };
  if ((await mine.update(languagePrefs, set, newer)).length) return true;
  if ((await mine.insertOrIgnore(languagePrefs, { key: p.key, ...set }, { target: [languagePrefs.key] })).length) return true;
  // Another request's insert landed between the two: this one may be newer.
  return (await mine.update(languagePrefs, set, newer)).length > 0;
}
