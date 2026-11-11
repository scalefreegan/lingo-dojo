import { useLayoutEffect, useRef } from "react";
import type { VoicePlanItem } from "../../shared/wire";

/* The session's parts beside the transcript: where the session is, what's
 * done, what's ahead, and a jump to any part. The dojo master names the
 * part each turn ends in (a STAGE line), so "here" is its word, not a guess.
 * Collapsed it is a thin rail of dots, to give the transcript the room.
 * It lives in its own column (VoicePanel's aside) and scrolls on its own;
 * on narrow screens it sits above the session, kept short. Each list is
 * `relative` so the rows' screen-reader text (sr-only, absolutely placed)
 * is clipped by the list's scroll, not left to lengthen the page. */

const KIND_ICON: Record<string, string> = {
  intro: "👋",
  warmup: "🔥",
  scene: "🎭",
  beat: "•",
  games: "🎲",
  debrief: "📝",
  ending: "🌙",
};

export function SessionTimeline({
  plan,
  stage,
  open,
  onToggle,
  onJump,
  disabled,
}: {
  plan: VoicePlanItem[];
  /** The part the latest turn ended in; null before the dojo master says. */
  stage: string | null;
  open: boolean;
  onToggle: () => void;
  onJump: (item: VoicePlanItem) => void;
  /** While a turn is on its way, a jump would have to wait: no jumping. */
  disabled: boolean;
}) {
  const here = stage ? plan.findIndex((p) => p.id === stage) : -1;
  const state = (i: number) => (i === here ? "here" : here >= 0 && i < here ? "done" : "ahead");

  // Said in words for screen readers, not only by colour and the ✓.
  const said = (i: number) => (state(i) === "here" ? "now" : state(i) === "done" ? "done" : "ahead");
  // The current part is not disabled, so it stays reachable and announced
  // (aria-current); jumping to where you already are is just a no-op.
  // While a turn runs the parts are aria-disabled rather than disabled, so
  // the one just tapped keeps keyboard focus.
  const pick = (p: VoicePlanItem, i: number) => {
    if (!disabled && state(i) !== "here") onJump(p);
  };

  // Keep "here" in view in the list's own scroll (never the page's, which
  // scrollIntoView would also move).
  const listRef = useRef<HTMLOListElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || here < 0) return;
    const show = () => {
      const row = list.children[here] as HTMLElement | undefined;
      if (!row) return;
      const box = list.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top < box.top) list.scrollTop += r.top - box.top - 4;
      else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom + 4;
    };
    show();
    // Again when the list changes size (a phone turned, the window crossing
    // the wide layout), which moves its rows.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(show) : null;
    ro?.observe(list);
    return () => ro?.disconnect();
  }, [here, open]);

  if (!open) {
    return (
      <nav aria-label="Session parts" className="flex min-h-0 flex-row items-center gap-0.5 lg:flex-col lg:pt-1" data-testid="voice-timeline">
        <button type="button" className="rounded-md px-1 text-fg-3 hover:bg-raised hover:text-fg" onClick={onToggle} aria-expanded={false} aria-label="Show the session's parts" title="Show the session's parts">
          ☰
        </button>
        <ol ref={listRef} className="relative flex min-h-0 flex-row flex-wrap items-center lg:flex-col lg:flex-nowrap lg:overflow-y-auto">
          {plan.map((p, i) => (
            <li key={`${i}:${p.id}`}>
              {/* A 24px target around a small dot. */}
              <button
                type="button"
                className="group grid size-6 min-h-0 place-items-center rounded-full hover:bg-raised aria-disabled:cursor-not-allowed"
                onClick={() => pick(p, i)}
                aria-disabled={disabled || undefined}
                aria-current={state(i) === "here" ? "step" : undefined}
                aria-label={`${p.title} (${said(i)})${state(i) === "here" ? "" : ": jump here"}`}
                title={`${p.title}${state(i) === "here" ? " — now" : " — jump here"}`}
              >
                <span aria-hidden="true" className={`block rounded-full ${p.kind === "beat" ? "size-1.5" : "size-2.5"} ${state(i) === "here" ? "bg-accent ring-2 ring-accent/30" : state(i) === "done" ? "bg-accent/45" : "bg-line-strong"}`} />
              </button>
            </li>
          ))}
        </ol>
      </nav>
    );
  }

  return (
    <nav aria-label="Session parts" className="flex min-h-0 flex-col gap-1 rounded-2xl border border-line bg-panel/80 p-2" data-testid="voice-timeline">
      <div className="flex items-center justify-between px-1">
        <span className="font-[family-name:var(--font-display)] text-sm text-fg-2">Session</span>
        <button type="button" className="rounded-md px-1.5 text-fg-3 hover:bg-raised hover:text-fg" onClick={onToggle} aria-expanded={true} aria-label="Hide the session's parts" title="Hide">
          «
        </button>
      </div>
      <ol ref={listRef} className="relative flex max-h-48 min-h-0 flex-col overflow-y-auto lg:max-h-none lg:flex-1">
        {plan.map((p, i) => {
          const st = state(i);
          return (
            <li key={`${i}:${p.id}`}>
              <button
                type="button"
                className={`flex min-h-0 w-full items-start gap-2 rounded-lg py-1 pr-1.5 text-left text-sm transition-colors ${p.kind === "beat" ? "pl-6" : "pl-1.5"} ${st === "here" ? "cursor-default bg-accent-soft font-medium text-fg" : st === "done" ? "text-fg-3 hover:bg-raised" : "text-fg-2 hover:bg-raised"} aria-disabled:cursor-not-allowed`}
                onClick={() => pick(p, i)}
                aria-disabled={disabled || undefined}
                aria-current={st === "here" ? "step" : undefined}
                title={st === "here" ? "You are here" : `Jump to ${p.detail ?? p.title}`}
              >
                <span aria-hidden="true" className={`w-4 shrink-0 text-center ${p.kind === "beat" ? "text-fg-3" : ""}`}>
                  {st === "done" ? "✓" : (KIND_ICON[p.kind] ?? "•")}
                </span>
                <span className="min-w-0 flex-1 leading-snug">{p.title}</span>
                <span className="sr-only">{st === "here" ? " (now)" : st === "done" ? " (done)" : " (ahead)"}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="px-1 text-xs text-fg-3">Tap a part to jump there.</p>
    </nav>
  );
}
