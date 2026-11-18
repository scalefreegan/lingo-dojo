import { useState } from "react";
import { Mochi } from "./Mascots";
import type { AuthUser, ContentReply, LanguageInfo, LearnerInfo, Mode, ProfileRequest } from "../types";
import type { Draft } from "../draft";
import { Button } from "./ui";
import LanguageSwitcher from "./LanguageSwitcher";
import ProfileControl from "./ProfileControl";
import type { Tab } from "./shared";
import { toggled, useTheme, type ThemeChoice } from "../theme";

/* The top bar: the app's name (with a "Kids" tag when that library is
 * open), the three-step flow as tabs, Library off to the side (it's a
 * destination, not a step), and the two actions that touch the whole draft
 * (New pack, Reload content) tucked behind "…" so they don't compete with
 * the tabs for attention. Below `md` Library moves into that "…" menu — the
 * bar can't hold four tabs and the menu on a phone, nor beside the Profile
 * pill on a small tablet — and the three flow tabs scroll in their own strip
 * rather than widening the page. The language switcher sits beside the
 * Profile pill: which of the learner's languages this session practises.
 * Practice (flashcards over the phrase bank) is a destination too, beside
 * Library and in the menu with it below `md`; kids learners don't have it
 * (docs/DATA.md §Kids learners). The sun/moon button flips light and dark
 * in one tap (from `sm` up; a phone's bar has no room), and the menu's
 * Appearance row has all three choices, Auto (follow the system) included. */
export default function TopBar({
  tab,
  onTab,
  onNewPack,
  onReload,
  reloading,
  ready,
  mode,
  user,
  learner,
  language,
  learners,
  onSwitchLearner,
  onSwitchLanguage,
  onLanguagesChanged,
  onManageLearners,
  onLogout,
  content,
  draft,
  onChange,
  onSaveDefaults,
  onSaveLanguageNotes,
  onSaveLevel,
  packLevel,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onNewPack: () => void;
  onReload: () => void;
  reloading: boolean;
  ready: boolean;
  mode: Mode;
  user: AuthUser;
  learner: LearnerInfo;
  language: LanguageInfo;
  learners: LearnerInfo[];
  onSwitchLearner: (id: string) => void;
  onSwitchLanguage: (id: string) => void;
  onLanguagesChanged: () => Promise<void> | void;
  onManageLearners: () => void;
  onLogout: () => void;
  /** Null until the first load; the Profile pill appears with them. */
  content: ContentReply | null;
  draft: Draft | null;
  onChange: (d: Draft) => void;
  onSaveDefaults: (values: ProfileRequest) => Promise<string | null>;
  onSaveLanguageNotes: (values: { goals: string; notes: string }) => Promise<string | null>;
  /** The language menu's level, saved to the active language. */
  onSaveLevel: (level: string) => Promise<string | null>;
  /** The loaded pack's own level, when it sets one (it overrides the language's). */
  packLevel: string | null;
}) {
  return (
    // On a phone everything is a little tighter, so the Kids tag still
    // leaves room for all three tabs (Go was pushed out of sight).
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3 sm:gap-2 sm:px-4 sm:pr-10">
      {/* The frosted background is a layer of its own, never the header's:
          a backdrop-filter makes its element the box that position:fixed
          descendants are placed in, which squeezed the menus' full-screen
          click-away catchers (and a phone's bottom sheets) into this 56px
          bar, so a click on the page didn't close a menu. Behind the bar's
          content (the sticky z-30 header is its stacking context). Solid
          where the browser can't blur, so page text never shows through.
          Keep filters off the header and any wrapper of its menus, or the
          trap comes back. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-panel backdrop-blur supports-[backdrop-filter]:bg-panel/90" />
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
        {content && (
          <LanguageSwitcher learner={learner} language={language} languages={content.languages} levels={content.levels} defaultLevel={content.defaultLevel} onSwitch={onSwitchLanguage} onChanged={onLanguagesChanged} onSaveLevel={onSaveLevel} packLevel={packLevel} />
        )}
        {content && draft && (
          <ProfileControl content={content} draft={draft} mode={mode} learner={learner} language={language} learners={learners} onSwitchLearner={onSwitchLearner}
            onSwitchLanguage={onSwitchLanguage} onManageLearners={onManageLearners} onChange={onChange} onSaveDefaults={onSaveDefaults} onSaveLanguageNotes={onSaveLanguageNotes} />
        )}
        {mode !== "kids" && <TabButton label="Practice" active={tab === "practice"} onClick={() => onTab("practice")} className="hidden md:flex" />}
        <TabButton label="Library" active={tab === "library"} onClick={() => onTab("library")} className="hidden md:flex" />
        <ThemeToggle />
        <OverflowMenu onNewPack={onNewPack} onReload={onReload} reloading={reloading} ready={ready} libraryActive={tab === "library"} onLibrary={() => onTab("library")}
          practiceActive={mode === "kids" ? null : tab === "practice"} onPractice={() => onTab("practice")} username={user.username} onManageLearners={onManageLearners} onLogout={onLogout} />
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

/** One tap to the other scheme. The icon is what you get: a moon while
 *  it's light, a sun while it's dark. */
function ThemeToggle() {
  const { scheme, setChoice } = useTheme();
  const label = scheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Button variant="ghost" className="max-sm:hidden" aria-label={label} title={label} onClick={() => setChoice(toggled(scheme))} data-testid="theme-toggle">
      {scheme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  );
}

const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The menu's Appearance row: Auto, Light, Dark as one segmented control.
 *  It stays open on a pick, so the change is seen in place. Inside a menu
 *  the choices are menuitemradio in a group (a menu may not own a
 *  radiogroup: screen readers skip or misread one there). */
function ThemeChoices() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="border-b border-line px-3 pt-2 pb-2.5">
      <p className="mb-1.5 text-sm text-fg-3 sm:text-xs" id="appearance-label">
        Appearance
      </p>
      <div role="group" aria-labelledby="appearance-label" className="flex rounded-full bg-raised p-0.5">
        {THEME_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="menuitemradio"
            aria-checked={choice === c.value}
            title={c.value === "auto" ? "Follow the system's light or dark setting" : undefined}
            className={`flex-1 rounded-full px-1.5 py-1 text-sm transition-colors sm:text-xs ${
              choice === c.value ? "bg-panel font-medium text-accent shadow-[0_1px_2px_rgb(26_28_58/0.12)]" : "text-fg-3 hover:text-fg"
            }`}
            onClick={() => setChoice(c.value)}
            data-testid={`theme-${c.value}`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const menuItemClass = "px-3 py-2 text-left text-sm text-fg-2 hover:bg-raised disabled:opacity-50";

/** New pack and Reload content: whole-draft actions, not part of the Scene →
 *  Customize → Go flow, so they live behind an overflow toggle instead of
 *  sitting next to the tabs. Library joins them below `md`, where the bar
 *  has no room for its tab. The account's two actions (Who's practicing?,
 *  Log out) close the menu, under the username. */
function OverflowMenu({
  onNewPack,
  onReload,
  reloading,
  ready,
  libraryActive,
  onLibrary,
  practiceActive,
  onPractice,
  username,
  onManageLearners,
  onLogout,
}: {
  onNewPack: () => void;
  onReload: () => void;
  reloading: boolean;
  ready: boolean;
  libraryActive: boolean;
  onLibrary: () => void;
  /** Whether Practice is open; null when the learner has none (kids). */
  practiceActive: boolean | null;
  onPractice: () => void;
  username: string;
  onManageLearners: () => void;
  onLogout: () => void;
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
          <div role="menu" className="absolute right-0 z-50 mt-1 flex w-52 flex-col overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-lg">
            <ThemeChoices />
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
            {practiceActive !== null && (
              <button
                type="button"
                role="menuitem"
                aria-current={practiceActive ? "page" : undefined}
                className={`${menuItemClass} border-b border-line md:hidden ${practiceActive ? "font-medium text-fg" : ""}`}
                onClick={() => {
                  onPractice();
                  setOpen(false);
                }}
              >
                Practice
              </button>
            )}
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
            <p className="mt-1 truncate border-t border-line px-3 pt-2 pb-1 text-sm text-fg-3 sm:text-xs" data-testid="account-name">
              Logged in as {username}
            </p>
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                onManageLearners();
                setOpen(false);
              }}
            >
              Who's practicing?
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                onLogout();
                setOpen(false);
              }}
            >
              Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
