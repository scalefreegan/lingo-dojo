/* The pack being edited, and the pure rules for changing it. Kept apart from
 * the components so the selection rules (defaults, cardinality, unit order)
 * live in one place and read like the contract they implement
 * (docs/CONTENT.md: "order within a slot follows the pack"). */

import type { ContentReply, Language, LanguageInfo, Pack, PackInput, PickerKey, Profile, Scenario, Slot, Unit } from "./types";

export type OverrideKey = PickerKey;
/** The Profile popover's fields, in display order. The level picker's
 *  options come from `content.levels` (per mode); a profile level outside
 *  that list is still shown (prepended), never silently replaced. */
export const OVERRIDE_FIELDS: { key: OverrideKey; label: string }[] = [
  { key: "learner_name", label: "Name" },
  { key: "native_language", label: "Native language" },
  { key: "target_language", label: "Target language" },
  { key: "target_variant", label: "Variant" },
  { key: "level", label: "Level" },
];

export interface Draft {
  /** "" until saved or loaded. */
  title: string;
  /** The saved pack this draft came from (`<stem>` or `<folder>/<stem>`);
   *  saving with the same title into the same folder overwrites it. Null for
   *  a new or cloned draft. */
  sourceId: string | null;
  /** Kept from a loaded pack so an overwrite doesn't rewrite its date. */
  created: string;
  /** "library" uses `scenario`; "quick" uses `quickScenario`. Both are kept
   *  so flipping between them doesn't lose what was typed. */
  scenarioMode: "library" | "quick";
  scenario: string;
  quickScenario: string;
  /** Unit ids, pack order. */
  units: string[];
  overrides: Record<OverrideKey, string>;
  /** The Scene tab's Location: where a scenario that uses {{location}} is
   *  set. "" = the dojo master picks a city. Saved as `overrides.location`;
   *  kept apart from `overrides` because it describes the scene, not the
   *  learner, so the Profile popover never shows it. */
  location: string;
  /** The pack's own session length, in minutes: one it was loaded with, or
   *  one picked in the Go tab's "How long do you have?" for this draft
   *  (picking counts, even re-picking the length already shown). null = the
   *  pack has none of its own, and the picker shows the last choice
   *  remembered in the voice settings (effectiveMinutes), which the session
   *  uses but a save never writes into the pack. Saved as
   *  `overrides.minutes`; kept apart from `overrides` for the same reason as
   *  the location. */
  minutes: number | null;
  notes: string;
  /** Overrides from a loaded pack that the form has no field for; written
   *  back untouched on save. */
  extraOverrides: Record<string, unknown>;
}

export const emptyOverrides = (): Record<OverrideKey, string> => ({
  learner_name: "", native_language: "", target_language: "", target_variant: "", level: "",
});

/* ------------------------------- pickers -------------------------------- */

/** The profile's value for a picker key, "" when absent or not a string. */
export function profileValue(profile: Profile, key: OverrideKey): string {
  const v = profile[key];
  return typeof v === "string" ? v : "";
}

/** What the prompt uses for a key when the pack has no override: the
 *  profile's value — except that the profile's variant only applies while
 *  the target is the profile's target. That mirrors the assembler (a variant
 *  belongs to its language), so the picker shows what the preview will say. */
export function profileDefault(profile: Profile, key: OverrideKey, target: string): string {
  if (key === "target_variant" && target !== profileValue(profile, "target_language")) return "";
  return profileValue(profile, key);
}

/** "German · B1": a language profile in one line (the language switcher,
 *  the learner picker). */
export function languageLine(l: LanguageInfo): string {
  return [l.target_language || "No language set", l.level].filter(Boolean).join(" · ");
}

/** The learner line the Scene and Go tabs show, e.g. "English → Spanish ·
 *  Mexican Spanish (Oaxaca) · A2" — the variant is its own segment, only
 *  shown when one is set. */
export function formatSessionLine(session: Record<OverrideKey, string>): string {
  return [`${session.native_language} → ${session.target_language}`, session.target_variant, session.level].filter(Boolean).join(" · ");
}

/** The values the Profile popover shows and the prompt uses: override if
 *  set, else the profile's. Native language falls back to English when
 *  neither says. */
export function sessionValues(draft: Draft, profile: Profile): Record<OverrideKey, string> {
  const o = draft.overrides;
  const target = o.target_language || profileValue(profile, "target_language");
  const pick = (key: OverrideKey) => o[key] || profileDefault(profile, key, target);
  return {
    learner_name: pick("learner_name"),
    native_language: pick("native_language") || "English",
    target_language: target,
    target_variant: pick("target_variant"),
    level: pick("level"),
  };
}

/** Choose a picker value. Choosing what the profile already says clears the
 *  override (a saved pack carries only what differs from the profile);
 *  anything else sets it. Changing the target drops a variant override that
 *  doesn't belong to the new target. */
export function choosePickerValue(draft: Draft, profile: Profile, languages: Language[], key: OverrideKey, value: string): Draft {
  const target = key === "target_language" ? value : sessionValues(draft, profile).target_language;
  const overrides = { ...draft.overrides, [key]: value === profileDefault(profile, key, target) ? "" : value };
  if (key === "target_language") {
    const variants = languages.find((l) => l.name === value)?.variants ?? [];
    if (overrides.target_variant && !variants.includes(overrides.target_variant)) overrides.target_variant = "";
  }
  return { ...draft, overrides };
}

/** A new pack: each slot's `default: true` units preselected, in schema
 *  order. A pick:one slot keeps only its first default, so a fresh pack never
 *  starts with a cardinality warning. */
export function newDraft(content: ContentReply): Draft {
  const units: string[] = [];
  for (const slot of content.schema.slots) {
    const defaults = unitsForSlot(content, slot.id).filter((u) => u.default);
    units.push(...(slot.pick === "one" ? defaults.slice(0, 1) : defaults).map((u) => u.id));
  }
  return {
    title: "",
    sourceId: null,
    created: "",
    scenarioMode: "library",
    scenario: "",
    quickScenario: "",
    units,
    overrides: emptyOverrides(),
    location: "",
    minutes: null,
    notes: "",
    extraOverrides: {},
  };
}

export function unitsForSlot(content: ContentReply, slotId: string): Unit[] {
  return content.units.filter((u) => u.slot === slotId);
}

/** Units whose slot the schema doesn't have: shown, never selectable (the
 *  assembler would skip them anyway). */
export function unslottedUnits(content: ContentReply): Unit[] {
  const ids = new Set(content.schema.slots.map((s) => s.id));
  return content.units.filter((u) => !ids.has(u.slot));
}

/** pick:one — replace whatever this slot had, in its old position (so the
 *  pack's order elsewhere is undisturbed); `null` clears the slot. */
export function chooseOne(draft: Draft, content: ContentReply, slot: Slot, unitId: string | null): Draft {
  const inSlot = new Set(unitsForSlot(content, slot.id).map((u) => u.id));
  const at = draft.units.findIndex((id) => inSlot.has(id));
  const rest = draft.units.filter((id) => !inSlot.has(id));
  if (unitId) rest.splice(at === -1 ? rest.length : at, 0, unitId);
  return { ...draft, units: rest };
}

/** pick:any — a newly checked unit goes to the end, so the order within the
 *  slot is the order the person ticked them. */
export function toggleAny(draft: Draft, unitId: string, on: boolean): Draft {
  const without = draft.units.filter((id) => id !== unitId);
  return { ...draft, units: on ? [...without, unitId] : without };
}

/** Slot ids whose current selection differs from a fresh pack's for this
 *  content — order within the slot doesn't count, only which units are
 *  chosen. Drives the Customize tab row's dot and the summary bar's "N
 *  changed from defaults". */
export function changedSlots(content: ContentReply, draft: Draft): Set<string> {
  const fresh = newDraft(content).units;
  const changed = new Set<string>();
  for (const slot of content.schema.slots) {
    const inSlot = (id: string) => unitsForSlot(content, slot.id).some((u) => u.id === id);
    const theirs = new Set(draft.units.filter(inSlot));
    const defaults = new Set(fresh.filter(inSlot));
    if (theirs.size !== defaults.size || [...theirs].some((id) => !defaults.has(id))) changed.add(slot.id);
  }
  return changed;
}

/** Customize tab's "Reset to defaults": every slot's units back to the
 *  schema's `default: true` picks. Scenario, profile overrides, notes and
 *  title are untouched — only the slot selection resets. */
export function resetUnitsToDefaults(content: ContentReply, draft: Draft): Draft {
  return { ...draft, units: newDraft(content).units };
}

/** The session length the Go tab's picker shows and the session uses
 *  (assemble, Copy, export, the voice turn): the pack's own, else the last
 *  one remembered (null = No limit). A save writes only the pack's own. */
export function effectiveMinutes(draft: Draft, remembered: number | null): number | null {
  return draft.minutes ?? remembered;
}

/** The longest session budget; scripts/plan.mjs MAX_MINUTES must match. */
export const MAX_MINUTES = 240;

/** A pack's `overrides.minutes` as the session uses it, by the same rule as
 *  scripts/plan.mjs readMinutes: a positive number up to MAX_MINUTES,
 *  rounded to whole minutes and at least 1; else null. The picker and the
 *  timeline show this, so they agree with the prompt's heading and the
 *  clock line about a hand-written 7.5 (8). */
export function validMinutes(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_MINUTES ? Math.max(1, Math.round(v)) : null;
}

/** The warning for a pack whose own `minutes` is unusable ("ten") while the
 *  remembered length stands in for the session: the assembler can't see the
 *  bad value then (the pack it gets carries the remembered one), so the Go
 *  tab adds this to the assembler's warnings. Null when there is nothing to
 *  say; with no length standing in, the bad value reaches the assembler,
 *  which warns itself. */
export function minutesWarning(draft: Draft, effective: number | null): string | null {
  if (draft.minutes != null || effective == null || !Object.hasOwn(draft.extraOverrides, "minutes")) return null;
  return `Pack override "minutes" must be a number of minutes above 0 and at most ${MAX_MINUTES}, not ${JSON.stringify(draft.extraOverrides.minutes)}; ignored (using your last choice, ${effective} min, until you pick one).`;
}

/** The pack the server sees. With the default `minutes` (the pack's own)
 *  it is what a save writes; assemble, export and the voice turn pass the
 *  picker's value (effectiveMinutes), so the prompt is paced for whatever
 *  the picker shows without a remembered default being saved into a pack. */
export function draftToPack(draft: Draft, minutes: number | null = draft.minutes): PackInput {
  const overrides: Record<string, unknown> = { ...draft.extraOverrides };
  for (const { key } of OVERRIDE_FIELDS) {
    const v = draft.overrides[key].trim();
    if (v) overrides[key] = v;
  }
  const location = draft.location.trim();
  if (location) overrides.location = location;
  else delete overrides.location;
  // A chosen length replaces whatever a loaded pack had there (an invalid
  // value kept in extraOverrides included); without one, an invalid value
  // stays, so the assembler's warning about it is seen.
  if (minutes != null) overrides.minutes = minutes;
  const quick = draft.scenarioMode === "quick";
  return {
    title: draft.title,
    created: draft.created,
    scenario: quick ? "" : draft.scenario,
    quick_scenario: quick ? draft.quickScenario : "",
    units: draft.units,
    overrides,
    notes: draft.notes,
  };
}

export function packToDraft(pack: Pack): Draft {
  const overrides = emptyOverrides();
  const extraOverrides: Record<string, unknown> = {};
  let location = "";
  let minutes: number | null = null;
  for (const [k, v] of Object.entries(pack.overrides ?? {})) {
    if (OVERRIDE_FIELDS.some((f) => f.key === k) && v != null) overrides[k as OverrideKey] = String(v);
    else if (k === "location") location = v == null ? "" : String(v);
    // A value the picker can't hold stays as an extra override, written
    // back untouched, so the assembler still warns about it.
    else if (k === "minutes" && validMinutes(v) != null) minutes = v as number;
    else extraOverrides[k] = v;
  }
  const quick = !pack.scenario && !!pack.quick_scenario;
  return {
    title: pack.title,
    sourceId: pack.id,
    created: pack.created,
    scenarioMode: quick ? "quick" : "library",
    scenario: pack.scenario,
    quickScenario: pack.quick_scenario,
    units: [...pack.units],
    overrides,
    location,
    minutes,
    notes: pack.notes,
    extraOverrides,
  };
}

/* ------------------------------ collections ------------------------------ */

/** The language a collection was written for, when that isn't the session's
 *  target: its scenarios all carry a `language` ("es-MX") whose prefix is
 *  another language's code. A collection with any language-neutral
 *  scenario, or a target with no code in languages.yaml, is never foreign —
 *  dimming is a hint, so it errs toward not dimming. Returns the language's
 *  name for the badge ("Spanish"), or the raw code when languages.yaml
 *  doesn't list it. */
export function foreignLanguage(items: Scenario[], languages: Language[], target: string): string | null {
  const targetCode = languages.find((l) => l.name === target)?.code;
  if (!targetCode || items.length === 0) return null;
  const codes = new Set<string>();
  for (const s of items) {
    if (!s.language) return null;
    codes.add(s.language.split(/[-_]/)[0].toLowerCase());
  }
  if (codes.has(targetCode)) return null;
  const first = [...codes][0];
  return languages.find((l) => l.code === first)?.name ?? first;
}

/* --------------------------------- ids ---------------------------------- */

/** Case- and accent-insensitive form of a string ("Café" → "cafe"); the one
 *  fold slugify and the Scene tab's search share. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Lowercase ASCII kebab-case, accents folded ("Café en Oaxaca" →
 *  "cafe-en-oaxaca"); matches the server's id rule, and the server's own
 *  slugify in scripts/content.mjs, which renames a pack. `fallback` is what
 *  a title with no letters or digits becomes — "" lets a form refuse it. */
export function slugify(s: string, fallback = "pack"): string {
  const slug = fold(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** `oaxaca/2026-10-19-x` → { folder: "oaxaca", stem: "2026-10-19-x" }; a
 *  top-level id has folder "". Mirrors splitPackId in scripts/content.mjs. */
export function splitPackId(id: string): { folder: string; stem: string } {
  const i = id.indexOf("/");
  return i === -1 ? { folder: "", stem: id } : { folder: id.slice(0, i), stem: id.slice(i + 1) };
}

/** The id of a stem in a folder ("" for the top level). */
export function joinPackId(folder: string, stem: string): string {
  return folder ? `${folder}/${stem}` : stem;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Today in local time — the date a person would write on the file. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local time with its UTC offset, like the contract's 2026-10-19T09:30:00-06:00. */
export function localTimestamp(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The contract's pack file stem: `<YYYY-MM-DD>-<slug of title>`. The id
 *  adds the folder, if any (joinPackId). */
export function packId(title: string, d = new Date()): string {
  return `${localDate(d)}-${slugify(title)}`;
}

/* ------------------------- remembering the draft ------------------------- */

/** A browser-storage key for one language profile: the draft, the tab and
 *  the Scene filters are that learner's in that language, so German and
 *  Chinese each keep their own unsaved picks, and the next learner or
 *  account on the same browser starts from its own (or from the defaults),
 *  never from the last one's unsaved name, level or quick-scenario text. A
 *  language profile's id is unique on its own, so it alone names the key. */
export function languageKey(base: string, languageId: string): string {
  return `${base}.language.${languageId}`;
}

/** Where these lived when they were per learner (before language
 *  profiles): adopted by the learner's oldest language (adoptLearnerKeys). */
function learnerKey(base: string, learnerId: string): string {
  return `${base}.learner.${learnerId}`;
}

const DRAFT_KEY = "lingo-dojo.draft.v1";

/** Every per-profile key's base. Before logins they were one per mode
 *  (adult the bare base, kids with `.kids`), shared by whoever used the
 *  browser; then one per learner; now one per language profile. */
const MODE_KEYS = ["lingo-dojo.draft.v1", "lingo-dojo.tab.v1", "lingo-dojo.scene-filter.v1", "lingo-dojo.scene-folders.v1"];

/** Move a learner's keys from before language profiles to `languageId`,
 *  its oldest language (the caller passes it): a learner had one language
 *  then, which migration 0002 made its first profile, so the draft was that
 *  language's, whichever language this browser happens to open first.
 *  Moved, not copied, so a second language starts from the defaults. A
 *  language that already has its own key keeps it. */
export function adoptLearnerKeys(learnerId: string, languageId: string): void {
  try {
    for (const base of MODE_KEYS) {
      const old = learnerKey(base, learnerId);
      const value = localStorage.getItem(old);
      if (value === null) continue;
      const key = languageKey(base, languageId);
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      localStorage.removeItem(old);
    }
  } catch {
    /* blocked storage: nothing stored to adopt */
  }
}

/** Forget the per-mode keys (AuthGate, once per page load). Dropped, not
 *  adopted by a learner — there is no telling whose they were. */
export function dropModeKeys(): void {
  try {
    for (const base of MODE_KEYS) for (const key of [base, `${base}.kids`]) localStorage.removeItem(key);
  } catch {
    /* blocked storage: nothing stored to drop */
  }
}

/** This language profile's last draft, so a refresh doesn't throw away
 *  today's selections. Browser storage only: a per-machine convenience,
 *  never the record (saved packs are). Any read failure means "start fresh". */
export function loadRememberedDraft(languageId: string): Draft | null {
  try {
    const raw = localStorage.getItem(languageKey(DRAFT_KEY, languageId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (!Array.isArray(d.units) || typeof d.overrides !== "object" || d.overrides === null) return null;
    return { ...newDraftShape(), ...d, overrides: { ...emptyOverrides(), ...d.overrides }, minutes: validMinutes(d.minutes) == null ? null : d.minutes } as Draft;
  } catch {
    return null;
  }
}

export function rememberDraft(languageId: string, draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(languageKey(DRAFT_KEY, languageId), JSON.stringify(draft));
    else localStorage.removeItem(languageKey(DRAFT_KEY, languageId));
  } catch {
    /* private window or blocked storage: nothing to remember into */
  }
}

/** Every field a Draft has, with empty values; keeps an older stored draft
 *  loadable after a field is added. */
function newDraftShape(): Draft {
  return {
    title: "",
    sourceId: null,
    created: "",
    scenarioMode: "library",
    scenario: "",
    quickScenario: "",
    units: [],
    overrides: emptyOverrides(),
    location: "",
    minutes: null,
    notes: "",
    extraOverrides: {},
  };
}
