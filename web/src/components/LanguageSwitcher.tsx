import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, archiveLanguage, createLanguage } from "../api";
import { languageLine } from "../draft";
import type { Language, LanguageInfo, LearnerInfo } from "../types";
import { Button, inputClass } from "./ui";

/* The top bar's language switcher: which of the learner's languages this
 * session practises. Each language is its own profile (level, variant,
 * goals) with its own packs, drafts and History, so switching reloads the
 * app like a learner switch does (AuthGate keys App by the language). The
 * menu also adds a language and archives the current one; a learner keeps
 * at least one, so the last can't be archived. */
export default function LanguageSwitcher({
  learner,
  language,
  languages,
  levels,
  defaultLevel = "",
  onSwitch,
  onChanged,
}: {
  learner: LearnerInfo;
  /** The session's active language: one of learner.languages. */
  language: LanguageInfo;
  /** The library's languages and the mode's levels, for the Add form. */
  languages: Language[];
  levels: string[];
  /** The level the Add form starts at ("" = the first of `levels`). */
  defaultLevel?: string;
  onSwitch: (languageId: string) => void;
  /** A language was archived: re-read who's practising (the server moved
   *  this session to another of the learner's languages). */
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setAdding(false);
    setMessage(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      // Handled: nothing else (an open definition on Go) takes this Escape.
      e.preventDefault();
      setOpen(false);
      setAdding(false);
      setMessage(null);
      pillRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function archive() {
    if (!window.confirm(`Archive ${language.target_language || "this language"} for ${learner.name}? It leaves this list; its packs and History are kept.`)) return;
    try {
      await archiveLanguage(learner.id, language.id);
      close();
      await onChanged();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="relative">
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Language: ${languageLine(language)}`}
        title={`${learner.name} is practising ${[language.target_language, language.target_variant, language.level].filter(Boolean).join(" · ")}`}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="language-pill"
        className={`inline-flex max-w-44 items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-medium transition-colors sm:text-xs ${
          open ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg"
        }`}
      >
        <span className="truncate whitespace-nowrap">{languageLine(language)}</span>
        <span aria-hidden="true" className="text-[10px] opacity-70">
          ▾
        </span>
      </button>
      {open && (
        <>
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-40 cursor-default max-sm:bg-black/40" onClick={close} />
          <div
            role="dialog"
            aria-label={`${learner.name}'s languages`}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-3 overflow-y-auto rounded-t-xl border border-line bg-panel p-4 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:mt-1 sm:max-h-[calc(100vh-4rem)] sm:w-72 sm:rounded-lg sm:shadow-md"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-fg">{learner.name}'s languages</h2>
              <Button variant="ghost" className="sm:text-xs" aria-label="Close" onClick={close}>
                Close
              </Button>
            </div>
            <div role="radiogroup" aria-label="Practising" className="flex flex-col gap-1">
              {learner.languages.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={l.id === language.id}
                  data-testid={`language-${l.target_language}`}
                  onClick={() => {
                    if (l.id === language.id) return;
                    close();
                    onSwitch(l.id);
                  }}
                  className={`flex flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm transition-colors sm:text-xs ${
                    l.id === language.id ? "bg-accent text-accent-ink" : "text-fg-2 hover:bg-raised hover:text-fg"
                  }`}
                >
                  <span className="font-medium">{languageLine(l)}</span>
                  {l.target_variant && <span className="opacity-80">{l.target_variant}</span>}
                </button>
              ))}
            </div>
            {adding ? (
              <AddLanguage
                learnerId={learner.id}
                languages={languages}
                levels={levels}
                defaultLevel={defaultLevel}
                taken={learner.languages.map((l) => l.target_language)}
                onCancel={() => setAdding(false)}
                onAdded={(l) => {
                  close();
                  onSwitch(l.id);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button onClick={() => setAdding(true)} data-testid="add-language">
                  + Add a language
                </Button>
                {learner.languages.length > 1 && (
                  <button type="button" className="text-sm text-fg-3 hover:text-err hover:underline sm:text-xs" onClick={() => void archive()} data-testid="archive-language">
                    Archive {language.target_language || "this one"}
                  </button>
                )}
              </div>
            )}
            {message && <p className="text-sm text-err sm:text-xs">{message}</p>}
            <p className="text-sm text-fg-3 sm:text-xs">Each language keeps its own level, packs, History and phrase bank. Change this one's level, variant, goals and notes under the profile pill.</p>
          </div>
        </>
      )}
    </div>
  );
}

/** Target language, variant and level, for a new learner's first language
 *  and for a language added later: picked from languages.yaml, or typed when
 *  the library has none (the loader's documented fallback: the profile
 *  popover shows free-text fields then too), so the forms still submit. */
export function LanguageFields({
  languages,
  levels,
  value,
  onChange,
}: {
  languages: Language[];
  levels: string[];
  value: { target_language: string; target_variant: string; level: string };
  onChange: (v: { target_language: string; target_variant: string; level: string }) => void;
}) {
  const variants = languages.find((l) => l.name === value.target_language)?.variants ?? [];
  const label = "flex flex-col gap-1 text-sm text-fg-2 sm:text-xs";
  if (languages.length === 0) {
    return (
      <>
        <label className={label}>
          Target language
          <input className={inputClass} maxLength={80} value={value.target_language} placeholder="e.g. German" onChange={(e) => onChange({ ...value, target_language: e.target.value })} data-testid="language-target" />
        </label>
        <label className={label}>
          Variant
          <input className={inputClass} maxLength={80} value={value.target_variant} placeholder="optional" onChange={(e) => onChange({ ...value, target_variant: e.target.value })} />
        </label>
        <LevelField levels={levels} value={value} onChange={onChange} />
      </>
    );
  }
  return (
    <>
      <label className={label}>
        Target language
        <select
          className={inputClass}
          value={value.target_language}
          required
          onChange={(e) => onChange({ ...value, target_language: e.target.value, target_variant: languages.find((l) => l.name === e.target.value)?.variants[0] ?? "" })}
          data-testid="language-target"
        >
          <option value="">—</option>
          {languages.map((l) => (
            <option key={l.name}>{l.name}</option>
          ))}
        </select>
      </label>
      {variants.length > 0 && (
        <label className={label}>
          Variant
          <select className={inputClass} value={value.target_variant} onChange={(e) => onChange({ ...value, target_variant: e.target.value })}>
            {variants.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      <LevelField levels={levels} value={value} onChange={onChange} />
    </>
  );
}

type LanguageValue = { target_language: string; target_variant: string; level: string };

/** The mode's levels as a select, or a text field for a mode with none. */
function LevelField({ levels, value, onChange }: { levels: string[]; value: LanguageValue; onChange: (v: LanguageValue) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-fg-2 sm:text-xs">
      Level
      {levels.length > 0 ? (
        <select className={inputClass} value={value.level} onChange={(e) => onChange({ ...value, level: e.target.value })} data-testid="language-level">
          {levels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      ) : (
        <input className={inputClass} maxLength={80} value={value.level} onChange={(e) => onChange({ ...value, level: e.target.value })} data-testid="language-level" />
      )}
    </label>
  );
}

function AddLanguage({
  learnerId,
  languages,
  levels,
  defaultLevel,
  taken,
  onCancel,
  onAdded,
}: {
  learnerId: string;
  languages: Language[];
  levels: string[];
  defaultLevel: string;
  /** The learner's languages already: not offered (one profile per target
   *  language; a variant is a setting inside it). Typed in, the server
   *  refuses one with a 409 that says so. */
  taken: string[];
  onCancel: () => void;
  onAdded: (l: LanguageInfo) => void;
}) {
  const [value, setValue] = useState({ target_language: "", target_variant: "", level: defaultLevel || (levels[0] ?? "") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offered = languages.filter((l) => !taken.some((t) => t.trim().toLowerCase() === l.name.toLowerCase()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { language } = await createLanguage(learnerId, value);
      onAdded(language);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2.5 rounded-md border border-line p-3" onSubmit={(e) => void submit(e)} data-testid="add-language-form">
      <h3 className="text-sm font-medium text-fg">Add a language</h3>
      <LanguageFields languages={offered} levels={levels} value={value} onChange={setValue} />
      {error && <p className="text-sm text-err sm:text-xs">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !value.target_language}>
          {busy ? "Adding…" : "Add and switch"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
