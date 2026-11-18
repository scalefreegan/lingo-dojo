// Which library scenes fit a session, and the random scene (docs/CONTENT.md
// "Random scene"). Pure, erasable TypeScript with no imports beyond types,
// so one copy serves everyone that needs the rule: the Scene tab (dimming a
// collection, the Random card's pool), the assembler and the export CLI
// (Node strips the types), and the server, which draws the scene when a
// session starts (web/server/conversations.ts). Two copies of "fits the
// target language" would sooner or later disagree about which scenes a
// random draw may pick.

import type { Language, RandomScene, Scenario } from "./wire.ts";

/* ------------------------------ language fit ------------------------------ */

/** The language code a scenario was written for ("es-MX" → "es"), or null
 *  for a scenario written for every language (no `language`). */
export function scenarioCode(s: Pick<Scenario, "language">): string | null {
  return s.language ? s.language.split(/[-_]/)[0].toLowerCase() : null;
}

/** The target language's code from languages.yaml ("Spanish" → "es"), or
 *  null when the target isn't listed or has no code. */
export function targetCode(languages: readonly Language[], target: string): string | null {
  return languages.find((l) => l.name === target)?.code ?? null;
}

/** Whether a scenario suits a session in `target`: it is written for every
 *  language, or for the target's own (matched on the code prefix). A target
 *  with no code in languages.yaml can't be told apart, so everything fits:
 *  the rule errs toward keeping a scene, as the Scene tab's dimming does. */
export function fitsTarget(s: Pick<Scenario, "language">, languages: readonly Language[], target: string): boolean {
  const want = targetCode(languages, target);
  const code = scenarioCode(s);
  return !want || !code || code === want;
}

/** The language a collection was written for, when that isn't the session's
 *  target: every one of its scenarios is written for another language
 *  (fitsTarget is false for all). A collection with any scenario that fits,
 *  or a target with no code in languages.yaml, is never foreign — dimming
 *  is a hint, so it errs toward not dimming. Returns the language's name for
 *  the badge ("Spanish"), or the raw code when languages.yaml doesn't list
 *  it. */
export function foreignLanguage(items: readonly Scenario[], languages: readonly Language[], target: string): string | null {
  if (!targetCode(languages, target) || items.length === 0) return null;
  if (items.some((s) => fitsTarget(s, languages, target))) return null;
  const first = scenarioCode(items[0])!;
  return languages.find((l) => l.code === first)?.name ?? first;
}

/* ------------------------------ hidden scenes ----------------------------- */

// A language profile can hide library scenes and whole collections it will
// never use (docs/DATA.md §Hidden scenes): the Scene tab stops listing them
// and a random draw stops picking them. A pack that names a hidden scene
// still plays it; hiding is a preference about what is shown, not a delete.

export type HiddenKind = "scenario" | "collection";
/** A hidden thing as the API names it: a scenario id, or a collection name
 *  ("" for the scenes in no collection, as collectionKey gives it). */
export interface HiddenRef {
  kind: HiddenKind;
  key: string;
}
/** What is hidden, as two lists (the scenario ids, the collection names). */
export interface HiddenSet {
  scenarios: readonly string[];
  collections: readonly string[];
}

/** The longest key a hide may name: scenario ids and collection names are
 *  far shorter, and the table checks the same bound. */
export const MAX_HIDDEN_KEY = 200;
/** How many hides one language may hold: far above any real library, a
 *  bound on what a page can make the table store. */
export const MAX_HIDDEN_PER_LANGUAGE = 500;

export const NOTHING_HIDDEN: HiddenSet = { scenarios: [], collections: [] };

/** A request's `{kind, key}` → the value, or why it is malformed. The key is
 *  kept exactly (it must match the library's id or name, which the loader
 *  trims, so leading or trailing spaces are refused rather than stored
 *  where nothing matches them); an unknown one is allowed, since the
 *  library can change under a stored hide. */
export function readHiddenRef(v: unknown): { value: HiddenRef } | { error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "body must be {kind, key}" };
  const { kind, key } = v as Record<string, unknown>;
  if (kind !== "scenario" && kind !== "collection") return { error: "kind must be \"scenario\" or \"collection\"" };
  if (typeof key !== "string") return { error: "key must be a string: a scenario id or a collection name" };
  if (kind === "scenario" && !key.trim()) return { error: "a scenario's key is its id, which can't be empty" };
  if (key !== key.trim()) return { error: "key can't start or end with spaces: it must match the library's id or name exactly" };
  if (key.length > MAX_HIDDEN_KEY) return { error: `key is too long (at most ${MAX_HIDDEN_KEY} characters)` };
  if (key.includes("\u0000")) return { error: "key can't contain a NUL character (\\u0000)" };
  return { value: { kind, key } };
}

/** The rows' two lists. */
export function hiddenSetOf(rows: readonly HiddenRef[]): HiddenSet {
  return {
    scenarios: rows.filter((r) => r.kind === "scenario").map((r) => r.key),
    collections: rows.filter((r) => r.kind === "collection").map((r) => r.key),
  };
}

/** Whether a scenario is hidden: itself, or its whole collection. */
export function isHiddenScene(s: Pick<Scenario, "id" | "collection">, hidden: HiddenSet): boolean {
  return hidden.scenarios.includes(s.id) || hidden.collections.includes(collectionKey(s));
}

/** The scenarios that aren't hidden, in library order; `keep` (the Scene
 *  tab's selected scene) stays even when hidden, so a draft never points
 *  at something the list no longer shows. */
export function visibleScenes<S extends Pick<Scenario, "id" | "collection">>(scenarios: readonly S[], hidden: HiddenSet, keep?: string | null): S[] {
  if (!hidden.scenarios.length && !hidden.collections.length) return [...scenarios];
  return scenarios.filter((s) => s.id === keep || !isHiddenScene(s, hidden));
}

/* ------------------------------ random scene ------------------------------ */

/** A random scene's pool may name this many collections, each at most this
 *  long: bounds on what a request may carry, far above any real library. */
export const MAX_POOL_COLLECTIONS = 50;
export const MAX_COLLECTION_NAME = 120;
/** How many of the most recent sessions' scenes a draw steers clear of (at
 *  most; always fewer than the pool, so a pool of one still draws). */
export const RECENT_SCENES = 5;

/** A scenario's collection as the pool names it: "" for one in no
 *  collection (the Scene tab's "Other scenes"). */
export const collectionKey = (s: Pick<Scenario, "collection">): string => s.collection ?? "";

/**
 * A pack's `random_scene` as a request or a file carries it → the value, or
 * the reason it is malformed. Absent, null and false are "not random"; an
 * object is random, its `collections` (absent or []: every scene that fits)
 * a list of collection names, trimmed and de-duplicated, at most
 * MAX_POOL_COLLECTIONS of at most MAX_COLLECTION_NAME characters. Other keys
 * are dropped. The server refuses a malformed one (400); the lenient readers
 * (a seed file, normalizePack) treat it as not random and warn.
 */
export function readRandomScene(v: unknown): { value: RandomScene | null } | { error: string } {
  if (v == null || v === false) return { value: null };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "random_scene must be an object like {collections: [...]}, or null" };
  const raw = (v as Record<string, unknown>).collections;
  if (raw == null) return { value: { collections: [] } };
  if (!Array.isArray(raw)) return { error: "random_scene.collections must be a list of collection names" };
  if (raw.length > MAX_POOL_COLLECTIONS) return { error: `random_scene.collections names at most ${MAX_POOL_COLLECTIONS} collections` };
  const collections: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") return { error: "random_scene.collections must hold only collection names (strings)" };
    const name = c.trim();
    // Only a literal "" names the scenes in no collection: a name of only
    // spaces is a slip, and trimming it to "" would quietly change the pool.
    if (c !== "" && name === "") return { error: "a collection name in random_scene can't be only spaces (use \"\" for scenes in no collection)" };
    if (name.length > MAX_COLLECTION_NAME) return { error: `a collection name in random_scene is too long (at most ${MAX_COLLECTION_NAME} characters)` };
    if (name.includes("\u0000")) return { error: "a collection name can't contain a NUL character (\\u0000)" };
    if (!collections.includes(name)) collections.push(name);
  }
  return { value: { collections } };
}

/**
 * The scenes a random draw picks from: every scenario that fits the target
 * language (fitsTarget), narrowed to the named collections when there are
 * any. A name no collection has any more is ignored; when the names match
 * nothing that fits, the pool is empty, which is an error for the caller to
 * show, never a quiet fallback to the whole library. Library order.
 *
 * Drills (First steps, `format: drill`) are left out while the pool has
 * any scene: a learner asking for a random scene wants a conversation, not
 * a word drill. A pool of nothing but drills (a random pack over the First
 * steps collection) keeps them, so it still draws.
 *
 * Hidden scenes (`hidden`: the language profile's hides, isHiddenScene) are
 * never in the pool, whether hidden one by one or by their collection, and
 * a collection the pool names that is hidden adds nothing.
 */
export function randomPool<S extends Pick<Scenario, "id" | "language" | "collection"> & { format?: Scenario["format"] }>(
  scenarios: readonly S[],
  languages: readonly Language[],
  target: string,
  random: RandomScene,
  hidden: HiddenSet = NOTHING_HIDDEN,
): S[] {
  const fit = scenarios.filter((s) => fitsTarget(s, languages, target) && !isHiddenScene(s, hidden));
  const named = new Set(random.collections);
  const pool = random.collections.length ? fit.filter((s) => named.has(collectionKey(s))) : fit;
  const scenes = pool.filter((s) => s.format !== "drill");
  return scenes.length ? scenes : pool;
}

/** The pool's collection names that the library no longer has (ignored by
 *  randomPool), for the Scene tab to say so. */
export function missingCollections(scenarios: readonly Pick<Scenario, "collection">[], random: RandomScene): string[] {
  const have = new Set(scenarios.map(collectionKey));
  return random.collections.filter((c) => !have.has(c));
}

/**
 * Draw one scene from `pool`, steering clear of the recent ones: `recent`
 * is the scenario ids of the latest sessions, newest first (repeats and
 * scenes outside the pool allowed). The first min(RECENT_SCENES, pool - 1)
 * distinct ones that are in the pool are left out, so a pool of one still
 * draws its scene and a pool of two alternates. `random` returns a number in
 * [0, 1), like Math.random; the server passes a crypto source, the tests a
 * fixed one. Null for an empty pool.
 */
export function drawScene<S extends Pick<Scenario, "id">>(pool: readonly S[], recent: readonly (string | null)[], random: () => number): S | null {
  if (!pool.length) return null;
  const inPool = new Set(pool.map((s) => s.id));
  const avoid: string[] = [];
  const limit = Math.min(RECENT_SCENES, pool.length - 1);
  for (const id of recent) {
    if (avoid.length >= limit) break;
    if (id && inPool.has(id) && !avoid.includes(id)) avoid.push(id);
  }
  const choices = pool.filter((s) => !avoid.includes(s.id));
  const r = random();
  const i = Math.floor((Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999999) : 0) * choices.length);
  return choices[i];
}

/**
 * A random scene's draw, start to end: the pool (randomPool, without the
 * hidden scenes), then either `keep` (a scene this session drew already,
 * kept while it is still in the pool: one hidden since is drawn afresh) or
 * a fresh draw (drawScene). Null for an empty pool.
 */
export function drawRandomScene<S extends Pick<Scenario, "id" | "language" | "collection"> & { format?: Scenario["format"] }>(
  scenarios: readonly S[],
  languages: readonly Language[],
  target: string,
  random: RandomScene,
  { recent = [], keep, rand, hidden = NOTHING_HIDDEN }: { recent?: readonly (string | null)[]; keep?: string | null; rand: () => number; hidden?: HiddenSet },
): { scene: S; pool: S[]; kept: boolean } | null {
  const pool = randomPool(scenarios, languages, target, random, hidden);
  const held = keep ? pool.find((s) => s.id === keep) : undefined;
  if (held) return { scene: held, pool, kept: true };
  const scene = drawScene(pool, recent, rand);
  return scene ? { scene, pool, kept: false } : null;
}

/** The pack a drawn scene plays: the random pack with the scenario in its
 *  place, exactly as if it had been picked (the assembler, the voice turn,
 *  the bank and the recap all see a library scenario). */
export function withDrawnScene<P extends { scenario: string; quick_scenario: string; random_scene?: RandomScene | null }>(pack: P, scenarioId: string): P {
  return { ...pack, scenario: scenarioId, quick_scenario: "", random_scene: null };
}

/** What a voice session adds to its conversation create: for a random
 *  pack, the scene the session already drew (so a later conversation of a
 *  session still open keeps it); nothing otherwise, or before any draw. */
export function keepDrawn(pack: { random_scene?: RandomScene | null }, drawn: string | null): { drawn?: string } {
  return pack.random_scene && drawn ? { drawn } : {};
}

/** The pack a voice turn sends with no conversation to save into (it
 *  couldn't be made, or Go is hidden and the last one ended): a random
 *  pack plays the scene the session drew, as a picked one, since only a
 *  conversation's snapshot tells the server which scene that is. Before
 *  any draw it stays random, and the server refuses the turn (409). */
export function unsavedTurnPack<P extends { scenario: string; quick_scenario: string; random_scene?: RandomScene | null }>(pack: P, drawn: string | null): P {
  return pack.random_scene && drawn ? withDrawnScene(pack, drawn) : pack;
}

/** "1 scene" / "12 scenes". */
export const scenesWord = (n: number) => `${n} scene${n === 1 ? "" : "s"}`;

/** Whether a pool is empty only because of hides: without them it would
 *  have a scene. emptyPoolMessage then says so. */
export function emptiedByHides<S extends Pick<Scenario, "id" | "language" | "collection"> & { format?: Scenario["format"] }>(
  scenarios: readonly S[],
  languages: readonly Language[],
  target: string,
  random: RandomScene,
  hidden: HiddenSet,
): boolean {
  return randomPool(scenarios, languages, target, random, hidden).length === 0 && randomPool(scenarios, languages, target, random).length > 0;
}

/** What an empty pool says, wherever it is caught (the Scene tab's card,
 *  Start, an export). `byHides` (emptiedByHides): only hidden scenes would
 *  fit, so the way out is restoring some. */
export function emptyPoolMessage(random: RandomScene, target: string, byHides = false): string {
  const fit = target ? `that fit ${target}` : "that fit the target language";
  if (byHides) {
    return random.collections.length
      ? `The random scene's pool is empty: every scene ${fit} in the chosen collections is hidden. Restore some from "hidden" at the bottom of the Scene tab, or choose other collections.`
      : `The random scene's pool is empty: every scene ${fit} is hidden. Restore some from "hidden" at the bottom of the Scene tab, or pick a scene instead.`;
  }
  return random.collections.length
    ? `The random scene's pool is empty: none of the chosen collections has scenes ${fit}. Choose other collections, or none for every scene.`
    : `The random scene's pool is empty: the library has no scenes ${fit}. Pick a scene instead.`;
}
