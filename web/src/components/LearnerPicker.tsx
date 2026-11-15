import { useEffect, useState, type FormEvent } from "react";
import { ApiError, archiveLearner, createLearner, getContent } from "../api";
import type { ContentReply, LearnerInfo, MeReply, Mode } from "../types";
import { Mochi } from "./Mascots";
import { Badge, Button, Card, inputClass } from "./ui";

/* "Who's practicing?" — after login, whenever the session has no learner,
 * and from the app's menu to add or archive one. A learner is adult or kids;
 * picking one opens the app in that mode. A user the CLI made starts with
 * none, so this opens straight on Add. */
export default function LearnerPicker({
  me,
  error,
  onPick,
  onChanged,
  onCancel,
  onLogout,
}: {
  me: MeReply;
  error: string | null;
  onPick: (id: string) => void;
  /** A learner was added or archived: re-read the list. */
  onChanged: () => Promise<void>;
  /** Back to the app without changing learner (only when one is active). */
  onCancel?: () => void;
  onLogout: () => void;
}) {
  const [adding, setAdding] = useState(me.learners.length === 0);
  const [message, setMessage] = useState<string | null>(null);

  async function archive(l: LearnerInfo) {
    if (!window.confirm(`Archive ${l.name}? They leave this list; their profile is kept.`)) return;
    try {
      await archiveLearner(l.id);
      setMessage(null);
      await onChanged();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-4 pt-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <Mochi size={64} mood="happy" />
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold text-fg">Who's practicing?</h1>
        <p className="text-sm text-fg-3">
          Logged in as {me.user?.username}.{" "}
          <button type="button" className="underline hover:text-fg-2" onClick={onLogout}>
            Log out
          </button>
          {onCancel && (
            <>
              {" · "}
              <button type="button" className="underline hover:text-fg-2" onClick={onCancel}>
                Back
              </button>
            </>
          )}
        </p>
      </div>
      {(error || message) && <p className="text-sm text-err">{message ?? error}</p>}
      <ul className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2" data-testid="learner-list">
        {me.learners.map((l) => (
          <li key={l.id}>
            <Card className="flex h-full flex-col gap-2">
              <button type="button" className="flex flex-col items-start gap-1 text-left" onClick={() => onPick(l.id)} data-testid={`pick-${l.name}`}>
                <span className="flex items-center gap-2 font-[family-name:var(--font-display)] text-lg font-semibold text-fg">
                  {l.name}
                  {l.mode === "kids" && <Badge tone="accent">Kids</Badge>}
                  {me.learner?.id === l.id && <Badge>Now</Badge>}
                </span>
                <span className="text-sm text-fg-2">
                  {[l.native_language && l.target_language ? `${l.native_language} → ${l.target_language}` : l.target_language, l.target_variant, l.level].filter(Boolean).join(" · ") || "No languages set yet"}
                </span>
              </button>
              <div className="mt-auto flex justify-end">
                <button type="button" className="text-sm text-fg-3 hover:text-err hover:underline sm:text-xs" onClick={() => void archive(l)}>
                  Archive
                </button>
              </div>
            </Card>
          </li>
        ))}
        <li>
          {adding ? (
            <AddLearner
              onCancel={me.learners.length ? () => setAdding(false) : undefined}
              onAdded={async (l) => {
                setAdding(false);
                await onChanged();
                onPick(l.id);
              }}
            />
          ) : (
            <button
              type="button"
              className="flex h-full min-h-24 w-full items-center justify-center rounded-2xl border border-dashed border-line-strong text-sm font-medium text-fg-2 hover:bg-raised hover:text-fg"
              onClick={() => setAdding(true)}
              data-testid="add-learner"
            >
              + Add a learner
            </button>
          )}
        </li>
      </ul>
    </main>
  );
}

/** The Add form. The language and level pickers come from the chosen mode's
 *  library (its languages.yaml is shared; its levels are not). */
function AddLearner({ onAdded, onCancel }: { onAdded: (l: LearnerInfo) => void | Promise<void>; onCancel?: () => void }) {
  const [mode, setMode] = useState<Mode>("adult");
  const [library, setLibrary] = useState<ContentReply | null>(null);
  const [name, setName] = useState("");
  const [native, setNative] = useState("English");
  const [target, setTarget] = useState("");
  const [variant, setVariant] = useState("");
  const [level, setLevel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getContent(mode).then(
      (c) => {
        if (!live) return;
        setLibrary(c);
        setLevel(c.levels[0] ?? "");
      },
      () => live && setLibrary(null),
    );
    return () => {
      live = false;
    };
  }, [mode]);

  const languages = library?.languages ?? [];
  const variants = languages.find((l) => l.name === target)?.variants ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { learner } = await createLearner({ name, mode, native_language: native, target_language: target, target_variant: variant, level });
      await onAdded(learner);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  const label = "flex flex-col gap-1 text-sm text-fg-2 sm:text-xs";
  return (
    <Card>
      <form className="flex flex-col gap-2.5" onSubmit={(e) => void submit(e)} data-testid="add-learner-form">
        <h2 className="font-medium text-fg">Add a learner</h2>
        <label className={label}>
          Name
          <input className={inputClass} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div role="radiogroup" aria-label="Mode" className="flex rounded-md border border-line p-0.5 text-sm sm:text-xs">
          {(["adult", "kids"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded px-2 py-1 font-medium transition-colors ${mode === m ? "bg-accent text-accent-ink" : "text-fg-2 hover:bg-raised hover:text-fg"}`}
            >
              {m === "adult" ? "Adult" : "Kids"}
            </button>
          ))}
        </div>
        {languages.length > 0 && (
          <>
            <label className={label}>
              Native language
              <select className={inputClass} value={native} onChange={(e) => setNative(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.name}>{l.name}</option>
                ))}
              </select>
            </label>
            <label className={label}>
              Target language
              <select
                className={inputClass}
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setVariant(languages.find((l) => l.name === e.target.value)?.variants[0] ?? "");
                }}
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
                <select className={inputClass} value={variant} onChange={(e) => setVariant(e.target.value)}>
                  {variants.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {library && (
          <label className={label}>
            Level
            <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value)}>
              {library.levels.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="text-sm text-err">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add"}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
