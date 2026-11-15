import { useCallback, useEffect, useState } from "react";
import { ApiError, UNAUTHORIZED_EVENT, getMe, logout, pickLearner } from "./api";
import type { MeReply } from "./types";
import App from "./App";
import AccountScreen from "./components/AccountScreen";
import LearnerPicker from "./components/LearnerPicker";

/* Who is using the app, before anything else (docs/DATA.md §Auth):
 *
 *   no accounts at all  → "Create the first account" (the admin)
 *   not logged in       → the login form
 *   no learner picked   → "Who's practicing?"
 *   otherwise           → the app, as that learner, in that learner's mode
 *
 * The server holds all of it (an httpOnly cookie and the session row); this
 * only asks /api/auth/me and redraws. Any 401 from any call (the session
 * ended elsewhere) fires UNAUTHORIZED_EVENT, which re-asks. App is keyed by
 * the learner, so switching learner remounts it on the new learner's mode. */
export default function AuthGate() {
  const [me, setMe] = useState<MeReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Who's practicing?" opened from the app (to add or archive), with a way back.
  const [picking, setPicking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await getMe());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // The first ask; every later one comes from an action or a 401.
    getMe().then(
      (m) => setMe(m),
      (e) => setError(e instanceof ApiError ? e.message : String(e)),
    );
    const onUnauthorized = () => void refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

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
  if (me.firstRun) return <AccountScreen kind="first-run" onDone={setMe} />;
  if (!me.user) return <AccountScreen kind="login" onDone={setMe} />;
  if (!me.learner || picking) {
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
      key={me.learner.id}
      user={me.user}
      learner={me.learner}
      learners={me.learners}
      onSwitchLearner={(id) => void choose(id)}
      onManageLearners={() => setPicking(true)}
      onLogout={() => void signOut()}
      onLearnerSaved={refresh}
    />
  );
}
