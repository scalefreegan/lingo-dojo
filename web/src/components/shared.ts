/* UI-only types shared between App and the tabs — not wire shapes (see
 * ../types.ts's own comment not to declare those twice), just the small
 * contracts between App's pack actions/status and the tabs that use them. */
import type { Pack } from "../types";

export type Tab = "scene" | "customize" | "go" | "library";

export type SaveOutcome = { ok: true; id: string } | { ok: false; conflict: string } | { ok: false; error: string };

/** The one-line outcome of the last pack action, shown on the Go tab. */
export type PackStatus = { tone: "ok" | "err"; text: string };

/** Each resolves to whether it succeeded, so an inline form (rename) knows
 *  whether to close. */
export interface PackActions {
  onLoad: (p: Pack) => void;
  onClone: (p: Pack) => void;
  onMove: (id: string, folder: string) => Promise<boolean>;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onCreateFolder: (name: string) => Promise<boolean>;
  onDeleteFolder: (name: string) => Promise<boolean>;
}

/** Whether a session in `session`'s target language (after the pack's
 *  overrides) is in the active language profile's (`profile`): only then
 *  does ☆ Star in its transcript belong in this language's phrase bank (a
 *  pack can move the target language). A blank side can't disagree. The
 *  server makes the same check, by ISO language, for what a turn captures
 *  (scripts/phrases.mjs sameLanguage). */
export function inBankLanguage(profile: unknown, session: unknown): boolean {
  const p = String(profile ?? "").trim().toLowerCase();
  const s = String(session ?? "").trim().toLowerCase();
  return !p || !s || p === s;
}
