import { useState } from "react";
import { exportPack, type VoiceLanguages } from "../api";
import { splitPackId } from "../draft";
import type { AssembleResult, ContentReply, ExportResult, PackInput } from "../types";
import { useCopyStatus } from "../useCopyStatus";
import { Button, Card, FolderSelect, inputClass } from "./ui";
import type { PackStatus, SaveOutcome } from "./shared";
import VoicePanel from "./VoicePanel";

/* Go tab: the calm, final screen. Practising here in the dojo is the main
 * action; copying the prompt to paste into another voice app is the
 * alternative, a small copy icon on the scene card. Then the ways to keep it
 * (save, export), and the literal markdown behind a toggle. */
export default function GoTab({
  content,
  pack,
  title,
  sourceId,
  sceneTitle,
  learnerLine,
  notes,
  onNotes,
  exportId,
  result,
  pending,
  error,
  folders,
  packStatus,
  saveRequest,
  onSave,
  langs,
  practiceRequest = false,
  onPracticeOpened,
}: {
  content: ContentReply;
  pack: PackInput;
  title: string;
  sourceId: string | null;
  sceneTitle: string;
  learnerLine: string;
  notes: string;
  onNotes: (notes: string) => void;
  /** The id Export writes to: the saved pack's stem, else date + slug. */
  exportId: string;
  result: AssembleResult | null;
  pending: boolean;
  error: string | null;
  folders: string[];
  packStatus: PackStatus | null;
  /** Bumped by the parent to open the save form with a suggested title and folder (Clone). */
  saveRequest: { title: string; folder: string; seq: number } | null;
  onSave: (title: string, folder: string, overwrite: boolean) => Promise<SaveOutcome>;
  /** The session languages, for the voice panel's locale. */
  langs: VoiceLanguages;
  /** Open the voice session straight away (the sticky bar's Practice). */
  practiceRequest?: boolean;
  onPracticeOpened?: () => void;
}) {
  const [copyStatus, copy] = useCopyStatus();
  const [showPrompt, setShowPrompt] = useState(false);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const markdown = result?.markdown ?? "";

  async function doExport() {
    setExporting(true);
    setExportError(null);
    try {
      setExported(await exportPack(content.mode, exportId, pack));
    } catch (e) {
      setExported(null);
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="flex-1 text-base font-medium text-fg">{sceneTitle || "No scene"}</h2>
          <button
            type="button"
            className="-mt-1 -mr-1 shrink-0 rounded-md px-2 py-1 text-base text-fg-3 hover:bg-raised hover:text-fg-2 disabled:opacity-40"
            onClick={() => copy(markdown)}
            disabled={!markdown}
            aria-label={copyStatus === "copied" ? "Prompt copied" : copyStatus === "failed" ? "Copy failed" : "Copy prompt"}
            title="Copy the prompt, to paste into ChatGPT or Claude voice instead"
            data-testid="copy-prompt"
          >
            {copyStatus === "copied" ? "✓" : copyStatus === "failed" ? "!" : "⧉"}
          </button>
        </div>
        <p className="text-sm text-fg-2">{learnerLine || "Learner not set"}</p>
        <p className="text-sm text-fg-3 tabular-nums">
          {pack.units.length} unit{pack.units.length === 1 ? "" : "s"}
          {result && ` · ${result.stats.words.toLocaleString()} words · ~${result.stats.tokens.toLocaleString()} tokens`}
          {pending && " · updating"}
        </p>
      </Card>

      {error && <p className="rounded-md bg-err-soft p-3 text-sm text-err">Could not assemble: {error}</p>}
      {result && result.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-warn-soft p-3 text-sm text-warn" aria-label="Warnings">
          {result.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <NotesDisclosure notes={notes} onChange={onNotes} />

      {/* The main event: the session here, with native voices. */}
      <VoicePanel mode={content.mode} pack={pack} langs={langs} openRequest={practiceRequest} onOpened={onPracticeOpened} />

      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          key={saveRequest?.seq ?? 0}
          initialOpen={saveRequest != null}
          suggested={saveRequest?.title ?? (title || defaultTitle(content, pack))}
          // A loaded pack saves back into its own folder unless told otherwise.
          suggestedFolder={saveRequest?.folder ?? (sourceId ? splitPackId(sourceId).folder : "")}
          folders={folders}
          onSave={onSave}
        />
        <Button onClick={() => void doExport()} disabled={!markdown || exporting}>
          {exporting ? "Exporting…" : "Export file"}
        </Button>
      </div>
      {exported && (
        <p className="text-sm text-fg-2 sm:text-xs" data-testid="export-path">
          Exported to <code className="font-mono break-all">{exported.path}</code>
        </p>
      )}
      {exportError && <p className="text-sm text-err sm:text-xs">Export failed: {exportError}</p>}

      {packStatus && (
        <p className={`text-sm sm:text-xs ${packStatus.tone === "ok" ? "text-accent" : "text-err"}`} data-testid="packs-status">
          {packStatus.text}
        </p>
      )}

      <div>
        <button type="button" className="text-sm text-fg-3 hover:text-fg-2 hover:underline" aria-expanded={showPrompt} onClick={() => setShowPrompt((o) => !o)}>
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
        {showPrompt && (
          // Wraps, and breaks an unbroken token (a URL, a long slug) rather
          // than widening the page; only ever scrolls vertically.
          <pre
            data-testid="preview"
            className="mt-2 max-h-96 overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-panel p-4 font-mono text-sm leading-relaxed wrap-break-word whitespace-pre-wrap text-fg sm:text-[12.5px]"
          >
            {markdown || (pending ? "Assembling…" : "")}
          </pre>
        )}
      </div>
    </div>
  );
}

/** A title to start the save form with: the scenario's, else a generic one. */
function defaultTitle(content: ContentReply, pack: PackInput): string {
  if (pack.quick_scenario.trim()) return pack.quick_scenario.trim().split("\n")[0].slice(0, 60);
  return content.scenarios.find((s) => s.id === pack.scenario)?.title ?? "";
}

/** "Save pack" asks for a title and a folder inline (no window.prompt: a
 *  modal dialog blocks the page and browser automation). A clash with
 *  another saved pack asks once more before overwriting. */
function SaveButton({
  initialOpen,
  suggested,
  suggestedFolder,
  folders,
  onSave,
}: {
  initialOpen: boolean;
  suggested: string;
  suggestedFolder: string;
  folders: string[];
  onSave: (title: string, folder: string, overwrite: boolean) => Promise<SaveOutcome>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [value, setValue] = useState(suggested);
  const [folder, setFolder] = useState(suggestedFolder);
  const [conflict, setConflict] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(overwrite: boolean) {
    if (!value.trim()) return;
    setBusy(true);
    setMessage(null);
    const r = await onSave(value.trim(), folder, overwrite);
    setBusy(false);
    if (r.ok) {
      setOpen(false);
      setConflict(null);
    } else if ("conflict" in r) {
      setConflict(r.conflict);
    } else {
      setMessage(r.error);
    }
  }

  if (!open) {
    return (
      <>
        <Button
          onClick={() => {
            setValue(suggested);
            setFolder(suggestedFolder);
            setOpen(true);
            setMessage(null);
          }}
        >
          Save pack
        </Button>
        {message && (
          <span className="text-sm text-err sm:text-xs" data-testid="save-message">
            {message}
          </span>
        )}
      </>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <input
        autoFocus
        aria-label="Pack title"
        className={`${inputClass} min-w-48 flex-1`}
        placeholder="Pack title"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setConflict(null);
        }}
      />
      <FolderSelect
        label="Folder"
        value={folder}
        folders={folders}
        onChange={(f) => {
          setFolder(f);
          setConflict(null);
        }}
      />
      {conflict ? (
        <>
          <span className="text-sm text-warn sm:text-xs">{conflict} already exists.</span>
          <Button variant="primary" disabled={busy} onClick={() => void submit(true)}>
            Overwrite
          </Button>
        </>
      ) : (
        <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      )}
      <Button variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {message && <span className="w-full text-sm text-err sm:text-xs">{message}</span>}
    </form>
  );
}

/** Collapsed behind a button until there's something to say (or it's loaded
 *  with a note already) — a textarea nobody's going to use is pure clutter.
 *  Lives above Copy so the note is the last thing you touch before pasting. */
function NotesDisclosure({ notes, onChange }: { notes: string; onChange: (notes: string) => void }) {
  const [open, setOpen] = useState(notes.trim().length > 0);
  if (!open) {
    return (
      <button type="button" className="self-start text-sm text-fg-3 hover:text-fg-2 hover:underline" onClick={() => setOpen(true)}>
        Add a note for the dojo master
      </button>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-sm text-fg-2">
      Note for the dojo master
      <textarea
        autoFocus
        className={`${inputClass} min-h-20`}
        placeholder="Today I'd like extra practice with prices and numbers."
        value={notes}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
