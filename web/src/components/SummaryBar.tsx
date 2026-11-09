import { useMemo } from "react";
import type { AssembleResult, ContentReply, PackInput } from "../types";
import { changedSlots, type Draft } from "../draft";
import { useCopyStatus } from "../useCopyStatus";
import { Button } from "./ui";
import type { Tab } from "./shared";

/* The sticky strip below the top bar, visible on every tab: where the pack
 * stands (scene, units, what's changed, length, warnings) and the one thing
 * you'll do most — copy the prompt — without switching to Go first. The
 * facts wrap (a long scene title takes a line of its own and ellipsizes at
 * the edge); Copy sits outside the wrap so it never drops below them. */
export default function SummaryBar({
  content,
  draft,
  pack,
  sceneTitle,
  result,
  pending,
  onTab,
  onPractice,
}: {
  content: ContentReply;
  draft: Draft;
  pack: PackInput;
  sceneTitle: string;
  result: AssembleResult | null;
  pending: boolean;
  onTab: (t: Tab) => void;
  /** Open the voice session on the Go tab. */
  onPractice: () => void;
}) {
  const changedCount = useMemo(() => changedSlots(content, draft).size, [content, draft]);
  const warningsCount = result?.warnings.length ?? 0;
  const [copyStatus, copy] = useCopyStatus();
  const markdown = result?.markdown ?? "";

  return (
    <div className="sticky top-12 z-20 flex items-center gap-3 border-b border-line bg-panel px-4 py-2 text-sm sm:pr-10">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <span className="max-w-full truncate font-medium text-fg sm:max-w-[40%]">{sceneTitle || "No scene"}</span>
        <span className="text-fg-3">
          {pack.units.length} unit{pack.units.length === 1 ? "" : "s"}
        </span>
        {changedCount > 0 && <span className="hidden text-fg-3 sm:inline">{changedCount} changed from defaults</span>}
        <span className="text-fg-3 tabular-nums">
          {result ? `${result.stats.words.toLocaleString()} words` : "…"}
          {pending && " · updating"}
        </span>
        {warningsCount > 0 && (
          <button type="button" className="text-warn hover:underline" onClick={() => onTab("go")}>
            {warningsCount} warning{warningsCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {/* Practising in the dojo is the main action; copying the prompt for
          another voice app is the alternative, an icon. */}
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 text-base text-fg-3 hover:bg-raised hover:text-fg-2 disabled:opacity-40"
        onClick={() => copy(markdown)}
        disabled={!markdown}
        aria-label={copyStatus === "copied" ? "Prompt copied" : copyStatus === "failed" ? "Copy failed" : "Copy prompt"}
        title="Copy the prompt, to paste into ChatGPT or Claude voice instead"
      >
        {copyStatus === "copied" ? "✓" : copyStatus === "failed" ? "!" : "⧉"}
      </button>
      <Button variant="primary" className="shrink-0" onClick={onPractice} disabled={!markdown}>
        🥋 Practice
      </Button>
    </div>
  );
}
