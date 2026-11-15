import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, assemblePack, createFolder, deleteFolder, deletePack, getContent, getVoiceSettings, listPacks, movePack, renamePack, savePack, saveProfile, saveVoiceSettings,
} from "./api";
import type { AssembleResult, AuthUser, Committed, ContentReply, LearnerInfo, Mode, Pack, PackInput, PacksReply, Problem, ProfileRequest } from "./types";
import {
  draftToPack, effectiveMinutes, emptyOverrides, minutesWarning, validMinutes, formatSessionLine, joinPackId, learnerKey, loadRememberedDraft, localTimestamp, newDraft, packId, packToDraft,
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
import { IsAdmin } from "./viewer";

/** Debounce for the live preview: long enough to coalesce typing in the
 *  notes box, short enough that a checkbox feels immediate. */
const ASSEMBLE_DELAY_MS = 200;

const TAB_KEY = "lingo-dojo.tab.v1";

function isTab(v: string | null): v is Tab {
  return v === "scene" || v === "customize" || v === "go" || v === "library";
}

/** The last tab this learner was on in this browser — "Scene" the first
 *  time, or if storage is blocked or holds something unrecognized. */
function loadRememberedTab(learnerId: string): Tab {
  try {
    const raw = localStorage.getItem(learnerKey(TAB_KEY, learnerId));
    return isTab(raw) ? raw : "scene";
  } catch {
    return "scene";
  }
}

export default function App({
  user,
  learner,
  learners,
  onSwitchLearner,
  onManageLearners,
  onLogout,
  onLearnerSaved,
}: {
  user: AuthUser;
  /** Who's practising: the session's active learner. */
  learner: LearnerInfo;
  learners: LearnerInfo[];
  onSwitchLearner: (id: string) => void;
  onManageLearners: () => void;
  onLogout: () => void;
  /** The learner row changed (Save as my defaults): refresh what the gate holds. */
  onLearnerSaved: () => Promise<void> | void;
}) {
  // Which library is open: the active learner's. Content and packs are this
  // mode's; the remembered draft, tab and Scene filters are this learner's
  // (draft.ts learnerKey). Switching learner remounts App (AuthGate keys it
  // by learner), which reloads the lot and swaps in that learner's own
  // remembered draft, so two learners — or two accounts on one browser —
  // never see each other's unsaved picks.
  const mode: Mode = learner.mode;
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
  const [tab, setTabState] = useState<Tab>(() => loadRememberedTab(learner.id));

  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      try {
        localStorage.setItem(learnerKey(TAB_KEY, learner.id), t);
      } catch {
        /* private window or blocked storage: the next visit just starts on Scene */
      }
    },
    [learner.id],
  );

  // The mode on <html>, for the stylesheet's kids accent.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  /** Put a loaded library into state. `fresh` is true on the first load:
   *  the draft is then this learner's remembered one (so a refresh keeps
   *  today's picks), else the library's defaults. A reload keeps the draft
   *  (a unit that vanished shows up as a warning). */
  const applyLoad = useCallback((learnerId: string, c: ContentReply, p: PacksReply, fresh: boolean) => {
    setContent(c);
    setPacks(p.packs);
    setFolders(p.folders);
    setLoadError(null);
    setContentVersion((v) => v + 1);
    setDraft((d) => (fresh || !d ? (loadRememberedDraft(learnerId) ?? newDraft(c)) : d));
  }, []);

  // Load the library. The effect's own `live` flag drops a reply that lands
  // after the component is gone (a learner switch).
  useEffect(() => {
    let live = true;
    Promise.all([getContent(mode), listPacks(mode)]).then(
      ([c, p]) => live && applyLoad(learner.id, c, p, true),
      (e) => live && setLoadError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [mode, learner.id, applyLoad]);

  async function reloadContent() {
    setReloading(true);
    try {
      const [c, p] = await Promise.all([getContent(mode), listPacks(mode)]);
      applyLoad(learner.id, c, p, false);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setReloading(false);
    }
  }

  // The Go tab's "How long do you have?": the draft's own choice, else the
  // last one, which lives in this user's voice settings (the database) per mode.
  // Until (or unless) they load, the picker offers no lengths and the pack
  // goes without one, which is No limit: today's behavior.
  const [lastMinutes, setLastMinutes] = useState<Record<Mode, number | null> | null>(null);
  const [minuteChoices, setMinuteChoices] = useState<Record<Mode, number[]> | null>(null);
  useEffect(() => {
    let live = true;
    getVoiceSettings().then(
      (r) => {
        if (!live) return;
        setLastMinutes(r.settings.sessionMinutes);
        setMinuteChoices(r.minuteChoices);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const minutes = draft ? effectiveMinutes(draft, lastMinutes?.[mode] ?? null) : null;

  /** A picked length goes into the draft (and so the pack) and becomes the
   *  remembered one for the next pack that has none. */
  function chooseMinutes(m: number | null) {
    setDraft((d) => (d ? { ...d, minutes: m } : d));
    setLastMinutes((s) => ({ adult: null, kids: null, ...s, [mode]: m }));
    saveVoiceSettings({ sessionMinutes: { [mode]: m } }).catch(() => {
      /* only the default for next time is lost; this session has its length */
    });
  }

  const pack = useMemo(() => (draft ? draftToPack(draft, minutes) : null), [draft, minutes]);
  // A bad `minutes` in the pack is hidden from the assembler while the
  // remembered length stands in, so its warning is added here.
  const extraWarning = draft ? minutesWarning(draft, minutes) : null;
  const shownResult = useMemo(
    () => (result && extraWarning && !result.warnings.includes(extraWarning) ? { ...result, warnings: [extraWarning, ...result.warnings] } : result),
    [result, extraWarning],
  );
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
      // The pack's own minutes only (draftToPack's default): a remembered
      // length the picker merely inherited is never written into a pack.
      const r = await savePack(mode, id, { ...draftToPack(draft), title, created });
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

  /** "Save as my defaults": write the shown values to the active learner's
   *  row, reload so content.profile is the new row, then clear the overrides
   *  — they are the defaults now, so neither the draft nor a pack saved from
   *  it should repeat them. Resolves to an error sentence, or null. */
  async function saveDefaults(values: ProfileRequest): Promise<string | null> {
    try {
      await saveProfile(mode, values);
    } catch (e) {
      return e instanceof ApiError ? e.message : String(e);
    }
    await reloadContent();
    setDraft((d) => (d ? { ...d, overrides: emptyOverrides() } : d));
    // The learner switcher shows the name: let the gate re-read it.
    await onLearnerSaved();
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

  // Remember every change under this learner's key; "New pack" below is the
  // way back to the defaults. The draft is null until the first load, and a
  // null is not written (it would erase the remembered one).
  useEffect(() => {
    if (draft && content?.mode === mode) rememberDraft(learner.id, draft);
  }, [mode, learner.id, content, draft]);

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
    <IsAdmin.Provider value={user.isAdmin}>
    <div className="flex min-h-screen flex-col">
      <TopBar
        tab={tab}
        onTab={setTab}
        onNewPack={startNew}
        onReload={() => void reloadContent()}
        reloading={reloading}
        ready={!!ready}
        mode={mode}
        user={user}
        learner={learner}
        learners={learners}
        onSwitchLearner={onSwitchLearner}
        onManageLearners={onManageLearners}
        onLogout={onLogout}
        content={ready}
        draft={draft}
        onChange={setDraft}
        onSaveDefaults={saveDefaults}
      />
      {ready && draft && pack && (
        <SummaryBar content={ready} draft={draft} pack={pack} sceneTitle={scenarioTitle} result={shownResult} pending={assembling} onTab={setTab}
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
          <div className={`mx-auto flex w-full flex-col ${tab === "scene" ? "max-w-[1200px]" : tab === "go" ? "max-w-[1440px]" : "max-w-3xl"}`}>
            {tab === "scene" && (
              <SceneTab key={mode} learnerId={learner.id} content={ready} draft={draft} onChange={setDraft} onNext={() => setTab("customize")} />
            )}
            {tab === "customize" && <CustomizeTab key={mode} content={ready} draft={draft} onChange={setDraft} onNext={() => setTab("go")} />}
            {/* Go stays mounted while another tab is open, so a practice
                session survives a look at Scene or a word with the content
                agent; leaving Go stops its audio and mic (`active`). */}
            <div hidden={tab !== "go"}>
              <GoTab
                key={mode}
                active={tab === "go"}
                content={ready}
                pack={pack}
                title={draft.title}
                sourceId={draft.sourceId}
                sceneTitle={scenarioTitle}
                learnerLine={learnerLine}
                notes={draft.notes}
                minutes={validMinutes(minutes)}
                minuteChoices={minuteChoices?.[mode] ?? []}
                onMinutes={chooseMinutes}
                onNotes={(notes) => setDraft({ ...draft, notes })}
                exportId={draft.sourceId ? splitPackId(draft.sourceId).stem : packId(draft.title || scenarioTitle || "session")}
                result={shownResult}
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
            </div>
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

      {/* The content agent writes units and packs; on the Go tab it would only
          sit over the practice session, so it shows on the building tabs. */}
      {/* Hidden, not unmounted: a turn in progress keeps streaming. Admins
          only: it edits the library everyone shares (the server says 403 to
          anyone else, so this is the courtesy, not the guard). */}
      {user.isAdmin && (
        <div hidden={tab === "go"}>
          <AgentDrawer mode={mode} onContentChanged={reloadContent} />
        </div>
      )}
    </div>
    </IsAdmin.Provider>
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
