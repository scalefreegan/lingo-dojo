import { useState } from "react";
import { Mochi } from "./Mascots";
import type { ContentReply, Mode, ProfileRequest } from "../types";
import type { Draft } from "../draft";
import { Button } from "./ui";
import ProfileControl from "./ProfileControl";
import type { Tab } from "./shared";

/* The top bar: the app's name (with a "Kids" tag when that library is
 * open), the three-step flow as tabs, Library off to the side (it's a
 * destination, not a step), and the two actions that touch the whole draft
 * (New pack, Reload content) tucked behind "…" so they don't compete with
 * the tabs for attention. Below `md` Library moves into that "…" menu — the
 * bar can't hold four tabs and the menu on a phone, nor beside the Profile
 * pill on a small tablet — and the three flow tabs scroll in their own strip
 * rather than widening the page. */
export default function TopBar({
  tab,
  onTab,
  onNewPack,
  onReload,
  reloading,
  ready,
  mode,
  onMode,
  content,
  draft,
  onChange,
  onSaveDefaults,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onNewPack: () => void;
  onReload: () => void;
  reloading: boolean;
  ready: boolean;
  mode: Mode;
  onMode: (m: Mode) => void;
  /** Null until the first load; the Profile pill appears with them. */
  content: ContentReply | null;
  draft: Draft | null;
  onChange: (d: Draft) => void;
  onSaveDefaults: (values: ProfileRequest) => Promise<string | null>;
}) {
  return (
    // On a phone everything is a little tighter, so the Kids tag still
    // leaves room for all three tabs (Go was pushed out of sight).
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-line bg-panel/90 px-3 backdrop-blur sm:gap-2 sm:px-4 sm:pr-10">
      <h1 className="flex shrink-0 items-center gap-1 text-lg font-semibold text-fg sm:mr-1 sm:gap-1.5">
        <Mochi size={30} />
        {/* Kids mode's tag takes the room the name needs below lg, where
            the bar would otherwise clip Go. */}
        <span className={mode === "kids" ? "sr-only lg:not-sr-only" : "sr-only sm:not-sr-only"}>Lingo Dojo</span>
        {mode === "kids" && (
          <span className="rounded-full bg-accent-soft px-1 py-0.5 text-[10px] font-medium leading-none text-accent sm:px-1.5 sm:text-[11px]" data-testid="mode-tag">
            Kids
          </span>
        )}
      </h1>
      {/* min-w-0 + overflow-x-auto: on a phone narrower than the three tabs
          the strip scrolls sideways by itself instead of widening the page. */}
      <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-full bg-raised p-1 [scrollbar-width:none]" aria-label="Sections">
        <TabButton label="Scene" active={tab === "scene"} onClick={() => onTab("scene")} />
        <TabButton label="Customize" active={tab === "customize"} onClick={() => onTab("customize")} />
        <TabButton label="Go" active={tab === "go"} onClick={() => onTab("go")} />
      </nav>
      <div className="ml-auto flex h-full shrink-0 items-center gap-1">
        {content && draft && (
          <ProfileControl content={content} draft={draft} mode={mode} onMode={onMode} onChange={onChange} onSaveDefaults={onSaveDefaults} />
        )}
        <TabButton label="Library" active={tab === "library"} onClick={() => onTab("library")} className="hidden md:flex" />
        <OverflowMenu onNewPack={onNewPack} onReload={onReload} reloading={reloading} ready={ready} libraryActive={tab === "library"} onLibrary={() => onTab("library")} />
      </div>
    </header>
  );
}

function TabButton({ label, active, onClick, className = "" }: { label: string; active: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex shrink-0 items-center rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-sm font-medium transition-colors sm:px-3.5 ${
        active ? "bg-panel text-accent shadow-[0_1px_2px_rgb(26_28_58/0.12)]" : "text-fg-3 hover:text-fg"
      } ${className}`}
    >
      {label}
    </button>
  );
}

const menuItemClass = "px-3 py-2 text-left text-sm text-fg-2 hover:bg-raised disabled:opacity-50";

/** New pack and Reload content: whole-draft actions, not part of the Scene →
 *  Customize → Go flow, so they live behind an overflow toggle instead of
 *  sitting next to the tabs. Library joins them below `md`, where the bar
 *  has no room for its tab. */
function OverflowMenu({
  onNewPack,
  onReload,
  reloading,
  ready,
  libraryActive,
  onLibrary,
}: {
  onNewPack: () => void;
  onReload: () => void;
  reloading: boolean;
  ready: boolean;
  libraryActive: boolean;
  onLibrary: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="ghost" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen((o) => !o)}>
        ⋯
      </Button>
      {open && (
        <>
          {/* Closes the menu on an outside click, without a ref or a document listener. */}
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-50 mt-1 flex w-44 flex-col overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-lg">
            <button
              type="button"
              role="menuitem"
              aria-current={libraryActive ? "page" : undefined}
              className={`${menuItemClass} border-b border-line md:hidden ${libraryActive ? "font-medium text-fg" : ""}`}
              onClick={() => {
                onLibrary();
                setOpen(false);
              }}
            >
              Library
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!ready}
              className={menuItemClass}
              onClick={() => {
                onNewPack();
                setOpen(false);
              }}
            >
              New pack
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={reloading}
              className={menuItemClass}
              onClick={() => {
                onReload();
                setOpen(false);
              }}
            >
              {reloading ? "Reloading…" : "Reload content"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
