import { useSyncExternalStore } from "react";

/* Light or dark. The choice is "auto" (the system's scheme, followed live:
 * the default, and what the app did before there was a switch), "light" or
 * "dark". It is remembered per device in localStorage, not per account: a
 * dark phone at night and a bright Mac by day are the same login. The
 * resolved scheme lives on <html data-theme>, which index.css keys every
 * colour on; index.html's inline script sets it before the first paint
 * (from the same key, by the same rule as resolveTheme), so a dark page
 * never flashes light while the bundle loads. */

export type ThemeChoice = "auto" | "light" | "dark";
export type Scheme = "light" | "dark";

/** The localStorage key. index.html's inline script reads it too. */
export const THEME_KEY = "lingo-theme";
const CHOICES: readonly ThemeChoice[] = ["auto", "light", "dark"];

/** A stored value read as a choice: anything unknown (a typo, an old
 *  value, nothing) is auto, the system's scheme. */
export function readChoice(raw: unknown): ThemeChoice {
  return CHOICES.includes(raw as ThemeChoice) ? (raw as ThemeChoice) : "auto";
}

/** The scheme a choice shows, given whether the system is dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Scheme {
  return choice === "auto" ? (systemDark ? "dark" : "light") : choice;
}

/** The top bar's one-tap toggle: always to the other scheme than the one
 *  showing, as an explicit choice. Going back to following the system is
 *  the menu's Auto. */
export function toggled(showing: Scheme): ThemeChoice {
  return showing === "dark" ? "light" : "dark";
}

/* ------------------------------- the browser ------------------------------ */

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

// Storage can throw (a private window, blocked site data): the switch still
// works for the page's life, and the next load is auto.
let choice: ThemeChoice = (() => {
  try {
    return readChoice(localStorage.getItem(THEME_KEY));
  } catch {
    return "auto";
  }
})();

function apply(): void {
  document.documentElement.dataset.theme = resolveTheme(choice, systemDark());
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

if (typeof window !== "undefined") {
  apply();
  // Auto follows the system as it changes (macOS's Auto appearance at
  // dusk). An explicit choice ignores it, but the scheme is recomputed
  // either way, which is a no-op then.
  if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", apply);
  // Another tab changed it: follow, so two tabs never disagree.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY) return;
    choice = readChoice(e.newValue);
    apply();
  });
}

function setChoice(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not remembered; still applied */
  }
  apply();
}

/** The choice, the scheme showing, and the setter. */
export function useTheme(): { choice: ThemeChoice; scheme: Scheme; setChoice: (c: ThemeChoice) => void } {
  const current = useSyncExternalStore(subscribe, () => choice);
  const scheme = useSyncExternalStore(subscribe, () => resolveTheme(choice, systemDark()));
  return { choice: current, scheme, setChoice };
}
