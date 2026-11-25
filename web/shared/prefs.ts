/* The learner's choices the app keeps (docs/DATA.md §Kept choices): which
 * ones, and how a browser's copy and the server's are brought together. Pure,
 * shared by the server (web/server/prefs.ts), the page (web/src/prefs.ts) and
 * the tests. A value is text the page wrote and reads back: the server never
 * looks inside it, and every reader on the page checks it as it would
 * anything from storage. */

/** Every choice kept, by its name on the server, with the browser key's base
 *  (`<base>.language.<id>`, draft.ts languageKey) and the rule:
 *   latest    the newest choice wins, whichever device made it
 *   fallback  the server's copy only fills an empty browser: what a page is
 *             in the middle of isn't replaced by another device's */
export const PREFS = {
  draft: { base: "lingo-dojo.draft.v1", rule: "fallback", max: 32 * 1024 },
  ruby: { base: "lingo-dojo.ruby.v1", rule: "latest", max: 64 },
  "scene-filter": { base: "lingo-dojo.scene-filter.v1", rule: "latest", max: 1024 },
  "scene-folders": { base: "lingo-dojo.scene-folders.v1", rule: "latest", max: 8 * 1024 },
  practice: { base: "lingo-dojo.practice.v1", rule: "latest", max: 1024 },
  "practice-speed": { base: "lingo.practice.speed", rule: "latest", max: 64 },
  "practice-veil": { base: "lingo.practice-veil", rule: "latest", max: 64 },
  "picture-level": { base: "lingo-dojo.picture-level.v1", rule: "latest", max: 64 },
  coaching: { base: "lingo-dojo.coaching.v1", rule: "latest", max: 64 },
} as const satisfies Record<string, { base: string; rule: "latest" | "fallback"; max: number }>;

export type PrefKey = keyof typeof PREFS;
export const PREF_KEYS = Object.keys(PREFS) as PrefKey[];

export const isPrefKey = (k: unknown): k is PrefKey => typeof k === "string" && Object.prototype.hasOwnProperty.call(PREFS, k);

/** A choice as kept: its text and when it was made (ms since 1970). */
export interface Pref {
  value: string;
  at: number;
}

export type PrefMap = Partial<Record<PrefKey, Pref>>;

/** PUT /api/prefs. */
export interface PrefRequest extends Pref {
  key: PrefKey;
}

/** The body of a PUT as a choice, or why not. */
export function readPref(body: unknown): { value: PrefRequest } | { error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (!isPrefKey(b.key)) return { error: "key must be one of the app's kept choices" };
  if (typeof b.value !== "string") return { error: "value must be text" };
  if (new TextEncoder().encode(b.value).length > PREFS[b.key].max) return { error: "value is too long to keep" };
  if (typeof b.at !== "number" || !Number.isFinite(b.at) || b.at < 0) return { error: "at must be a time in milliseconds" };
  return { value: { key: b.key, value: b.value, at: Math.round(b.at) } };
}

/** What to do about one choice as the page loads: take the server's copy
 *  into the browser, send the browser's to the server, or neither. A copy
 *  kept before choices had a time counts as older than any that has one. */
export function reconcilePref(rule: "latest" | "fallback", local: { value: string; at: number | null } | null, server: Pref | null): "take" | "send" | "keep" {
  if (!local) return server ? "take" : "keep";
  if (!server) return "send";
  if (local.value === server.value) return "keep";
  if ((local.at ?? 0) > server.at) return "send";
  return rule === "latest" ? "take" : "keep";
}
