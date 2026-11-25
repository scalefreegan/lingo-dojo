import { useEffect, useState, type FormEvent } from "react";
import { ApiError, listDeletedPacks, undeletePack } from "../api";
import HistoryView from "./HistoryView";
import PhraseBankView from "./PhraseBankView";
import { clearBankRequest, onOpenBank, peekBankRequest } from "../bankLink";
import { slugify, splitPackId, unitCount } from "../draft";
import type { ContentReply, ConversationSummary, DeletedPack, Mode, Pack } from "../types";
import { Badge, Button, FolderSelect, TrashGlyph, inputClass } from "./ui";
import type { PackActions } from "./shared";

/** The small button style every row and header action here uses. */
const small = "px-2 py-1 text-sm sm:text-xs";
/** Meta text (folder headers, the date · scene · units line, the row menu). */
const fine = "text-sm sm:text-xs";

type LibraryProps = PackActions & {
  packs: Pack[];
  folders: string[];
  content: ContentReply;
  currentId: string | null;
  mode: Mode;
  /** A deleted pack was restored: re-list the packs. */
  onRestored: (p: Pack) => Promise<void>;
  /** A restore was refused as stale (409): re-list the packs. */
  onStale: () => Promise<void>;
  /** History's Practice again: that session's pack into the Go tab. */
  onPracticeAgain: (c: ConversationSummary) => Promise<void>;
};

/* Library tab: two views. Saved packs, every one grouped by folder ("No
 * folder" first), with a toolbar to make a folder, and the recently deleted
 * packs below with Restore (the one-line outcome of an action lives on the
 * Go tab, where saving happens). History, the learner's saved voice
 * sessions (HistoryView). And the phrase bank (PhraseBankView): the
 * active language's phrases with how well each is known. */
type LibraryView = "packs" | "history" | "bank";
const VIEW_KEY = "lingo-dojo.library-view.v1";

function savedView(): LibraryView {
  try {
    const v = sessionStorage.getItem(VIEW_KEY);
    return v === "history" || v === "bank" ? v : "packs";
  } catch {
    return "packs";
  }
}

export default function LibraryTab(props: LibraryProps) {
  // A search for the bank asked from elsewhere (bankLink.ts: a session
  // recap's "In the bank") opens it there; `bankAsk` remounts the bank
  // view with the words.
  // Remembered while the page's tab is open, so a reload comes back to it.
  const [view, setViewState] = useState<LibraryView>(() => (peekBankRequest() != null ? "bank" : savedView()));
  const setView = (v: LibraryView) => {
    setViewState(v);
    try {
      sessionStorage.setItem(VIEW_KEY, v);
    } catch {
      /* blocked storage: the Library opens on the packs */
    }
  };
  const [bankAsk, setBankAsk] = useState<{ q: string; n: number }>(() => ({ q: peekBankRequest() ?? "", n: 0 }));
  useEffect(() => {
    const take = () => {
      const q = peekBankRequest();
      if (q == null) return;
      clearBankRequest();
      setBankAsk((was) => ({ q, n: was.n + 1 }));
      setView("bank");
    };
    take();
    return onOpenBank(take);
  }, []);
  const tabClass = (on: boolean) =>
    `rounded-lg px-3 py-1 text-sm font-medium transition-colors ${on ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-raised hover:text-fg"}`;
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Library" className="flex gap-1 self-start rounded-xl border border-line bg-panel p-1">
        <button type="button" role="tab" aria-selected={view === "packs"} className={tabClass(view === "packs")} onClick={() => setView("packs")}>
          Saved packs
        </button>
        <button type="button" role="tab" aria-selected={view === "history"} className={tabClass(view === "history")} onClick={() => setView("history")} data-testid="library-history">
          History
        </button>
        <button type="button" role="tab" aria-selected={view === "bank"} className={tabClass(view === "bank")} onClick={() => setView("bank")} data-testid="library-bank">
          Phrase bank
        </button>
      </div>
      {view === "history" ? (
        <HistoryView bankLanguage={props.content.profile?.target_language} kids={props.mode === "kids"} onPracticeAgain={props.onPracticeAgain} />
      ) : view === "bank" ? (
        <PhraseBankView key={bankAsk.n} initialQuery={bankAsk.q} />
      ) : (
        <PacksView {...props} />
      )}
    </div>
  );
}

function PacksView({
  packs,
  folders,
  content,
  currentId,
  onCreateFolder,
  onDeleteFolder,
  mode,
  onRestored,
  onStale,
  onPracticeAgain: _practiceAgain,
  onDelete,
  ...row
}: LibraryProps) {
  // null = closed; otherwise the name being typed.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last pack deleted here, for its Undo line. A delete is a revision
  // (docs/DATA.md §Packs), so Undo is the undelete Recently deleted offers,
  // of that pack's newest deletion.
  const [undo, setUndo] = useState<{ id: string; title: string; state: "ready" | "busy" | "error"; error?: string } | null>(null);

  async function remove(p: Pack): Promise<boolean> {
    const ok = await onDelete(p.id);
    setUndo(ok ? { id: p.id, title: p.title, state: "ready" } : null);
    return ok;
  }

  async function undoDelete() {
    if (!undo) return;
    const { id, title } = undo;
    setUndo({ id, title, state: "busy" });
    try {
      const { packs: gone } = await listDeletedPacks(mode);
      const latest = gone.find((d) => d.pack.id === id);
      if (!latest) throw new Error("it isn't in Recently deleted any more");
      const r = await undeletePack(mode, latest.revision);
      setUndo(null);
      await onRestored(r.pack);
    } catch (e) {
      setUndo({ id, title, state: "error", error: e instanceof ApiError ? e.message : String((e as Error)?.message ?? e) });
      if (e instanceof ApiError && e.status === 409) await onStale();
    }
  }
  // Every folder on disk plus any a pack names (one the list has not caught
  // up with yet): "No folder" first, the rest alphabetical.
  const names = [...new Set([...folders, ...packs.map((p) => p.folder).filter(Boolean)])].sort();
  const groups = ["", ...names].map((folder) => ({
    folder,
    // Newest first: stems start with the date.
    packs: packs.filter((p) => p.folder === folder).sort((a, b) => b.id.localeCompare(a.id)),
  }));
  const slug = slugify(newFolder ?? "", "");

  async function submitFolder(e: FormEvent) {
    e.preventDefault();
    if (!slug) return;
    setBusy(true);
    if (await onCreateFolder(slug)) setNewFolder(null);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-fg">
          Saved packs <span className="text-fg-3">({packs.length})</span>
        </h2>
        {/* The open form takes a row of its own on a phone (basis-full in the
            wrapping header) instead of squeezing in beside the heading. */}
        <div className={`ml-auto flex items-center gap-2 ${newFolder === null ? "" : "max-sm:basis-full"}`} data-testid="packs-toolbar">
          {newFolder === null ? (
            <Button variant="ghost" className={small} onClick={() => setNewFolder("")}>
              New folder
            </Button>
          ) : (
            <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(e) => void submitFolder(e)}>
              <input
                autoFocus
                aria-label="Folder name"
                className={`${inputClass} min-w-32 flex-1`}
                placeholder="Folder name"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
              />
              {/* The name is slugified like a pack title; show the result when it differs. */}
              {slug && slug !== newFolder && <span className={`font-mono ${fine} text-fg-3`}>{slug}</span>}
              <Button type="submit" variant="primary" className={small} disabled={busy || !slug}>
                Create
              </Button>
              <Button variant="ghost" className={small} onClick={() => setNewFolder(null)}>
                Cancel
              </Button>
            </form>
          )}
        </div>
      </div>

      {undo && (
        <p role="status" className={`flex flex-wrap items-center gap-x-2 rounded-md bg-raised px-3 py-2 text-sm ${undo.state === "error" ? "text-err" : "text-fg-2"}`} data-testid="pack-deleted">
          {undo.state === "error" ? (
            <span>Couldn't undo: {undo.error}</span>
          ) : (
            <>
              <span className="min-w-0 truncate">Deleted “{undo.title}”.</span>
              <button type="button" className="font-medium text-accent hover:underline disabled:opacity-50" disabled={undo.state === "busy"} onClick={() => void undoDelete()} data-testid="pack-undo">
                {undo.state === "busy" ? "Restoring…" : "Undo"}
              </button>
            </>
          )}
          <button type="button" className="ml-auto text-fg-3 hover:text-fg-2" aria-label="Dismiss" onClick={() => setUndo(null)}>
            ×
          </button>
        </p>
      )}

      {packs.length === 0 && names.length === 0 ? (
        <p className="text-sm text-fg-3">None yet. Save one on the Go tab to reopen it later.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line" aria-label="Saved packs">
          {groups.map(
            (g) =>
              (g.folder || g.packs.length > 0) && (
                <section key={g.folder || "/"} aria-label={g.folder || "No folder"} data-testid={`folder-${g.folder || "none"}`}>
                  <header className={`flex items-center gap-2 bg-raised px-4 py-1.5 ${fine} font-medium text-fg-2`}>
                    <span className={g.folder ? "font-mono" : ""}>{g.folder || "No folder"}</span>
                    <span className="text-fg-3">({g.packs.length})</span>
                    {g.folder && g.packs.length === 0 && (
                      <Button variant="ghost" className={`ml-auto ${small} py-0.5`} onClick={() => void onDeleteFolder(g.folder)}>
                        Delete folder
                      </Button>
                    )}
                  </header>
                  <ul>
                    {g.packs.map((p) => (
                      <PackRow key={p.id} pack={p} content={content} open={p.id === currentId} folders={names} {...row} onDelete={() => remove(p)} />
                    ))}
                  </ul>
                </section>
              ),
          )}
        </div>
      )}
      <RecentlyDeleted mode={mode} packs={packs} onRestored={onRestored} onStale={onStale} />
    </div>
  );
}

/** The soft-deleted packs (newest first, a page at a time with "More"), each
 *  with Restore (an undelete), folded away until opened. The list is re-read
 *  whenever the saved packs change (a delete or a restore re-lists them), so
 *  it never needs its own refresh. A restore that fails says why in place;
 *  a 409 also means this list was stale (the pack came back on another
 *  device, or its id was taken), so the lists are re-read. */
function RecentlyDeleted({
  mode,
  packs,
  onRestored,
  onStale,
}: {
  mode: Mode;
  packs: Pack[];
  onRestored: (p: Pack) => Promise<void>;
  onStale: () => Promise<void>;
}) {
  const [deleted, setDeleted] = useState<DeletedPack[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listDeletedPacks(mode).then(
      (r) => {
        if (!live) return;
        setDeleted(r.packs);
        setNext(r.next);
      },
      () => live && (setDeleted([]), setNext(null)),
    );
    return () => {
      live = false;
    };
  }, [mode, packs]);

  async function more() {
    if (next === null) return;
    try {
      const r = await listDeletedPacks(mode, next);
      setDeleted((d) => [...d, ...r.packs.filter((p) => !d.some((x) => x.revision === p.revision))]);
      setNext(r.next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function restore(d: DeletedPack) {
    setBusy(d.revision);
    setError(null);
    try {
      const r = await undeletePack(mode, d.revision);
      await onRestored(r.pack);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      if (e instanceof ApiError && e.status === 409) await onStale();
    } finally {
      setBusy(null);
    }
  }

  if (deleted.length === 0) return null;
  return (
    <section aria-label="Recently deleted" data-testid="recently-deleted" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" className={small} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Recently deleted <span className="text-fg-3">({deleted.length})</span>
        </Button>
      </div>
      {open && (
        <>
          {error && <p className={`${fine} text-err`}>{error}</p>}
          <ul className="overflow-hidden rounded-lg border border-line">
            {deleted.map((d) => (
              <li key={d.revision} className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0" data-testid={`deleted-${d.pack.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg-2">{d.pack.title}</div>
                  <div className={`truncate ${fine} text-fg-3`}>
                    <span className="font-mono">{d.pack.id}</span> · deleted {new Date(d.deletedAt).toLocaleString()}
                  </div>
                </div>
                <Button variant="ghost" className={small} disabled={busy !== null} onClick={() => void restore(d)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
          {next !== null && (
            <Button variant="ghost" className={`${small} self-start`} onClick={() => void more()}>
              More
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** One saved pack: Load, Clone and a trash button up front; Move and
 *  Rename behind a "…" toggle. Delete doesn't ask: the pack goes to
 *  Recently deleted, and the list's "Deleted … Undo" line brings it straight
 *  back. On a phone the buttons sit on their own line under the title, so
 *  the title keeps its width and "…" stays a full-size target. */
function PackRow({
  pack: p,
  content,
  open,
  folders,
  onLoad,
  onClone,
  onMove,
  onRename,
  onDelete,
}: Omit<PackActions, "onCreateFolder" | "onDeleteFolder" | "onDelete"> & {
  pack: Pack;
  content: ContentReply;
  open: boolean;
  folders: string[];
  onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"closed" | "menu" | "rename">("closed");
  const [title, setTitle] = useState(p.title);
  const [busy, setBusy] = useState(false);
  const { stem } = splitPackId(p.id);
  const scenario = p.random_scene
    ? p.random_scene.collections.length
      ? `Random scene (${p.random_scene.collections.map((c) => c || "Other scenes").join(", ")})`
      : "Random scene"
    : p.scenario
    ? (content.scenarios.find((s) => s.id === p.scenario)?.title ?? p.scenario)
    : p.quick_scenario
      ? "Quick scenario"
      : "No scenario";

  /** A move or rename that succeeds re-lists the library under a new id, so
   *  this row is replaced; closing is for the failure that leaves it here. */
  async function run(action: Promise<boolean>) {
    setBusy(true);
    const ok = await action;
    setBusy(false);
    if (ok) setMode("closed");
  }

  return (
    <li className="border-b border-line px-4 py-2 last:border-b-0" data-testid={`pack-${p.id}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-fg">{p.title}</span>
            {open && <Badge tone="accent">open</Badge>}
          </div>
          <div className={`truncate ${fine} text-fg-3`}>
            <span className="font-mono">{stem.slice(0, 10)}</span> · {scenario} · {unitCount(p.units)} units
          </div>
        </div>
        {/* -ml-2 lines the first label up with the title on the stacked phone layout. */}
        <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
          <Button variant="ghost" className={small} onClick={() => onLoad(p)}>
            Load
          </Button>
          <Button variant="ghost" className={small} onClick={() => onClone(p)}>
            Clone
          </Button>
          <Button
            variant="ghost"
            className={`${small} min-w-10 justify-center text-fg-3 hover:text-err`}
            aria-label={`Delete ${p.title}`}
            title="Delete (Undo brings it back)"
            disabled={busy}
            onClick={() => void run(onDelete())}
            data-testid="pack-delete"
          >
            <TrashGlyph />
          </Button>
          <Button
            variant="ghost"
            className={`${small} min-w-10 justify-center`}
            aria-label={`More actions for ${p.title}`}
            aria-expanded={mode !== "closed"}
            onClick={() => setMode(mode === "closed" ? "menu" : "closed")}
          >
            …
          </Button>
        </div>
      </div>
      {mode === "menu" && (
        <div className={`mt-2 flex flex-wrap items-center gap-2 ${fine}`}>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-fg-3">
            Move to
            <FolderSelect label={`Move ${p.title} to`} value={p.folder} folders={folders} disabled={busy} onChange={(f) => void run(onMove(p.id, f))} />
          </label>
          <Button
            variant="ghost"
            className={small}
            disabled={busy}
            onClick={() => {
              setTitle(p.title);
              setMode("rename");
            }}
          >
            Rename…
          </Button>
        </div>
      )}
      {mode === "rename" && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) void run(onRename(p.id, title.trim()));
          }}
        >
          <input
            autoFocus
            aria-label={`New title for ${p.title}`}
            className={`${inputClass} min-w-40 flex-1`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" variant="primary" className={small} disabled={busy || !title.trim()}>
            Rename
          </Button>
          <Button variant="ghost" className={small} onClick={() => setMode("menu")}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}
