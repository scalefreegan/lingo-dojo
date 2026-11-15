import { useCallback, useEffect, useState } from "react";
import { ApiError, STALE_LEARNER_EVENT, UNAUTHORIZED_EVENT, getMe, logout, pickLanguage, pickLearner, setPageLearner } from "./api";
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
export default function AuthGate() {
  const [me, setMeState] = useState<MeReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Who's practicing?" opened from the app (to add or archive), with a way back.
  const [picking, setPicking] = useState(false);

  /** What the page shows, and the learner and language every call says it
   *  shows (api.ts setPageLearner), changed together. The browser-stored
   *  draft, tab and filters a learner had before language profiles become
   *  this language's, the first it opens here (draft.ts). */
  const setMe = useCallback((m: MeReply) => {
    const page = m.user && m.learner && m.language ? { learnerId: m.learner.id, languageId: m.language.id } : null;
    if (page) adoptLearnerKeys(page.learnerId, page.languageId);
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

  async function signOut() {
    try {
      await logout();
    } catch {
      /* already logged out: the refresh below shows the login form either way */
    }
    setPicking(false);
    await refresh();
  }

  async function choose(id: string | null) {
    try {
      setMe(await pickLearner(id));
      setPicking(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function chooseLanguage(id: string) {
    try {
      setMe(await pickLanguage(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

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
        error={error}
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
      onManageLearners={() => setPicking(true)}
      onLogout={() => void signOut()}
      onLearnerSaved={refresh}
    />
  );
}
