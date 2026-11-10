import type { VoicePlanItem } from "../../shared/wire";

/* The session's parts beside the transcript: where the session is, what's
 * done, what's ahead, and a jump to any part. The dojo master names the
 * part each turn ends in (a STAGE line), so "here" is its word, not a guess.
 * Collapsed it is a thin rail of dots, to give the transcript the room. */

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

  if (!open) {
    return (
      <nav aria-label="Session parts" className="flex shrink-0 flex-row items-center gap-1.5 sm:w-8 sm:flex-col sm:pt-1" data-testid="voice-timeline">
        <button type="button" className="rounded-md px-1 text-fg-3 hover:bg-raised hover:text-fg" onClick={onToggle} aria-expanded={false} aria-label="Show the session's parts" title="Show the session's parts">
          ☰
        </button>
        <ol className="flex flex-row flex-wrap items-center gap-1 sm:flex-col">
          {plan.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className={`block rounded-full ${p.kind === "beat" ? "size-1.5" : "size-2.5"} ${state(i) === "here" ? "bg-accent ring-2 ring-accent/30" : state(i) === "done" ? "bg-accent/45" : "bg-line-strong"} disabled:cursor-not-allowed`}
                onClick={() => onJump(p)}
                disabled={disabled || state(i) === "here"}
                aria-label={`${p.title}${state(i) === "here" ? " (now)" : ""}: jump here`}
                title={`${p.title}${state(i) === "here" ? " — now" : " — jump here"}`}
              />
            </li>
          ))}
        </ol>
      </nav>
    );
  }

  return (
    <nav aria-label="Session parts" className="flex shrink-0 flex-col gap-1 rounded-2xl border border-line bg-panel/80 p-2 sm:w-52" data-testid="voice-timeline">
      <div className="flex items-center justify-between px-1">
        <span className="font-[family-name:var(--font-display)] text-sm text-fg-2">Session</span>
        <button type="button" className="rounded-md px-1.5 text-fg-3 hover:bg-raised hover:text-fg" onClick={onToggle} aria-expanded={true} aria-label="Hide the session's parts" title="Hide">
          «
        </button>
      </div>
      <ol className="flex max-h-[26rem] flex-col overflow-y-auto">
        {plan.map((p, i) => {
          const st = state(i);
          return (
            <li key={p.id}>
              <button
                type="button"
                className={`flex w-full items-start gap-2 rounded-lg py-1 pr-1.5 text-left text-sm transition-colors ${p.kind === "beat" ? "pl-6" : "pl-1.5"} ${st === "here" ? "bg-accent-soft font-medium text-fg" : st === "done" ? "text-fg-3 hover:bg-raised" : "text-fg-2 hover:bg-raised"} disabled:cursor-not-allowed`}
                onClick={() => onJump(p)}
                disabled={disabled || st === "here"}
                aria-current={st === "here" ? "step" : undefined}
                title={st === "here" ? "You are here" : `Jump to ${p.detail ?? p.title}`}
              >
                <span aria-hidden="true" className={`w-4 shrink-0 text-center ${p.kind === "beat" ? "text-fg-3" : ""}`}>
                  {st === "done" ? "✓" : (KIND_ICON[p.kind] ?? "•")}
                </span>
                <span className="min-w-0 flex-1 leading-snug">{p.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="px-1 text-xs text-fg-3">Tap a part to jump there.</p>
    </nav>
  );
}
