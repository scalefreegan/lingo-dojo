import { useCallback, useEffect, useState } from "react";
import { ApiError, STALE_LEARNER_EVENT, UNAUTHORIZED_EVENT, endConversation, getMe, getPageLearner, logout, pickLanguage, pickLearner, setBootId, setPageLearner, settleBeforeSwitch } from "./api";
import { dropLiveSessions, endLeftSession } from "./liveSession";
import { hydratePrefs } from "./prefs";
import { adoptLearnerKeys, dropModeKeys } from "./draft";
import type { MeReply } from "./types";
import App from "./App";
import AccountScreen from "./components/AccountScreen";
import LearnerPicker from "./components/LearnerPicker";

/* Who is using the app, before anything else (docs/DATA.md §Auth):
 *
 *   no accounts at all  → "Create the first account" (the admin)
 *   not logged in       → the login form
 *   no learner picked   → "Who's practicing?"
 *   otherwise           → the app, as that learner, in that learner's mode,
 *                         practising its active language (the top bar's
 *                         language switcher changes it)
 *
 * The server holds all of it (an httpOnly cookie and the session row); this
 * only asks /api/auth/me and redraws. Any 401 from any call (the session
 * ended elsewhere) fires UNAUTHORIZED_EVENT, and any 409 `stale_learner`
 * (another tab picked someone else or another language, archived this
 * learner, or logged in as another account) fires STALE_LEARNER_EVENT; both
 * re-ask. App is keyed by the user, the learner and the language, so a
 * switch remounts it with that profile's own mode, packs, draft and tab,
 * and nothing of the previous one's state survives. */
/** A slow network delays a switch by at most this. */
const LEAVE_MS = 1500;

export default function AuthGate() {
  const [me, setMeState] = useState<MeReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Who's practicing?" opened from the app (to add or archive), with a way back.
  const [picking, setPicking] = useState(false);
  // A learner or language switch that failed (one another tab just
  // archived, say), shown where it was asked for: the app's bar, or the
  // picker. Cleared by the next switch or by dismissing it.
  const [switchError, setSwitchError] = useState<string | null>(null);

  /** What the page shows, and the learner and language every call says it
   *  shows (api.ts setPageLearner), changed together. The browser-stored
   *  draft, tab and filters a learner had before language profiles become
   *  its oldest language's: the profile migration 0002 made from the
   *  learner's own columns, whose draft they were (draft.ts). */
  const setMe = useCallback((m: MeReply) => {
    const page = m.user && m.learner && m.language ? { learnerId: m.learner.id, languageId: m.language.id } : null;
    if (m.learner?.languages[0]) adoptLearnerKeys(m.learner.id, m.learner.languages[0].id);
    // Before the app draws: what it starts from is read from these.
    if (page && m.prefs) hydratePrefs(page, m.prefs);
    setBootId(m.boot);
    setPageLearner(page);
    setMeState(m);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await getMe());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [setMe]);

  useEffect(() => {
    // Drafts, tabs and Scene filters were once kept per mode, shared by
    // whoever used this browser; they are per learner now (draft.ts).
    dropModeKeys();
    // The first ask; every later one comes from an action, a 401 or a 409.
    getMe().then(setMe, (e) => setError(e instanceof ApiError ? e.message : String(e)));
    const again = () => void refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, again);
    window.addEventListener(STALE_LEARNER_EVENT, again);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, again);
      window.removeEventListener(STALE_LEARNER_EVENT, again);
    };
  }, [refresh, setMe]);

  // The kids accent belongs to a kids learner's app; the screens before it
  // are neutral.
  useEffect(() => {
    if (!me?.learner || picking) document.documentElement.dataset.mode = "adult";
  }, [me, picking]);

  /** What the page had open ends while its headers still name it: by the
   *  app itself, or, with the learner list over it, here. */
  async function leave() {
    await settleBeforeSwitch();
    const page = getPageLearner();
    if (!page) return;
    const ended = endLeftSession(page.languageId, (c) => endConversation(c.id, c.page));
    await Promise.race([ended, new Promise((r) => setTimeout(r, LEAVE_MS))]);
  }

  async function signOut() {
    // The open session's End needs the login it belongs to.
    await leave();
    dropLiveSessions();
    try {
      await logout();
    } catch {
      /* already logged out: the refresh below shows the login form either way */
    }
    setPicking(false);
    await refresh();
  }

  /** Switch, after the page has ended what it had open (the voice
   *  session's conversation) while its headers still name it. A refused
   *  switch says so where it was asked and re-reads the lists, which drops
   *  a learner or language another tab archived. `stays`: the pick is who
   *  is practising already, and a session goes on. */
  async function switchTo(pick: () => Promise<MeReply>, then?: () => void, stays = false) {
    setSwitchError(null);
    await (stays ? settleBeforeSwitch() : leave());
    try {
      setMe(await pick());
      then?.();
    } catch (e) {
      setSwitchError(e instanceof ApiError ? e.message : String(e));
      await refresh();
    }
  }

  const choose = (id: string | null) => switchTo(() => pickLearner(id), () => setPicking(false), picking && id === me?.learner?.id);
  const chooseLanguage = (id: string) => switchTo(() => pickLanguage(id));

  if (error && !me) {
    return (
      <p className="p-6 text-sm text-err">
        Could not reach the server: {error}{" "}
        <button type="button" className="underline" onClick={() => void refresh()}>
          Try again
        </button>
      </p>
    );
  }
  if (!me) return <p className="p-6 text-sm text-fg-3">Loading…</p>;
  if (me.firstRun && !me.firstRunHere) {
    return (
      <p className="p-6 text-sm text-fg-2" data-testid="first-run-remote">
        No one has an account yet. Create the first account on the Mac that runs Lingo Dojo (open http://localhost:38400 there), then log in here.
      </p>
    );
  }
  if (me.firstRun) return <AccountScreen kind="first-run" onDone={setMe} />;
  if (!me.user) return <AccountScreen kind="login" onDone={setMe} />;
  if (!me.learner || !me.language || picking) {
    return (
      <LearnerPicker
        me={me}
        error={switchError ?? error}
        onPick={(id) => void choose(id)}
        onChanged={refresh}
        onCancel={me.learner ? () => setPicking(false) : undefined}
        onLogout={() => void signOut()}
      />
    );
  }
  return (
    <App
      key={`${me.user.id}:${me.learner.id}:${me.language.id}`}
      user={me.user}
      learner={me.learner}
      language={me.language}
      learners={me.learners}
      onSwitchLearner={(id) => void choose(id)}
      onSwitchLanguage={(id) => void chooseLanguage(id)}
      switchError={switchError}
      onDismissSwitchError={() => setSwitchError(null)}
      onManageLearners={() => setPicking(true)}
      onLogout={() => void signOut()}
      onLearnerSaved={refresh}
    />
  );
}
