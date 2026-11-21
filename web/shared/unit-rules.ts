// Unit `conflicts:` and `requires:` (docs/CONTENT.md "Conflicts and
// requirements"). Two units can contradict each other in one prompt; an author
// who sees it declares it once, and every pack that picks both is warned.
// Pure, erasable TypeScript with no imports beyond types, so one copy serves
// the loader (validation), the assembler (warnings) and the Customize tab
// (the note beside the clashing units), like web/shared/scenes.ts. Nothing
// here ever blocks a pick: it only says what it found.

import type { Schema, Unit } from "./wire.ts";

/** A reference as written in frontmatter: `unit-id`, `slot:<slot>`, `tag:<tag>`. */
export type UnitRef = { kind: "unit" | "slot" | "tag"; value: string };

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Parse one entry; null when it is not in the grammar (the loader warns). */
export function parseRef(raw: unknown): UnitRef | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = /^(slot|tag):(.*)$/.exec(s);
  if (m) {
    const value = m[2].trim();
    return value ? { kind: m[1] as "slot" | "tag", value } : null;
  }
  return ID.test(s) ? { kind: "unit", value: s } : null;
}

type Pickable = Pick<Unit, "id" | "slot" | "title" | "tags"> & { conflicts?: string[]; requires?: string[] };

function matches(ref: UnitRef, u: Pickable): boolean {
  if (ref.kind === "unit") return u.id === ref.value;
  if (ref.kind === "slot") return u.slot === ref.value;
  return (u.tags ?? []).includes(ref.value);
}

const refs = (list: string[] | undefined): UnitRef[] => (list ?? []).map(parseRef).filter((r): r is UnitRef => r !== null);

export interface UnitConflict {
  /** The two unit ids, in pick order. */
  a: string;
  b: string;
  message: string;
}
export interface UnmetRequirement {
  unit: string;
  /** The entry as written (`unit-id` or `slot:<slot>`). */
  need: string;
  message: string;
}
export interface UnitIssues {
  conflicts: UnitConflict[];
  unmet: UnmetRequirement[];
  /** Every message, conflicts first: what assemble() adds to its warnings. */
  messages: string[];
}

/**
 * The conflicts and unmet requirements among the units a pack picks.
 *
 * A conflict is symmetric: if either unit declares the other (by id, slot or
 * tag), both are warned, so declaring it on one side is enough. A unit never
 * conflicts with itself, and a requirement is met only by a *different* picked
 * unit. `drill`: a scene-only slot's units are left out of a drill's prompt
 * (docs/CONTENT.md), so they neither clash nor satisfy anything. Unknown ids,
 * duplicates and units whose slot is not in the schema are ignored (the
 * assembler and the loader report those). Order follows `ids`, so the result
 * is deterministic.
 */
export function unitIssues(
  content: { schema: Pick<Schema, "slots">; units: readonly Pickable[] },
  ids: readonly string[],
  opts: { drill?: boolean } = {},
): UnitIssues {
  const byId = new Map(content.units.map((u) => [u.id, u]));
  const slots = new Map(content.schema.slots.map((s) => [s.id, s]));
  const active: Pickable[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    const slot = u && slots.get(u.slot);
    if (!u || !slot || active.includes(u)) continue;
    if (opts.drill && slot.scene_only) continue;
    active.push(u);
  }

  const conflicts: UnitConflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const [x, y] = [active[i], active[j]];
      if (!refs(x.conflicts).some((r) => matches(r, y)) && !refs(y.conflicts).some((r) => matches(r, x))) continue;
      conflicts.push({
        a: x.id,
        b: y.id,
        message: `"${x.title}" and "${y.title}" can contradict each other in the prompt; pick one of them.`,
      });
    }
  }

  const unmet: UnmetRequirement[] = [];
  for (const u of active) {
    for (const raw of u.requires ?? []) {
      const ref = parseRef(raw);
      if (!ref || ref.kind === "tag" || active.some((o) => o !== u && matches(ref, o))) continue;
      const what = ref.kind === "slot" ? `a unit in the ${slots.get(ref.value)?.title ?? ref.value} slot` : `"${byId.get(ref.value)?.title ?? ref.value}"`;
      unmet.push({ unit: u.id, need: raw, message: `"${u.title}" needs ${what}, which is not picked.` });
    }
  }

  return { conflicts, unmet, messages: [...conflicts.map((c) => c.message), ...unmet.map((r) => r.message)] };
}

/** Messages per unit id, for the Customize tab's note beside each unit. */
export function issuesByUnit(issues: UnitIssues): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, m: string) => out.set(id, [...(out.get(id) ?? []), m]);
  for (const c of issues.conflicts) {
    add(c.a, c.message);
    add(c.b, c.message);
  }
  for (const r of issues.unmet) add(r.unit, r.message);
  return out;
}
