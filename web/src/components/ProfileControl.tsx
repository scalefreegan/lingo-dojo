import { useEffect, useRef, useState } from "react";
import { ApiError, createLanguage } from "../api";
import type { ContentReply, LanguageInfo, LearnerInfo, Mode, ProfileRequest } from "../types";
import {
  OVERRIDE_FIELDS, choosePickerValue, emptyOverrides, formatSessionLine, profileDefault, profileValue, sessionValues, type Draft, type OverrideKey,
} from "../draft";
import { Button, inputClass } from "./ui";

/** Two-letter badge for the pill ("English" → "EN"). The pill is a glance, not
 *  a record: the full line is its tooltip and sits in the popover's selects. */
const CODES: Record<string, string> = {
  English: "EN", Spanish: "ES", French: "FR", German: "DE", Italian: "IT", Portuguese: "PT", Japanese: "JA", "Mandarin Chinese": "ZH",
  Korean: "KO", Dutch: "NL", Russian: "RU", Arabic: "AR", Hindi: "HI", Greek: "EL", Swedish: "SV",
};
const abbr = (name: string) => CODES[name] ?? name.slice(0, 2).toUpperCase();

const MODE_LABELS: Record<Mode, string> = { adult: "Adult", kids: "Kids" };

/* The learner profile as a top-bar control: a compact pill showing the
 * current line, and a popover holding the learner switch, the Name field and
 * the four pickers. Same rules as the old Scene-tab Learner card — picking
 * the profile's own value clears the override (see draft.ts), so a saved
 * pack carries only what differs from the active learner's profile.
 * Switching learner switches mode too: a learner is adult or kids. "Save as
 * my defaults" writes the name and native language to the learner and the
 * variant and level to the active language (the switcher beside this pill
 * picks which). The target language is the language profile's identity
 * (its packs and History are in it), so picking another one here is this
 * pack's override only; to make it the default the popover offers to
 * switch to the learner's profile in that language, or to add one, and
 * never rewrites the current profile. Goals and notes of the active
 * language are edited at the bottom. */
export default function ProfileControl({
  content,
  draft,
  mode,
  learner,
  language,
  learners,
  onSwitchLearner,
  onSwitchLanguage,
  onManageLearners,
  onChange,
  onSaveDefaults,
  onSaveLanguageNotes,
}: {
  content: ContentReply;
  draft: Draft;
  mode: Mode;
  learner: LearnerInfo;
  /** The active language profile, whose defaults the pickers save to. */
  language: LanguageInfo;
  learners: LearnerInfo[];
  onSwitchLearner: (id: string) => void;
  onSwitchLanguage: (id: string) => void;
  onManageLearners: () => void;
  onChange: (d: Draft) => void;
  /** Writes the shown values to the active learner and language; resolves to an error
   *  sentence, or null when the profile (and the draft) now reflect them. */
  onSaveDefaults: (values: ProfileRequest) => Promise<string | null>;
  /** Writes the active language's goals and notes; resolves to an error sentence, or null. */
  onSaveLanguageNotes: (values: { goals: string; notes: string }) => Promise<string | null>;
}) {
  const { profile, languages, levels } = content;
  const session = sessionValues(draft, profile);
  const pickers = languages.length > 0;
  const choose = (key: OverrideKey, value: string) => onChange(choosePickerValue(draft, profile, languages, key, value));
  const setOverride = (key: OverrideKey, value: string) => onChange({ ...draft, overrides: { ...draft.overrides, [key]: value } });
  const fallback = (key: OverrideKey) =>
    key === "native_language" ? profileValue(profile, key) || "English" : profileDefault(profile, key, session.target_language);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const dirty = OVERRIDE_FIELDS.some(({ key }) => session[key] !== profileValue(profile, key));
  const hasOverrides = OVERRIDE_FIELDS.some(({ key }) => draft.overrides[key] !== "");
  // This pack is in another language than the profile's: its defaults can't
  // be saved here (that would relabel this profile, packs and History and
  // all); the learner's profile in that language is where they belong.
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const profileTarget = language.target_language;
  const otherTarget = !!profileTarget.trim() && !!session.target_language.trim() && !same(session.target_language, profileTarget);
  const otherProfile = otherTarget ? learner.languages.find((l) => same(l.target_language, session.target_language)) : undefined;
  const [adding, setAdding] = useState(false);

  const close = () => {
    setOpen(false);
    setSaveMessage(null);
  };

  // Escape closes and hands focus back to the pill. Listening on document
  // (not the panel) so it works wherever focus is, including the selects.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      // Handled: nothing else (an open definition on Go) takes this Escape.
      e.preventDefault();
      setOpen(false);
      setSaveMessage(null);
      pillRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /** Leave this pack's language override behind in this profile's draft
   *  (it was only ever a try-out here), then switch to `id`. */
  function switchTo(id: string) {
    onChange({ ...draft, overrides: { ...draft.overrides, target_language: "", target_variant: "", level: "" } });
    close();
    onSwitchLanguage(id);
  }

  /** Add the pack's language as a new profile of the learner, at the shown
   *  variant and level, and switch to it. */
  async function addTarget() {
    setAdding(true);
    setSaveMessage(null);
    try {
      const { language: made } = await createLanguage(learner.id, {
        target_language: session.target_language, target_variant: session.target_variant, level: session.level,
      });
      switchTo(made.id);
    } catch (e) {
      setSaveMessage({ tone: "err", text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  async function saveDefaults() {
    setSaving(true);
    setSaveMessage(null);
    // The target language only ever names this profile's own (otherTarget
    // disables the button), so the server's identity rule is never hit.
    const error = await onSaveDefaults(session);
    setSaving(false);
    setSaveMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Saved to ${session.learner_name || learner.name}'s ${session.target_language || "language"} profile` });
  }

  const names = languages.map((l) => l.name);
  const variants = languages.find((l) => l.name === session.target_language)?.variants ?? [];
  // "(none)" is offered only when choosing it does something — see draft.ts.
  const noneReachable = profileDefault(profile, "target_variant", session.target_language) === "";
  const variantOptions = noneReachable ? ["", ...variants] : variants;

  const fullLine = [session.learner_name, formatSessionLine(session)].filter(Boolean).join(" · ") || "Not set";
  const shortLine = [mode === "kids" ? "Kids" : "", `${abbr(session.native_language)} → ${abbr(session.target_language)}`, session.level]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="relative">
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Profile: ${MODE_LABELS[mode]} mode, ${fullLine}`}
        title={`${MODE_LABELS[mode]} mode · ${fullLine}`}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="profile-pill"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium transition-colors max-sm:size-10 max-sm:justify-center max-sm:px-0 sm:py-1 sm:text-xs ${
          open || hasOverrides || mode === "kids" ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg"
        }`}
      >
        <PersonGlyph />
        <span className="hidden whitespace-nowrap tabular-nums sm:inline">{shortLine}</span>
      </button>
      {open && (
        <>
          {/* Outside click closes — a full-screen catcher, like the ⋯ menu's; dimmed on a phone where the panel is a sheet. */}
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-40 cursor-default max-sm:bg-black/40" onClick={close} />
          <div
            role="dialog"
            aria-label="Who you are"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-3 overflow-y-auto rounded-t-xl border border-line bg-panel p-4 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:mt-1 sm:max-h-[calc(100vh-4rem)] sm:w-80 sm:rounded-lg sm:shadow-md"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-fg">Who you are</h2>
              <Button variant="ghost" className="sm:text-xs" aria-label="Close" onClick={close}>
                Close
              </Button>
            </div>
            {/* The learner switch: each learner is adult or kids, and its
                mode's library (profile, scenes, units, packs) comes with it.
                Switching reloads everything. */}
            <div role="radiogroup" aria-label="Who's practicing" className="flex flex-wrap gap-1 rounded-md border border-line p-0.5 text-sm sm:text-xs">
              {learners.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={l.id === learner.id}
                  data-testid={`learner-${l.name}`}
                  onClick={() => {
                    if (l.id !== learner.id) {
                      setSaveMessage(null);
                      onSwitchLearner(l.id);
                    }
                  }}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 py-1 font-medium transition-colors ${
                    l.id === learner.id ? "bg-accent text-accent-ink" : "text-fg-2 hover:bg-raised hover:text-fg"
                  }`}
                >
                  <span className="truncate">{l.name}</span>
                  {l.mode === "kids" && <span className="shrink-0 text-[10px] uppercase opacity-80">Kids</span>}
                </button>
              ))}
            </div>
            <p className="-mt-1 flex flex-wrap items-baseline justify-between gap-x-2 text-sm text-fg-3 sm:text-xs">
              <span>{mode === "kids" ? "Kids mode: story, play and short sessions for a child who doesn't read yet." : "Adult mode: conversation practice at a CEFR level."}</span>
              <button type="button" className="hover:text-fg-2 hover:underline" onClick={() => { close(); onManageLearners(); }}>
                Add or manage learners
              </button>
            </p>
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
                Name
                <input
                  className={inputClass}
                  value={session.learner_name}
                  placeholder="Who is practising"
                  onChange={(e) => choose("learner_name", e.target.value)}
                  data-testid="profile-name"
                />
              </label>
              {pickers ? (
                <>
                  <Picker label="Native language" value={session.native_language} options={names} onChange={(v) => choose("native_language", v)} />
                  <Picker label="Target language" value={session.target_language} options={names} onChange={(v) => choose("target_language", v)} />
                  {variants.length === 0 && !session.target_variant ? (
                    <Picker label="Variant" value="" options={[""]} emptyLabel="No variants" disabled onChange={() => {}} />
                  ) : (
                    <Picker label="Variant" value={session.target_variant} options={variantOptions} emptyLabel="(none)" onChange={(v) => choose("target_variant", v)} />
                  )}
                  <Picker label="Level" value={session.level} options={levels} onChange={(v) => choose("level", v)} />
                </>
              ) : (
                OVERRIDE_FIELDS.filter(({ key }) => key !== "learner_name").map(({ key, label }) => (
                  <label key={key} className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
                    {label}
                    <input className={inputClass} value={draft.overrides[key]} placeholder={fallback(key) || "—"} onChange={(e) => setOverride(key, e.target.value)} />
                  </label>
                ))
              )}
            </div>
            {otherTarget ? (
              <div className="flex flex-col gap-2 rounded-md bg-raised p-2.5 text-sm text-fg-2 sm:text-xs" data-testid="other-language">
                <p>
                  This pack practises {session.target_language}; {learner.name}'s current language is {profileTarget}. Each language keeps its own level, packs and History, so{" "}
                  {otherProfile ? `switch to ${learner.name}'s ${otherProfile.target_language} to practise it by default.` : `add ${session.target_language} as a language to practise it by default.`}
                </p>
                <div className="flex flex-wrap gap-2">
                  {otherProfile ? (
                    <Button onClick={() => switchTo(otherProfile.id)} data-testid="switch-to-language">
                      Switch to {otherProfile.target_language}
                    </Button>
                  ) : (
                    <Button onClick={() => void addTarget()} disabled={adding} data-testid="add-target-language">
                      {adding ? "Adding…" : `Add ${session.target_language}`}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-fg-3 sm:text-xs">
                Changes apply to this pack. Save to make them {learner.name}'s defaults{profileTarget ? ` for ${profileTarget}` : ""}.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                onClick={() => void saveDefaults()}
                disabled={!dirty || saving || otherTarget}
                title={otherTarget ? `This pack is in another language than ${profileTarget}` : `Write these values to ${learner.name}'s profile and this language`}
              >
                {saving ? "Saving…" : "Save as my defaults"}
              </Button>
              <button
                type="button"
                disabled={!hasOverrides}
                className="text-sm text-fg-3 hover:text-fg-2 hover:underline disabled:opacity-50 disabled:hover:no-underline sm:text-xs"
                onClick={() => {
                  setSaveMessage(null);
                  onChange({ ...draft, overrides: emptyOverrides() });
                }}
              >
                Reset to defaults
              </button>
            </div>
            {saveMessage && (
              <p className={`text-sm sm:text-xs ${saveMessage.tone === "ok" ? "text-accent" : "text-err"}`} data-testid="profile-message">
                {saveMessage.text}
              </p>
            )}
            <LanguageNotes key={language.id} language={language} onSave={onSaveLanguageNotes} />
          </div>
        </>
      )}
    </div>
  );
}

/** The active language's goals and notes: prose the dojo master reads in
 *  the Learner block, per language (German goals aren't Chinese ones).
 *  Saved on their own, straight to the profile: unlike the pickers they
 *  have no per-pack override. Collapsed until opened. */
function LanguageNotes({ language, onSave }: { language: LanguageInfo; onSave: (values: { goals: string; notes: string }) => Promise<string | null> }) {
  const [goals, setGoals] = useState(language.goals);
  const [notes, setNotes] = useState(language.notes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const dirty = goals !== language.goals || notes !== language.notes;
  const what = language.target_language || "this language";

  async function save() {
    setSaving(true);
    setMessage(null);
    const error = await onSave({ goals, notes });
    setSaving(false);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Saved ${what}'s goals and notes` });
  }

  return (
    <details className="border-t border-line pt-2" data-testid="language-notes">
      <summary className="cursor-pointer text-sm text-fg-2 select-none sm:text-xs">Goals and notes for {what}</summary>
      <div className="mt-2 flex flex-col gap-2.5">
        <label className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
          Goals
          <textarea className={inputClass} rows={2} maxLength={2000} value={goals} placeholder="What you want to be able to do" onChange={(e) => setGoals(e.target.value)} data-testid="language-goals" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
          Notes for the dojo master
          <textarea className={inputClass} rows={2} maxLength={2000} value={notes} placeholder="How you like to be corrected, what to avoid" onChange={(e) => setNotes(e.target.value)} data-testid="language-notes-text" />
        </label>
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={!dirty || saving} data-testid="save-language-notes">
            {saving ? "Saving…" : "Save goals and notes"}
          </Button>
          {message && <span className={`text-sm sm:text-xs ${message.tone === "ok" ? "text-accent" : "text-err"}`}>{message.text}</span>}
        </div>
      </div>
    </details>
  );
}

function PersonGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4 shrink-0">
      <circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 16.5c.6-3 3.1-4.7 6.2-4.7s5.6 1.7 6.2 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A <select> whose shown value is always true: a value outside `options`
 *  (a profile entry languages.yaml doesn't list, or nothing at all) is
 *  prepended rather than snapped to the first option. "" shows as `emptyLabel`. */
function Picker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  emptyLabel = "—",
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const shown = options.includes(value) ? options : [value, ...options];
  return (
    <label className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
      {label}
      <select className={inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {shown.map((o) => (
          <option key={o} value={o}>
            {o || emptyLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
