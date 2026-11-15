import { useEffect, useState } from "react";
import { ApiError, getRecap, retryRecap } from "../api";
import { openBank } from "../bankLink";
import type { MasteryBand, RecapEvent, SessionRecap as Recap } from "../types";
import { GlossStar } from "./GlossStar";
import { Badge, Button } from "./ui";

/* The session recap (docs/DATA.md §Post-session extraction), under the
 * transcript: on the Go tab once End is pressed, and in History. It asks
 * the server where the recap is and waits quietly while it is being made
 * (the model runs after End, in the background), then shows the summary,
 * the phrases kept (with ☆ and a link to the bank), what went well and what
 * to work on. A recap that failed offers Retry recap; one never made (a
 * session from before recaps) offers to make it. A kids learner's card says
 * it all more simply. */

const POLL_MS = 2000;
/** Stop asking after this long: a recap is two model calls at most. */
const GIVE_UP_MS = 8 * 60_000;
/** On the Go tab, just after End: how long a recap not started yet ("none",
 *  or "open" while End is on its way) still counts as about to start. */
const START_GRACE_MS = 30_000;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const BAND_TONE: Record<MasteryBand, "neutral" | "warn" | "accent"> = { New: "neutral", Learning: "warn", Familiar: "accent", Mastered: "accent" };
const WENT_WELL = new Set<RecapEvent["kind"]>(["produced", "produced_with_help", "understood"]);
const KIND: Record<RecapEvent["kind"], string> = {
  produced: "said it",
  produced_with_help: "said it with a hint",
  understood: "understood it",
  corrected: "tried it",
  confused: "wasn't sure of it",
};

/** `justEnded`: the Go tab's session that End just closed (its recap is
 *  about to start, so "open" and "none" wait instead of offering a button). */
export function SessionRecap({ id, justEnded = false }: { id: string; justEnded?: boolean }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to start asking again (after a retry).
  const [round, setRound] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const began = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      getRecap(id, ctrl.signal).then(
        ({ recap: r }) => {
          setRecap(r);
          setError(null);
          const waiting = r.status === "pending" || ((r.status === "open" || r.status === "none") && justEnded && Date.now() - began < START_GRACE_MS);
          if (waiting && Date.now() - began < GIVE_UP_MS) timer = setTimeout(ask, POLL_MS);
        },
        (e) => {
          if (!ctrl.signal.aborted) setError(errText(e));
        },
      );
    };
    ask();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [id, justEnded, round]);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      setRecap((await retryRecap(id)).recap);
      setRound((n) => n + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const kids = !!recap?.kids;
  const status = recap?.status;
  const starting = (status === "open" || status === "none") && justEnded;
  // An open session elsewhere (History) has no recap yet: nothing to show.
  if (!recap && !error) return null;
  if (status === "open" && !justEnded) return null;

  const well = (recap?.events ?? []).filter((e) => WENT_WELL.has(e.kind));
  const fix = (recap?.events ?? []).filter((e) => !WENT_WELL.has(e.kind));
  const heading = kids ? "What you did today" : "Session recap";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4" aria-label={heading} data-testid="session-recap" data-status={status ?? "error"}>
      <h3 className="text-sm font-medium text-fg">{heading}</h3>
      {error && <p className="text-sm text-err">Couldn't get the recap: {error}</p>}
      {(status === "pending" || starting) && (
        <p className="text-sm text-fg-3" role="status">
          {kids ? "Thinking about what you did…" : "Writing your recap…"}
        </p>
      )}
      {status === "failed" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-fg-2">
            The recap didn't come through{recap?.error ? ` (${recap.error})` : ""}.
          </p>
          <Button variant="ghost" className="px-2 py-1 text-sm sm:text-xs" onClick={() => void retry()} disabled={busy} data-testid="recap-retry">
            Retry recap
          </Button>
        </div>
      )}
      {status === "none" && !starting && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-fg-3">No recap for this session yet.</p>
          <Button variant="ghost" className="px-2 py-1 text-sm sm:text-xs" onClick={() => void retry()} disabled={busy} data-testid="recap-retry">
            Make a recap
          </Button>
        </div>
      )}
      {status === "skipped" && <p className="text-sm text-fg-3">{kids ? "You didn't say anything this time." : "Nothing to recap: you didn't answer in this one."}</p>}
      {status === "done" && recap && (
        <>
          {recap.summary && <p className="text-sm text-fg-2">{recap.summary}</p>}
          {recap.kept.length > 0 && (
            <div>
              <h4 className="text-xs font-medium tracking-wide text-fg-3 uppercase">{kids ? "New words" : "Phrases kept"}</h4>
              <ul className="mt-1 flex flex-col gap-1" data-testid="recap-kept">
                {recap.kept.map((k) => (
                  <li key={k.text} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium text-fg">{k.text}</span>
                    <span className="text-fg-3">{k.meaning}</span>
                    {!kids && k.mastery && <Badge tone={BAND_TONE[k.mastery]}>{k.mastery}</Badge>}
                    <span className="flex-1" />
                    {k.phraseId && (
                      <>
                        <GlossStar gloss={{ term: k.text, meaning: k.meaning }} />
                        <button type="button" className="text-xs text-fg-3 underline hover:text-fg" onClick={() => openBank(k.text)}>
                          In the bank
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {well.length > 0 && (
            <div>
              <h4 className="text-xs font-medium tracking-wide text-fg-3 uppercase">{kids ? "You did it!" : "What went well"}</h4>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-fg-2">
                {well.map((e) => (
                  <li key={`${e.phrase}:${e.kind}`}>
                    <span className="font-medium text-fg">{e.phrase}</span>
                    {!kids && <span className="text-fg-3">: {KIND[e.kind]}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(recap.corrections.length > 0 || fix.length > 0) && (
            <div>
              <h4 className="text-xs font-medium tracking-wide text-fg-3 uppercase">{kids ? "Try saying it like this" : "To work on"}</h4>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-fg-2" data-testid="recap-corrections">
                {recap.corrections.map((c) => (
                  <li key={`${c.said}→${c.better}`}>
                    <span className="text-fg-3 line-through">{c.said}</span> → <span className="font-medium text-fg">{c.better}</span>
                    {c.note && <span className="text-fg-3"> ({c.note})</span>}
                  </li>
                ))}
                {!kids &&
                  fix.map((e) => (
                    <li key={`${e.phrase}:${e.kind}`}>
                      <span className="font-medium text-fg">{e.phrase}</span>
                      <span className="text-fg-3">
                        : {KIND[e.kind]}
                        {e.said ? ` (you said "${e.said}")` : ""}
                        {e.note ? `, ${e.note}` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {!recap.inBank && <p className="text-xs text-fg-3">This session was in another language than this phrase bank's, so nothing went into it.</p>}
          {recap.inBank && !kids && recap.events.some((e) => e.reviewed) && (
            <p className="text-xs text-fg-3">How you did on these phrases is in your phrase bank's practice schedule.</p>
          )}
        </>
      )}
    </section>
  );
}
