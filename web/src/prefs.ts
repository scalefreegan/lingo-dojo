/* The learner's kept choices on the page (docs/DATA.md §Kept choices): read
 * from this browser's storage, written there and to the server, and brought
 * together with the server's copy when the page learns who is practising
 * (AuthGate, before the app draws). Where storage is blocked or was cleared
 * the server's copy stands in. Which choices, and the rules: web/shared/prefs.ts. */

import { getPageLearner, onBeforeSwitch, putPref, type PageLearner } from "./api.ts";
import { languageKey } from "./draft.ts";
import { PREFS, PREF_KEYS, reconcilePref, type PrefKey, type PrefMap } from "../shared/prefs.ts";

/** How long a choice may change again before it is sent (typing in the
 *  quick scene, ticking units). */
const SEND_AFTER_MS = 800;

const storageKey = (languageId: string, key: PrefKey) => languageKey(PREFS[key].base, languageId);
const timeKey = (languageId: string, key: PrefKey) => `${storageKey(languageId, key)}.at`;

// What storage would hold, for a browser that keeps none.
const memory = new Map<string, string>();

function get(k: string): string | null {
  try {
    const v = localStorage.getItem(k);
    if (v !== null) return v;
  } catch {
    /* blocked storage */
  }
  return memory.get(k) ?? null;
}

function set(k: string, v: string): void {
  memory.set(k, v);
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window, blocked or full storage: the server keeps it */
  }
}

/** Choices that were one per browser before they were per language: a
 *  language with none of its own starts from that one. */
const WAS_SHARED: readonly PrefKey[] = ["practice", "practice-speed", "practice-veil"];

/** This language's choice as it was kept, or null: the caller checks it. */
export function readPref(languageId: string, key: PrefKey): string | null {
  return get(storageKey(languageId, key)) ?? (WAS_SHARED.includes(key) ? get(PREFS[key].base) : null);
}

interface Unsent {
  page: PageLearner;
  key: PrefKey;
  value: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}
const unsent = new Map<string, Unsent>();

function send(id: string): Promise<void> {
  const u = unsent.get(id);
  if (!u) return Promise.resolve();
  clearTimeout(u.timer);
  unsent.delete(id);
  return putPref(u.page, { key: u.key, value: u.value, at: u.at });
}

const sendAll = () => Promise.all([...unsent.keys()].map(send)).then(() => undefined);

function queue(page: PageLearner, key: PrefKey, value: string, at: number): void {
  const id = storageKey(page.languageId, key);
  const was = unsent.get(id);
  if (was) clearTimeout(was.timer);
  unsent.set(id, { page, key, value, at, timer: setTimeout(() => void send(id), SEND_AFTER_MS) });
}

/** Too long to keep anywhere but here (a very long quick scene), by the
 *  server's own measure. */
const fits = (key: PrefKey, value: string) => new TextEncoder().encode(value).length <= PREFS[key].max;

/** Keep a choice for a language: here at once, on the server in a moment
 *  (while the page still shows that language). Nothing happens when it is
 *  what's kept already, so a component may call this on mount. One that
 *  can't be sent (offline) is sent the next time the page loads. */
export function keepPref(languageId: string, key: PrefKey, value: string): void {
  if (get(storageKey(languageId, key)) === value) return;
  const at = Date.now();
  set(storageKey(languageId, key), value);
  set(timeKey(languageId, key), String(at));
  const page = getPageLearner();
  if (page?.languageId === languageId && fits(key, value)) queue(page, key, value, at);
}

/** The server's copy of this language's choices has come: take what is newer
 *  there, send what is newer here. */
export function hydratePrefs(page: PageLearner, server: PrefMap): void {
  for (const key of PREF_KEYS) {
    const value = get(storageKey(page.languageId, key));
    const at = Number(get(timeKey(page.languageId, key))) || null;
    const theirs = server[key] ?? null;
    const todo = reconcilePref(PREFS[key].rule, value === null ? null : { value, at }, theirs);
    if (todo === "take" && theirs) {
      set(storageKey(page.languageId, key), theirs.value);
      set(timeKey(page.languageId, key), String(theirs.at));
    } else if (todo === "send" && value !== null && fits(key, value)) {
      // Kept before choices had a time: as old as can be, so any other
      // device's real choice outranks it.
      queue(page, key, value, at ?? 1);
    }
  }
}

if (typeof window !== "undefined") {
  // What's still waiting goes with the page (a keepalive request outlives
  // it), and before a switch, while the page's learner is still the session's.
  window.addEventListener("pagehide", () => void sendAll());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void sendAll();
  });
  onBeforeSwitch(sendAll);
}
