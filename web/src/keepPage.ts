/* Vite's dev server serves the app, and its client reloads the whole page
 * whenever its websocket drops and comes back: on a phone, after every lock
 * or look at another app. That throws away what the learner was doing for
 * nothing (docs/VOICE.md §Reload). Here the reload waits:
 *
 *   - while something is going on (`keepPage`: a session, a practice round);
 *   - and, for a dropped socket, until the server turns out to have been
 *     restarted, so a page that only lost its socket stays as it is. It then
 *     gets no live edits until it is next loaded, which only someone editing
 *     the code on that device would miss: on localhost the reload comes as
 *     before, once nothing is going on.
 *
 * Vite waits for its listeners before it reloads (client.mjs handleMessage,
 * notifyListeners), so holding one back is all this does. */

import { bootId, getBootId } from "./api";

const doing = new Set<string>();
let waiters: (() => void)[] = [];

/** Something the learner would lose to a reload is going on (or no longer). */
export function keepPage(what: string, on: boolean): void {
  if (on) doing.add(what);
  else doing.delete(what);
  if (doing.size) return;
  const go = waiters;
  waiters = [];
  for (const w of go) w();
}

const untilIdle = () => (doing.size ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve());

/** Resolves once the server answers as another start than the page's own.
 *  Asked when the page is looked at again, and a little later if it can't
 *  be reached yet. */
async function untilRestarted(): Promise<void> {
  const ours = bootId();
  for (;;) {
    const now = document.visibilityState === "visible" ? await getBootId() : null;
    if (now && ours && now !== ours) return;
    await new Promise<void>((r) => {
      const next = () => {
        document.removeEventListener("visibilitychange", next);
        clearTimeout(timer);
        r();
      };
      const timer = now || document.visibilityState !== "visible" ? undefined : setTimeout(next, 3000);
      document.addEventListener("visibilitychange", next);
    });
  }
}

if (import.meta.hot) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  import.meta.hot.on("vite:ws:disconnect", async () => {
    if (!local) await untilRestarted();
    await untilIdle();
  });
  // An edit that can't be applied in place (a server restart sends the
  // socket's drop instead).
  import.meta.hot.on("vite:beforeFullReload", untilIdle);
}
