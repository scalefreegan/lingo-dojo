/* The pack being edited, and the pure rules for changing it. Kept apart from
 * the components so the selection rules (defaults, cardinality, unit order)
 * live in one place and read like the contract they implement
 * (docs/CONTENT.md: "order within a slot follows the pack"). */

import type { ContentReply, Language, Mode, Pack, PackInput, PickerKey, Profile, Scenario, Slot, Unit } from "./types";

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
  /** The Go tab's "How long do you have?" choice, in minutes; null = the
   *  pack says nothing, and the picker shows the last choice remembered in
   *  the voice settings (effectiveMinutes). Saved as `overrides.minutes`;
   *  kept apart from `overrides` for the same reason as the location. */
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

/** The session length the Go tab's picker shows and the pack carries: the
 *  draft's own choice, else the last one remembered (null = No limit). */
export function effectiveMinutes(draft: Draft, remembered: number | null): number | null {
  return draft.minutes ?? remembered;
}

/** The longest session budget; scripts/plan.mjs MAX_MINUTES must match. */
export const MAX_MINUTES = 240;

/** A pack's `overrides.minutes` as the picker can hold it: a positive
 *  number up to MAX_MINUTES (what the assembler accepts), else null. */
export function validMinutes(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_MINUTES ? v : null;
}

/** The pack the server sees (assemble, export, save). `minutes` is what
 *  the Go tab's picker shows (effectiveMinutes): whatever it shows is what
 *  the prompt is paced for, and what a save writes. */
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

/** A browser-storage key for a mode: adult keeps the original key, kids gets
 *  a `.kids` suffix, so each mode's draft, tab and Scene filters survive a
 *  switch to the other. */
export function modeKey(base: string, mode: Mode): string {
  return mode === "adult" ? base : `${base}.${mode}`;
}

const DRAFT_KEY = "lingo-dojo.draft.v1";

/** The last draft in this mode, so a refresh doesn't throw away today's
 *  selections. Browser storage only: a per-machine convenience, never the
 *  record (saved packs are). Any read failure means "start fresh". */
export function loadRememberedDraft(mode: Mode): Draft | null {
  try {
    const raw = localStorage.getItem(modeKey(DRAFT_KEY, mode));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (!Array.isArray(d.units) || typeof d.overrides !== "object" || d.overrides === null) return null;
    return { ...newDraftShape(), ...d, overrides: { ...emptyOverrides(), ...d.overrides }, minutes: validMinutes(d.minutes) } as Draft;
  } catch {
    return null;
  }
}

export function rememberDraft(mode: Mode, draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(modeKey(DRAFT_KEY, mode), JSON.stringify(draft));
    else localStorage.removeItem(modeKey(DRAFT_KEY, mode));
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
