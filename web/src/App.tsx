import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, assemblePack, createFolder, deleteFolder, deletePack, getContent, getConversation, getVoiceSettings, hideScene, listHiddenScenes, listPacks, movePack, renamePack, savePack, saveProfile, saveVoiceSettings,
  unhideScene, updateLanguage,
} from "./api";
import type { AssembleResult, AuthUser, ContentReply, ConversationSummary, HiddenScene, LanguageInfo, LearnerInfo, Mode, Pack, PackInput, PacksReply, Problem, ProfileRequest } from "./types";
import {
  draftPool, draftPoolMessage, draftToPack, effectiveMinutes, emptyOverrides, minutesWarning, validMinutes, formatSessionLine, joinPackId, languageKey, loadRememberedDraft, localTimestamp, newDraft, packId, packToDraft, withBackfill,
  rememberDraft, sessionValues, splitPackId, type Draft,
} from "./draft";
import { hiddenSetOf, type HiddenKind } from "../shared/scenes.ts";
import TopBar from "./components/TopBar";
import SummaryBar from "./components/SummaryBar";
import SceneTab from "./components/SceneTab";
import CustomizeTab from "./components/CustomizeTab";
import GoTab from "./components/GoTab";
import LibraryTab from "./components/LibraryTab";
import { onOpenBank } from "./bankLink";
import PracticeView from "./components/PracticeView";
import AgentDrawer from "./components/AgentDrawer";
import ScriptProvider from "./components/ScriptProvider";
import type { PackStatus, SaveOutcome, Tab } from "./components/shared";
import { IsAdmin } from "./viewer";

/** Debounce for the live preview: long enough to coalesce typing in the
 *  notes box, short enough that a checkbox feels immediate. */
const ASSEMBLE_DELAY_MS = 200;

const TAB_KEY = "lingo-dojo.tab.v1";

function isTab(v: string | null): v is Tab {
  return v === "scene" || v === "customize" || v === "go" || v === "library" || v === "practice";
}

/** The last tab this language profile was on in this browser — "Scene" the
 *  first time, or if storage is blocked or holds something unrecognized.
 *  Practice isn't a kids tab (docs/DATA.md §Kids learners). */
function loadRememberedTab(languageId: string, mode: Mode): Tab {
  try {
    const raw = localStorage.getItem(languageKey(TAB_KEY, languageId));
    return isTab(raw) && !(raw === "practice" && mode === "kids") ? raw : "scene";
  } catch {
    return "scene";
  }
}

export default function App({
  user,
  learner,
  language,
  learners,
  onSwitchLearner,
  onSwitchLanguage,
  switchError,
  onDismissSwitchError,
  onManageLearners,
  onLogout,
  onLearnerSaved,
}: {
  user: AuthUser;
  /** Who's practising: the session's active learner. */
  learner: LearnerInfo;
  /** In which language: the session's active language profile, one of learner.languages. */
  language: LanguageInfo;
  learners: LearnerInfo[];
  onSwitchLearner: (id: string) => void;
  onSwitchLanguage: (id: string) => void;
  /** Why the last learner or language switch failed, shown under the bar. */
  switchError: string | null;
  onDismissSwitchError: () => void;
  onManageLearners: () => void;
  onLogout: () => void;
  /** The learner or its languages changed (Save as my defaults, a language
   *  archived): refresh what the gate holds. */
  onLearnerSaved: () => Promise<void> | void;
}) {
  // Which library is open: the active learner's. Content is this mode's;
  // packs, the remembered draft, tab and Scene filters are this language
  // profile's (draft.ts languageKey). Switching learner or language remounts
  // App (AuthGate keys it by both), which reloads the lot and swaps in that
  // profile's own remembered draft, so two languages, two learners — or two
  // accounts on one browser — never see each other's unsaved picks.
  const mode: Mode = learner.mode;
  const [content, setContent] = useState<ContentReply | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  // The one-line outcome of the last pack action (save, move, rename, delete,
  // restore, folder).
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
  const [tab, setTabState] = useState<Tab>(() => loadRememberedTab(language.id, learner.mode));

  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      try {
        localStorage.setItem(languageKey(TAB_KEY, language.id), t);
      } catch {
        /* private window or blocked storage: the next visit just starts on Scene */
      }
    },
    [language.id],
  );

  // "In the bank" from a session recap on the Go tab (bankLink.ts): the
  // Library tab, whose Phrase bank view takes the search.
  useEffect(() => onOpenBank(() => setTab("library")), [setTab]);

  // The mode on <html>, for the stylesheet's kids accent.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  /** Put a loaded library into state. `fresh` is true on the first load:
   *  the draft is then this language's remembered one (so a refresh keeps
   *  today's picks), else the library's defaults. A reload keeps the draft
   *  (a unit that vanished shows up as a warning). */
  const applyLoad = useCallback((languageId: string, c: ContentReply, p: PacksReply, fresh: boolean) => {
    setContent(c);
    setPacks(p.packs);
    setFolders(p.folders);
    setLoadError(null);
    setContentVersion((v) => v + 1);
    // A remembered draft may predate a slot added since (recall): it plays
    // that slot's default, as a saved pack does (withBackfill).
    setDraft((d) => (fresh || !d ? withBackfill(c, loadRememberedDraft(languageId) ?? newDraft(c)) : d));
  }, []);

  // Load the library. The effect's own `live` flag drops a reply that lands
  // after the component is gone (a learner or language switch).
  useEffect(() => {
    let live = true;
    Promise.all([getContent(mode), listPacks(mode)]).then(
      ([c, p]) => live && applyLoad(language.id, c, p, true),
      (e) => live && setLoadError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [mode, language.id, applyLoad]);

  async function reloadContent() {
    setReloading(true);
    try {
      const [c, p] = await Promise.all([getContent(mode), listPacks(mode)]);
      applyLoad(language.id, c, p, false);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setReloading(false);
    }
  }

  // The library scenes and collections this language has hidden (docs/DATA.md
  // §Hidden scenes): the Scene tab leaves them out, and the random pool
  // here (the summary bar, Start) by the server's own rule. Until they
  // load, nothing is hidden; a failed read leaves it so, since the server
  // still applies the hides when it draws.
  const [hiddenRows, setHiddenRows] = useState<HiddenScene[]>([]);
  useEffect(() => {
    let live = true;
    listHiddenScenes().then(
      (r) => live && setHiddenRows(r.hidden),
      (e) => console.warn("[lingo-dojo] hidden scenes:", (e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [language.id]);
  const hiddenScenes = useMemo(() => hiddenSetOf(hiddenRows), [hiddenRows]);

  /** Hide or restore one scene or collection: shown at once, put back if
   *  the server refuses. Resolves to an error sentence, or null. */
  async function setSceneHidden(kind: HiddenKind, key: string, hide: boolean): Promise<string | null> {
    const same = (r: HiddenScene) => r.kind === kind && r.key === key;
    const was = hiddenRows.find(same);
    setHiddenRows((rows) => (hide ? [...rows.filter((r) => !same(r)), { kind, key, hiddenAt: new Date().toISOString() }] : rows.filter((r) => !same(r))));
    try {
      if (hide) {
        const r = await hideScene(kind, key);
        setHiddenRows((rows) => rows.map((x) => (same(x) ? r.hidden : x)));
      } else {
        await unhideScene(kind, key);
      }
      return null;
    } catch (e) {
      setHiddenRows((rows) => (hide ? rows.filter((r) => !same(r)) : was && !rows.some(same) ? [...rows, was] : rows));
      return e instanceof ApiError ? e.message : String(e);
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
    if (pack.random_scene) return "Random scene";
    if (pack.quick_scenario.trim()) return "Quick scenario";
    return content.scenarios.find((s) => s.id === pack.scenario)?.title ?? "";
  }, [content, pack]);
  // A random scene's pool as the Scene tab counts it (null when the draft
  // isn't random): the summary bar shows its size, and an empty one blocks
  // Start with the card's message.
  const randomPool = useMemo(() => (content && draft && draft.scenarioMode === "random" ? draftPool(content, draft, hiddenScenes) : null), [content, draft, hiddenScenes]);
  const randomBlock = content && draft && randomPool && randomPool.length === 0 ? draftPoolMessage(content, draft, hiddenScenes) : null;

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

  /** Re-list after any pack write, so the library shows what is stored. */
  async function refreshPacks() {
    const p = await listPacks(mode);
    setPacks(p.packs);
    setFolders(p.folders);
  }

  /** The status line after a pack write. Every write is a revision in the
   *  database (a delete can be undone from the Library's Recently deleted). */
  function report(what: string): PackStatus {
    return { tone: "ok", text: what };
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
      setPackStatus(report(`Saved ${r.pack.id}`));
      return { ok: true, id: r.pack.id };
    } catch (e) {
      return { ok: false, error: e instanceof ApiError ? e.message : String(e) };
    }
  }

  function move(id: string, folder: string) {
    return act(async () => {
      const r = await movePack(mode, id, folder);
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: r.pack.id } : d));
      return report(`Moved ${id} to ${folder || "no folder"}`);
    });
  }

  function rename(id: string, title: string) {
    return act(async () => {
      const r = await renamePack(mode, id, title);
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: r.pack.id, title: r.pack.title } : d));
      return report(`Renamed ${id} to ${r.pack.id}`);
    });
  }

  function remove(id: string) {
    return act(async () => {
      await deletePack(mode, id);
      // The draft keeps its content but is no longer "the saved pack": a
      // later save makes a new pack rather than quietly resurrecting this one.
      setDraft((d) => (d && d.sourceId === id ? { ...d, sourceId: null } : d));
      return report(`Deleted ${id} (Library → Recently deleted can restore it)`);
    });
  }

  function addFolder(name: string) {
    return act(async () => {
      await createFolder(mode, name);
      return report(`Created folder ${name}`);
    });
  }

  function removeFolder(name: string) {
    return act(async () => {
      await deleteFolder(mode, name);
      return report(`Deleted folder ${name}`);
    });
  }

  /** A deleted pack came back (the Library's Recently deleted): re-list. */
  async function restored(p: Pack) {
    await refreshPacks();
    setPackStatus(report(`Restored ${p.id}`));
  }

  /** "Save as my defaults": write the shown values to the active learner's
   *  row and its active language's, reload so content.profile is the new row, then clear the overrides
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
    // The learner and language switchers show the name and level: let the gate re-read them.
    await onLearnerSaved();
    return null;
  }

  /** The language menu's level: straight to the active language's profile
   *  (like its goals and notes), then the library reloads so content.profile
   *  has it, the draft drops a level override that would hide it, and the
   *  gate re-reads the language for the pills. Resolves to an error
   *  sentence, or null. */
  async function saveLanguageLevel(level: string): Promise<string | null> {
    try {
      await updateLanguage(learner.id, language.id, { level });
    } catch (e) {
      return e instanceof ApiError ? e.message : String(e);
    }
    await reloadContent();
    setDraft((d) => (d && d.overrides.level ? { ...d, overrides: { ...d.overrides, level: "" } } : d));
    await onLearnerSaved();
    return null;
  }

  /** The active language's goals and notes, straight to its profile; then
   *  the library reloads (the Learner block reads them) and the gate
   *  re-reads the language. Resolves to an error sentence, or null. */
  async function saveLanguageNotes(values: { goals: string; notes: string }): Promise<string | null> {
    try {
      await updateLanguage(learner.id, language.id, values);
    } catch (e) {
      return e instanceof ApiError ? e.message : String(e);
    }
    await reloadContent();
    await onLearnerSaved();
    return null;
  }

  // Practice again (docs/DATA.md §Revisit): the History session the draft
  // was loaded from, sent with the next conversation so it builds on that
  // attempt; cleared once one has, or when another pack is loaded.
  // `scene`: the draft's scene when it was loaded; picking another scene
  // leaves the request unsent (revisitShown), and the server would ignore
  // it anyway (another scene's session isn't built on).
  const [revisit, setRevisit] = useState<{ id: string; startedAt: string; scene: string } | null>(null);
  const revisitUsed = useCallback(() => setRevisit(null), []);

  /** Practice again: the pack exactly as that session played it (a random
   *  scene: the scene it drew) into the Go tab, unsaved, ready to Start or
   *  tweak. Its own saved pack, if any, is left alone. */
  async function practiceAgain(c: ConversationSummary): Promise<void> {
    const { pack: played } = await getConversation(c.id, 0, undefined, 1);
    const d = packToDraft({ ...played, id: "", folder: "", random_scene: played.random_scene ?? null });
    const draft: Draft = { ...d, title: played.title || c.title, sourceId: null, created: "" };
    setDraft(content ? withBackfill(content, draft) : draft);
    setSaveRequest(null);
    setRevisit({ id: c.id, startedAt: c.startedAt, scene: draftScene(draft) });
    setTab("go");
  }

  /** Load jumps to Scene: that's where the loaded pack's scenario shows up. */
  function load(p: Pack) {
    setRevisit(null);
    // A pack saved before a slot was added (recall) plays its default: shown
    // ticked in Customize, saved only if the learner saves.
    setDraft(content ? withBackfill(content, packToDraft(p)) : packToDraft(p));
    setSaveRequest(null);
    setTab("scene");
  }

  /** Clone = load under a new title, with the save form open so the copy
   *  gets its own name (in the same folder, until the form says otherwise) —
   *  jumps to Go, where that save form now lives. */
  function clone(p: Pack) {
    setRevisit(null);
    const title = `${p.title} (copy)`;
    const d = packToDraft(p);
    setDraft({ ...(content ? withBackfill(content, d) : d), title, sourceId: null, created: "" });
    setSaveRequest((r) => ({ title, folder: p.folder, seq: (r?.seq ?? 0) + 1 }));
    setTab("go");
  }

  // Remember every change under this language's key; "New pack" below is the
  // way back to the defaults. The draft is null until the first load, and a
  // null is not written (it would erase the remembered one).
  useEffect(() => {
    if (draft && content?.mode === mode) rememberDraft(language.id, draft);
  }, [mode, language.id, content, draft]);

  function startNew() {
    if (!content) return;
    setRevisit(null);
    setDraft(newDraft(content));
    setSaveRequest(null);
    setTab("scene");
  }

  // The loaded library must be this mode's before anything is drawn from it:
  // between a switch and its reply, `content` is still the old mode's.
  const ready = content?.mode === mode ? content : null;

  return (
    <IsAdmin.Provider value={user.isAdmin}>
    <ScriptProvider languageId={language.id} kids={mode === "kids"}>
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
        language={language}
        learners={learners}
        onSwitchLearner={onSwitchLearner}
        onSwitchLanguage={onSwitchLanguage}
        onLanguagesChanged={onLearnerSaved}
        onManageLearners={onManageLearners}
        onLogout={onLogout}
        content={ready}
        draft={draft}
        onChange={setDraft}
        onSaveDefaults={saveDefaults}
        onSaveLanguageNotes={saveLanguageNotes}
        onSaveLevel={saveLanguageLevel}
      />
      {switchError && (
        <p className="flex items-start justify-between gap-3 bg-err-soft px-4 py-2 text-sm text-err" role="alert" data-testid="switch-error">
          <span>Couldn't switch: {switchError}</span>
          <button type="button" className="shrink-0 underline" onClick={onDismissSwitchError}>
            Dismiss
          </button>
        </p>
      )}
      {ready && draft && pack && (
        <SummaryBar content={ready} draft={draft} pack={pack} sceneTitle={scenarioTitle} poolSize={randomPool?.length ?? null} blocked={randomBlock} result={shownResult} pending={assembling} onTab={setTab}
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
              <SceneTab key={mode} languageId={language.id} content={ready} draft={draft} hidden={hiddenScenes} hiddenRows={hiddenRows} onHide={setSceneHidden}
                onChange={setDraft} onNext={() => setTab("customize")} />
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
                poolSize={randomPool?.length ?? null}
                blocked={randomBlock}
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
                revisit={revisit && revisit.scene === draftScene(draft) ? revisit : null}
                onRevisitUsed={revisitUsed}
              />
            </div>
            {tab === "practice" && mode === "adult" && <PracticeView />}
            {tab === "library" && (
              <LibraryTab
                key={mode}
                packs={packs}
                folders={folders}
                content={ready}
                currentId={draft.sourceId}
                onLoad={load}
                onClone={clone}
                onPracticeAgain={practiceAgain}
                onMove={move}
                onRename={rename}
                onDelete={remove}
                onCreateFolder={addFolder}
                onDeleteFolder={removeFolder}
                mode={mode}
                onRestored={restored}
                onStale={() => refreshPacks().catch(() => undefined)}
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
    </ScriptProvider>
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

/** Which scene a draft plays, as Practice again remembers it. */
function draftScene(d: Draft): string {
  return d.scenarioMode === "quick" ? `q:${d.quickScenario.trim()}` : d.scenarioMode === "random" ? "random" : `s:${d.scenario}`;
}
