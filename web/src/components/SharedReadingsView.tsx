import { useEffect, useState } from "react";
import { ApiError, confirmSharedReading, getSharedReadingsAdmin, removeSharedReading, sharedReadingsExportUrl } from "../api";
import type { SharedReadingAdminRow, SharedReadingsAdminReply } from "../../shared/readings.ts";
import { Badge, Button } from "./ui";

/* The shared readings list (ld-4i2, docs/DATA.md §Shared readings), the
 * admin's page from the menu: every whole-word Mandarin reading people
 * settled, active ones (every learner's reader applies them) and
 * suggestions (a learner's correction, the recap's answer) to confirm or
 * remove; how many readings the list changed in the last 30 days of
 * sessions; and an export of the active entries (words and readings only)
 * to fold into the reader's built-in table and the sweep's regression list,
 * or report upstream. Admin-only routes (a 403 for anyone else). */

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const SOURCE: Record<SharedReadingAdminRow["source"], string> = { admin: "an admin", user: "a learner", recap: "a recap" };

export default function SharedReadingsView() {
  const [data, setData] = useState<SharedReadingsAdminReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    getSharedReadingsAdmin().then(
      (r) => !gone && setData(r),
      (e) => !gone && setError(errText(e)),
    );
    return () => {
      gone = true;
    };
  }, []);

  async function act(id: string, what: "confirm" | "remove") {
    setBusy(id);
    setError(null);
    try {
      setData(await (what === "confirm" ? confirmSharedReading(id) : removeSharedReading(id)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const active = data?.rows.filter((r) => r.status === "active") ?? [];
  const suggested = data?.rows.filter((r) => r.status === "suggested") ?? [];
  const row = (r: SharedReadingAdminRow) => (
    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2" data-testid="shared-reading-row">
      <span lang="zh" className="text-lg font-medium text-fg">
        {r.word}
      </span>
      {r.key !== r.word && (
        <span lang="zh" className="text-sm text-fg-3">
          {r.key}
        </span>
      )}
      <span className="text-fg">{r.reading}</span>
      {r.scope === "tw" && <Badge tone="neutral">Taiwan only</Badge>}
      <span className="text-sm text-fg-3">
        from {SOURCE[r.source]}
        {r.suggestedBy ? ` (${r.suggestedBy})` : ""}
        {r.status === "suggested" ? ` · ${r.votes} of 2 people` : ""}
        {r.confirmedBy ? `; confirmed by ${r.confirmedBy}` : ""}
      </span>
      <span className="ml-auto flex gap-2">
        {r.status === "suggested" && (
          <Button className="px-2 py-1 text-sm" disabled={busy === r.id} onClick={() => void act(r.id, "confirm")} aria-label={`Confirm ${r.word} ${r.reading}`}>
            Confirm
          </Button>
        )}
        <Button variant="ghost" className="px-2 py-1 text-sm" disabled={busy === r.id} onClick={() => void act(r.id, "remove")} aria-label={`Remove ${r.word} ${r.reading}`}>
          Remove
        </Button>
      </span>
    </li>
  );

  return (
    <div className="flex flex-col gap-6" data-testid="shared-readings">
      <div className="flex flex-col gap-1">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Shared readings</h2>
        <p className="text-sm text-fg-3">
          Mandarin words whose reading people settled. Active ones read that way for every learner, over the program’s own reading (a learner’s own choice still comes first). A suggestion becomes active when you confirm it, or when two different people stand behind it (a recap counts as the learner whose session it was). Words and readings only.
        </p>
      </div>
      {error && <p className="text-sm text-err" role="alert">{error}</p>}
      {!data && !error && <p className="text-sm text-fg-3">Loading…</p>}
      {data && (
        <>
          <p className="text-sm text-fg-2" data-testid="shared-readings-count">
            In the last 30 days the list changed <span className="font-medium text-fg">{data.changed30d.changed}</span> reading{data.changed30d.changed === 1 ? "" : "s"} in {data.changed30d.sessions} recapped Mandarin session{data.changed30d.sessions === 1 ? "" : "s"}.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-3">Export the active ones:</span>
            <a className="underline" href={sharedReadingsExportUrl("yaml")} download>
              YAML
            </a>
            <a className="underline" href={sharedReadingsExportUrl("json")} download>
              JSON
            </a>
          </div>
          <section aria-labelledby="readings-suggested" className="flex flex-col gap-1">
            <h3 id="readings-suggested" className="text-sm font-medium text-fg-2">
              Suggested ({suggested.length})
            </h3>
            {suggested.length ? <ul>{suggested.map(row)}</ul> : <p className="text-sm text-fg-3">None waiting.</p>}
          </section>
          <section aria-labelledby="readings-active" className="flex flex-col gap-1">
            <h3 id="readings-active" className="text-sm font-medium text-fg-2">
              Active ({active.length})
            </h3>
            {active.length ? <ul>{active.map(row)}</ul> : <p className="text-sm text-fg-3">None yet.</p>}
          </section>
        </>
      )}
    </div>
  );
}
