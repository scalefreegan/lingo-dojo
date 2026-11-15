import { useEffect, useState } from "react";
import { ApiError, addPhrase, lookupPhrase, updatePhrase } from "../api";
import type { VoiceGloss } from "../types";

/* ☆ Star, in the transcript's definition card (the Go tab's session and a
 * saved one in History): puts the glossed words in the active language's
 * phrase bank, starred, or unstars them (docs/DATA.md §Phrase capture,
 * "Manual"). The card looks the words up when it opens, so a star given in
 * another session shows as given. Any gloss can be starred, a sentence's
 * translation too, though only words and short phrases go into the bank on
 * their own. */
export function GlossStar({ gloss }: { gloss: VoiceGloss }) {
  // null while the lookup runs.
  const [state, setState] = useState<{ id: string | null; starred: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    lookupPhrase(gloss.term, ctrl.signal).then(
      (r) => setState({ id: r.phrase?.id ?? null, starred: !!r.phrase?.starred }),
      // Unknown is shown as unstarred: a Star then adds it, which is right
      // either way (an existing phrase is starred, not duplicated).
      () => {
        if (!ctrl.signal.aborted) setState({ id: null, starred: false });
      },
    );
    return () => ctrl.abort();
  }, [gloss.term]);

  async function toggle() {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = state.starred && state.id ? await updatePhrase(state.id, { starred: false }) : await addPhrase({ text: gloss.term, meaning: gloss.meaning, starred: true });
      setState({ id: r.phrase.id, starred: r.phrase.starred });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  const starred = !!state?.starred;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {error && <span className="text-xs text-err" role="alert">{error}</span>}
      <button
        type="button"
        className={`-my-0.5 inline-flex min-h-6 items-center gap-1 rounded px-1.5 text-xs font-medium ${starred ? "text-accent" : "text-fg-3 hover:text-fg"} disabled:opacity-50`}
        aria-pressed={starred}
        disabled={!state || busy}
        title={starred ? "In your phrase bank, starred. Tap to unstar" : "Star: keep it in your phrase bank"}
        onClick={() => void toggle()}
        data-testid="gloss-star"
      >
        <span aria-hidden="true">{starred ? "★" : "☆"}</span>
        {starred ? "Starred" : "Star"}
      </button>
    </span>
  );
}
