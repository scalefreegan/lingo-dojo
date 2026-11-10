import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, assemblePack, createFolder, deleteFolder, deletePack, getContent, listPacks, movePack, renamePack, savePack, saveProfile,
} from "./api";
import type { AssembleResult, Committed, ContentReply, Mode, Pack, PackInput, PacksReply, Problem, ProfileRequest } from "./types";
import {
  draftToPack, emptyOverrides, formatSessionLine, joinPackId, loadRememberedDraft, localTimestamp, modeKey, newDraft, packId, packToDraft,
  rememberDraft, sessionValues, splitPackId, type Draft,
} from "./draft";
import TopBar from "./components/TopBar";
import SummaryBar from "./components/SummaryBar";
import SceneTab from "./components/SceneTab";
import CustomizeTab from "./components/CustomizeTab";
import GoTab from "./components/GoTab";
import LibraryTab from "./components/LibraryTab";
import AgentDrawer from "./components/AgentDrawer";
import type { PackStatus, SaveOutcome, Tab } from "./components/shared";

/** Debounce for the live preview: long enough to coalesce typing in the
 *  notes box, short enough that a checkbox feels immediate. */
const ASSEMBLE_DELAY_MS = 200;

const MODE_KEY = "lingo-dojo.mode.v1";
const TAB_KEY = "lingo-dojo.tab.v1";

function isTab(v: string | null): v is Tab {
  return v === "scene" || v === "customize" || v === "go" || v === "library";
}

function isMode(v: string | null): v is Mode {
  return v === "adult" || v === "kids";
}

/** The library this browser was last in — adult the first time, or if
 *  storage is blocked or holds something unrecognized. */
function loadRememberedMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return isMode(raw) ? raw : "adult";
  } catch {
    return "adult";
  }
}

/** The last tab this browser was on in a mode — "Scene" the first time, or
 *  if storage is blocked or holds something unrecognized. */
function loadRememberedTab(mode: Mode): Tab {
  try {
    const raw = localStorage.getItem(modeKey(TAB_KEY, mode));
    return isTab(raw) ? raw : "scene";
  } catch {
    return "scene";
  }
}

export default function App() {
  // Which library is open. Everything below — content, packs, draft, tab —
  // belongs to this mode; switching it reloads the lot and swaps in that
  // mode's own remembered draft, so the two never bleed into each other.
  const [mode, setModeState] = useState<Mode>(loadRememberedMode);
  const [content, setContent] = useState<ContentReply | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  // The one-line outcome of the last pack action (save, move, rename, delete,
  // folder), with the commit that recorded it.
  const [packStatus, setPackStatus] = useState<PackStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  // Bumped by every content reload so the preview re-assembles against the
  // new library even when the draft itself didn't change.
  const [contentVersion, setContentVersion] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [result, setResult] = useState<AssembleResult | null>(null);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  // Which (pack, contentVersion) the shown result answers. "Updating" is
  // derived from it rather than flagged from inside the effect, so the effect
  // only ever sets state from its async callbacks.
  const [settled, setSettled] = useState<{ pack: PackInput; version: number } | null>(null);
  const [saveRequest, setSaveRequest] = useState<{ title: string; folder: string; seq: number } | null>(null);
  // The sticky bar's Practice: go to the Go tab with the voice session open.
  // Cleared once the panel has opened, so a later visit to Go doesn't reopen it.
  const [practiceRequest, setPracticeRequest] = useState(false);
  const [tab, setTabState] = useState<Tab>(() => loadRememberedTab(mode));

  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      try {
        localStorage.setItem(modeKey(TAB_KEY, mode), t);
      } catch {
        /* private window or blocked storage: the next visit just starts on Scene */
      }
    },
    [mode],
  );

  // The mode on <html>, for the stylesheet's kids accent.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  /** Put a loaded library into state. `fresh` is true when the library is a
   *  different mode's than the draft: the draft is then replaced by that
   *  mode's remembered one (so a refresh or a switch back keeps today's
   *  picks), else by the library's defaults. A reload within the same mode
   *  keeps the draft (a unit that vanished shows up as a warning). */
  const applyLoad = useCallback((m: Mode, c: ContentReply, p: PacksReply, fresh: boolean) => {
    setContent(c);
    setPacks(p.packs);
    setFolders(p.folders);
    setLoadError(null);
    setContentVersion((v) => v + 1);
    setDraft((d) => (fresh || !d ? (loadRememberedDraft(m) ?? newDraft(c)) : d));
  }, []);

  // Load (and, on a mode switch, reload) the library. The effect's own
  // `live` flag drops a reply that lands after the mode changed again.
  useEffect(() => {
    let live = true;
    Promise.all([getContent(mode), listPacks(mode)]).then(
      ([c, p]) => live && applyLoad(mode, c, p, true),
      (e) => live && setLoadError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [mode, applyLoad]);

  function switchMode(m: Mode) {
    if (m === mode) return;
    // The outgoing draft is already remembered under its own key (the effect
    // below runs on every change); nothing to flush. Drop the stale preview
    // and status so nothing from the old library lingers while the new one
    // loads, and start on that mode's last tab.
    setDraft(null);
    setResult(null);
    setSettled(null);
    setAssembleError(null);
    setPackStatus(null);
    setSaveRequest(null);
    setTabState(loadRememberedTab(m));
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* blocked storage: the next visit just opens in adult mode */
    }
  }

  async function reloadContent() {
    setReloading(true);
    try {
      const [c, p] = await Promise.all([getContent(mode), listPacks(mode)]);
      applyLoad(mode, c, p, false);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setReloading(false);
    }
  }

  const pack = useMemo(() => (draft ? draftToPack(draft) : null), [draft]);
  const assembling = !!pack && (settled?.pack !== pack || settled.version !== contentVersion);

  // Live preview. Each change aborts the request before it, so a slow reply
  // to an old draft can never land on top of the newest one.
  useEffect(() => {
    if (!pack) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      assemblePack(mode, pack, ctrl.signal).then(
        (r) => {
          setResult(r);
          setAssembleError(null);
          setSettled({ pack, version: contentVersion });
        },
        (e) => {
          if (ctrl.signal.aborted) return;
          setAssembleError((e as Error).message);
          setSettled({ pack, version: contentVersion });
        },
      );
    }, ASSEMBLE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [mode, pack, contentVersion]);

  const scenarioTitle = useMemo(() => {
    if (!content || !pack) return "";
    if (pack.quick_scenario.trim()) return "Quick scenario";
    return content.scenarios.find((s) => s.id === pack.scenario)?.title ?? "";
  }, [content, pack]);

  // The voice panel's languages, memoized so its settings fetch reruns only
  // when the target or native language actually changes.
  const voiceTarget = content && draft ? sessionValues(draft, content.profile) : null;
  const vt = voiceTarget?.target_language ?? "";
  const vv = voiceTarget?.target_variant ?? "";
  const vn = voiceTarget?.native_language ?? "";
  const voiceLangs = useMemo(() => ({ target: vt, variant: vv, native: vn }), [vt, vv, vn]);

  const learnerLine = useMemo(() => {
    if (!content || !draft) return "";
    const s = sessionValues(draft, content.profile);
    return [s.learner_name, formatSessionLine(s)].filter(Boolean).join(" · ");
  }, [content, draft]);

  /** Re-list after any pack write, so the library shows what is on disk. */
  async function refreshPacks() {
    const p = await listPacks(mode);
    setPacks(p.packs);
    setFolders(p.folders);
  }

  /** The status line after a pack write: what happened and the commit that
   *  recorded it — or that git did not, which deserves a look at the terminal. */
  function report(what: string, c: Committed): PackStatus {
    if (c.error) return { tone: "err", text: `${what} — ${c.error}` };
    return { tone: "ok", text: c.commit ? `${what} (committed ${c.commit.hash})` : `${what} (nothing to commit)` };
  }

  /** Run a pack action, then re-list and show the outcome either way.
   *  Resolves to whether it succeeded, so an inline form knows to close. */
  async function act(run: () => Promise<PackStatus>): Promise<boolean> {
    try {
      const status = await run();
      await refreshPacks();
      setPackStatus(status);
      return true;
    } catch (e) {
      setPackStatus({ tone: "err", text: e instanceof ApiError ? e.message : String(e) });
      return false;
    }
  }

  async function save(title: string, folder: string, overwrite: boolean): Promise<SaveOutcome> {
    if (!draft || !pack) return { ok: false, error: "nothing to save" };
    // Same title and folder as the pack it was loaded from → update that file
    // in place; a new title or folder is a new file named for today.
    const src = draft.sourceId;
    const id = src != null && title === draft.title && folder === splitPackId(src).folder ? src : joinPackId(folder, packId(title));
    if (!overwrite && id !== src && packs.some((p) => p.id === id)) return { ok: false, conflict: id };
    const created = id === src && draft.created ? draft.created : localTimestamp();
    try {
      const r = await savePack(mode, id, { ...pack, title, created });
      setDraft((d) => (d ? { ...d, title: r.pack.title, sourceId: r.pack.id, created: r.pack.created } : d));
      await refreshPacks();
      setPackStatus(report(`Saved ${r.pack.id}`, r));
      return { ok: true, id: r.pack.id };
    } catch (e) {
      return { ok: false, error: e instanceof ApiError ? e.message : String(e) };
    }
  }

  function move(id: string, folder: string) {
    return act(async () => {
      const r = await movePack(mode, id, folder);
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: r.pack.id } : d));
      return report(`Moved ${id} to ${folder || "no folder"}`, r);
    });
  }

  function rename(id: string, title: string) {
    return act(async () => {
      const r = await renamePack(mode, id, title);
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: r.pack.id, title: r.pack.title } : d));
      return report(`Renamed ${id} to ${r.pack.id}`, r);
    });
  }

  function remove(id: string) {
    return act(async () => {
      const r = await deletePack(mode, id);
      // The draft keeps its content but is no longer "the saved pack": a
      // later save writes a new file rather than quietly resurrecting this one.
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: null } : d));
      return report(`Deleted ${id}`, r);
    });
  }

  function addFolder(name: string) {
    return act(async () => report(`Created folder ${name}`, await createFolder(mode, name)));
  }

  function removeFolder(name: string) {
    return act(async () => report(`Deleted folder ${name}`, await deleteFolder(mode, name)));
  }

  /** "Save as my defaults": write the shown values to this mode's
   *  profile.yaml, reload so content.profile is the new file, then clear the
   *  overrides — they are the defaults now, so neither the draft nor a pack
   *  saved from it should repeat them. Resolves to an error sentence, or null. */
  async function saveDefaults(values: ProfileRequest): Promise<string | null> {
    try {
      await saveProfile(mode, values);
    } catch (e) {
      return e instanceof ApiError ? e.message : String(e);
    }
    await reloadContent();
    setDraft((d) => (d ? { ...d, overrides: emptyOverrides() } : d));
    return null;
  }

  /** Load jumps to Scene: that's where the loaded pack's scenario shows up. */
  function load(p: Pack) {
    setDraft(packToDraft(p));
    setSaveRequest(null);
    setTab("scene");
  }

  /** Clone = load under a new title, with the save form open so the copy
   *  gets its own name (in the same folder, until the form says otherwise) —
   *  jumps to Go, where that save form now lives. */
  function clone(p: Pack) {
    const title = `${p.title} (copy)`;
    setDraft({ ...packToDraft(p), title, sourceId: null, created: "" });
    setSaveRequest((r) => ({ title, folder: p.folder, seq: (r?.seq ?? 0) + 1 }));
    setTab("go");
  }

  // Remember every change under this mode's key; "New pack" below is the
  // way back to the defaults. The draft is null between a mode switch and
  // its load, and a null is not written (it would erase the remembered one).
  useEffect(() => {
    if (draft && content?.mode === mode) rememberDraft(mode, draft);
  }, [mode, content, draft]);

  function startNew() {
    if (!content) return;
    setDraft(newDraft(content));
    setSaveRequest(null);
    setTab("scene");
  }

  // The loaded library must be this mode's before anything is drawn from it:
  // between a switch and its reply, `content` is still the old mode's.
  const ready = content?.mode === mode ? content : null;

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        tab={tab}
        onTab={setTab}
        onNewPack={startNew}
        onReload={() => void reloadContent()}
        reloading={reloading}
        ready={!!ready}
        mode={mode}
        onMode={switchMode}
        content={ready}
        draft={draft}
        onChange={setDraft}
        onSaveDefaults={saveDefaults}
      />
      {ready && draft && pack && (
        <SummaryBar content={ready} draft={draft} pack={pack} sceneTitle={scenarioTitle} result={result} pending={assembling} onTab={setTab}
          onPractice={() => {
            setPracticeRequest(true);
            setTab("go");
          }}
        />
      )}

      {loadError && <p className="bg-err-soft px-4 py-2 text-sm text-err">Could not load content: {loadError}</p>}
      {ready && ready.problems.length > 0 && <ProblemsStrip problems={ready.problems} />}

      {ready && draft && pack ? (
        <main className="flex-1 p-4">
          <div className={`mx-auto flex w-full flex-col ${tab === "scene" ? "max-w-[1200px]" : tab === "go" ? "max-w-[1600px]" : "max-w-3xl"}`}>
            {tab === "scene" && (
              <SceneTab key={mode} content={ready} draft={draft} onChange={setDraft} onNext={() => setTab("customize")} />
            )}
            {tab === "customize" && <CustomizeTab key={mode} content={ready} draft={draft} onChange={setDraft} onNext={() => setTab("go")} />}
            {tab === "go" && (
              <GoTab
                key={mode}
                content={ready}
                pack={pack}
                title={draft.title}
                sourceId={draft.sourceId}
                sceneTitle={scenarioTitle}
                learnerLine={learnerLine}
                notes={draft.notes}
                onNotes={(notes) => setDraft({ ...draft, notes })}
                exportId={draft.sourceId ? splitPackId(draft.sourceId).stem : packId(draft.title || scenarioTitle || "session")}
                result={result}
                pending={assembling}
                error={assembleError}
                folders={folders}
                packStatus={packStatus}
                saveRequest={saveRequest}
                onSave={save}
                langs={voiceLangs}
                practiceRequest={practiceRequest}
                onPracticeOpened={() => setPracticeRequest(false)}
              />
            )}
            {tab === "library" && (
              <LibraryTab
                key={mode}
                packs={packs}
                folders={folders}
                content={ready}
                currentId={draft.sourceId}
                onLoad={load}
                onClone={clone}
                onMove={move}
                onRename={rename}
                onDelete={remove}
                onCreateFolder={addFolder}
                onDeleteFolder={removeFolder}
              />
            )}
          </div>
        </main>
      ) : (
        !loadError && <p className="p-6 text-sm text-fg-3">Loading content…</p>
      )}

      <AgentDrawer mode={mode} onContentChanged={reloadContent} />
    </div>
  );
}

/** Loader problems, collapsed to a count until opened: a broken file the
 *  agent just wrote should be impossible to miss and easy to ignore. */
function ProblemsStrip({ problems }: { problems: Problem[] }) {
  const errors = problems.filter((p) => p.level === "error").length;
  const warnings = problems.length - errors;
  const tone = errors ? "bg-err-soft text-err" : "bg-warn-soft text-warn";
  const parts = [errors && `${errors} error${errors === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean);
  return (
    <details className={`px-4 py-2 text-sm ${tone}`} data-testid="problems">
      <summary className="cursor-pointer select-none">Content problems: {parts.join(", ")}</summary>
      <ul className="mt-2 flex flex-col gap-1 pb-1">
        {problems.map((p) => (
          <li key={`${p.file}:${p.message}`}>
            <span className="font-medium">{p.level}</span> <code className="font-mono text-sm break-all sm:text-xs">{p.file}</code>: {p.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
