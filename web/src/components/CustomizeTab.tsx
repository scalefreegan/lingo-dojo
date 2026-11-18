import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ContentReply, Schema, Slot, Unit } from "../types";
import { changedSlots, chooseOne, resetUnitsToDefaults, toggleAny, unitsForSlot, unslottedUnits, type Draft } from "../draft";
import { Badge, Button, Card, Chevron } from "./ui";

/* Customize tab: every slot collapsed to one row — title, current choice,
 * a dot when it differs from the defaults — grouped the way
 * content/schema.yaml orders its `group`s. Click a row to expand it; only
 * one is open at a time. This is the tab the owner called "text heavy", so
 * nothing past the row summary renders until you ask for it. */
export default function CustomizeTab({
  content,
  draft,
  onChange,
  onNext,
}: {
  content: ContentReply;
  draft: Draft;
  onChange: (d: Draft) => void;
  onNext: () => void;
}) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const changed = useMemo(() => changedSlots(content, draft), [content, draft]);
  const groups = useMemo(() => groupSlots(content.schema), [content.schema]);
  const unslotted = unslottedUnits(content);
  // A picked drill (First steps) skips the scene-only slots: say so on
  // their rows rather than flag a required one as missing.
  const drill = draft.scenarioMode === "library" && content.scenarios.find((s) => s.id === draft.scenario)?.format === "drill";

  return (
    <div className="flex flex-col gap-6">
      {content.schema.slots.length === 0 && <p className="text-sm text-fg-3">No slots in content/schema.yaml yet.</p>}

      <div className="flex flex-col gap-5">
        {groups.map(({ group, slots }) => (
          <div key={group}>
            <h3 className="mb-2 text-sm font-medium text-fg-2">{group}</h3>
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              {slots.map((slot) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  units={unitsForSlot(content, slot.id)}
                  draft={draft}
                  content={content}
                  open={openSlot === slot.id}
                  changed={changed.has(slot.id)}
                  skipped={drill && !!slot.scene_only}
                  onToggle={() => setOpenSlot((cur) => (cur === slot.id ? null : slot.id))}
                  onChange={onChange}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {unslotted.length > 0 && (
        <Card className="border-dashed" data-slot="unslotted">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-medium text-fg">Unslotted</h3>
            <Badge tone="warn">not in schema</Badge>
          </div>
          <p className="mt-1 text-sm text-fg-2">
            These units name a slot that content/schema.yaml doesn't have, so they are never assembled. Fix the unit's{" "}
            <code className="font-mono text-sm sm:text-xs">slot</code> or add the slot to the schema.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {unslotted.map((u) => (
              <li key={u.id} className="rounded-md border border-line p-2 opacity-75">
                <UnitText unit={u} extra={<Badge tone="warn">slot: {u.slot}</Badge>} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <button type="button" className="text-sm text-fg-3 hover:text-fg-2 hover:underline" onClick={() => onChange(resetUnitsToDefaults(content, draft))}>
          Reset to defaults
        </button>
        <Button variant="primary" onClick={onNext}>
          Next: Go →
        </Button>
      </div>
    </div>
  );
}

/** Slots clustered by `slot.group`, in schema order within a group and
 *  groups ordered by first appearance; ungrouped slots fall under "Other". */
function groupSlots(schema: Schema): { group: string; slots: Slot[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, Slot[]>();
  for (const slot of schema.slots) {
    const g = slot.group?.trim() || "Other";
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g)!.push(slot);
  }
  return order.map((group) => ({ group, slots: byGroup.get(group)! }));
}

function SlotRow({
  slot,
  units,
  draft,
  content,
  open,
  changed,
  skipped = false,
  onToggle,
  onChange,
}: {
  slot: Slot;
  units: Unit[];
  draft: Draft;
  content: ContentReply;
  open: boolean;
  changed: boolean;
  /** A scene-only slot while the picked scene is a drill: left out of it. */
  skipped?: boolean;
  onToggle: () => void;
  onChange: (d: Draft) => void;
}) {
  const one = slot.pick === "one";
  const selected = draft.units.filter((id) => units.some((u) => u.id === id));
  const missing = !skipped && slot.required && selected.length === 0;
  const name = `slot-${slot.id}`;
  const summary = selected.length === 0 ? "None" : selected.map((id) => units.find((u) => u.id === id)?.title ?? id).join(", ");
  const rowClass = (on: boolean) =>
    `flex cursor-pointer items-start gap-2 rounded-md border p-2 transition-colors ${on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"}`;

  return (
    <div className="border-b border-line last:border-b-0" data-slot={slot.id}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised">
        {changed && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Changed from defaults" />}
        <span className="min-w-0 flex-1 font-medium text-fg">{slot.title}</span>
        <span className={`max-w-[45%] min-w-0 truncate text-sm ${missing ? "text-warn" : "text-fg-3"}`}>{skipped ? "Not used in a drill" : missing ? "Required — none chosen" : summary}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4">
          {slot.description && <p className="mb-2 text-sm text-fg-2">{slot.description}</p>}
          {units.length === 0 && <p className="text-sm text-fg-3">No units for this slot yet.</p>}
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{slot.title}</legend>
            {one && !slot.required && units.length > 0 && (
              <label className={rowClass(selected.length === 0)}>
                <input type="radio" name={name} className="mt-1" checked={selected.length === 0} onChange={() => onChange(chooseOne(draft, content, slot, null))} />
                <span className="text-sm text-fg-2">None</span>
              </label>
            )}
            {units.map((u) => {
              const on = selected.includes(u.id);
              return (
                <label key={u.id} className={`${rowClass(on)} group`}>
                  {one ? (
                    <input type="radio" name={name} className="mt-1" checked={on} onChange={() => onChange(chooseOne(draft, content, slot, u.id))} />
                  ) : (
                    <input type="checkbox" className="mt-1" checked={on} onChange={(e) => onChange(toggleAny(draft, u.id, e.target.checked))} />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">{u.title}</span>
                    <span className="text-sm text-fg-2">{u.summary}</span>
                    {(u.tags.length > 0 || u.level.length > 0) && (
                      <span
                        className={`flex flex-wrap gap-1 pt-0.5 transition-opacity ${on ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
                      >
                        {u.level.length > 0 && <Badge tone="accent">{u.level.join(" · ")}</Badge>}
                        {u.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {one && selected.length > 1 && (
            <p className="mt-2 text-sm text-warn sm:text-xs">This slot takes one unit; only the first is used. Pick one to clear the warning.</p>
          )}
        </div>
      )}
    </div>
  );
}

function UnitText({ unit, extra }: { unit: Unit; extra?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-fg">{unit.title}</span>
        {unit.level.length > 0 && (
          <Badge tone="accent" title="Suggested level (a hint, not a filter)">
            {unit.level.join(" · ")}
          </Badge>
        )}
      </span>
      <span className="text-sm text-fg-2">{unit.summary}</span>
      {(unit.tags.length > 0 || extra) && (
        <span className="flex flex-wrap gap-1">
          {unit.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
          {extra}
        </span>
      )}
    </span>
  );
}
