import { useEffect, useState } from "react";
import { ApiError, getRecap, retryRecap } from "../api";
import { openBank } from "../bankLink";
import type { MasteryBand, RecapEvent, SessionRecap as Recap } from "../types";
import { GlossStar } from "./GlossStar";
import { RubyText } from "./Ruby";
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
/** Asking slows to this after a failed request. */
const RETRY_MS = 5000;
/** Stop asking after this long (a recap is two model calls of 180 s at
 *  most); then the card offers Check again, which starts a new budget. */
const GIVE_UP_MS = 10 * 60_000;
/** On the Go tab, just after End: how long a recap not started yet ("none",
 *  or "open" while End is on its way) still reads as about to start.
 *  Asking goes on after it; only the card changes, to say what is up and
 *  offer a way on. */
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
/** `locale`: the session's target language, the transcript's: the card's
 *  phrases take the same readings (the transcript's Readings switch; no
 *  switch of its own). */
export function SessionRecap({ id, justEnded = false, locale = null }: { id: string; justEnded?: boolean; locale?: string | null }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to start asking again (after a retry, or Check again).
  const [round, setRound] = useState(0);
  // Which round stopped asking (the recap is final, or the budget ran
  // out) and whose start grace has passed: keyed by round, so a new round
  // (or another id) starts out asking, in its grace.
  const key = `${id}:${justEnded}:${round}`;
  const [stopped, setStopped] = useState<string | null>(null);
  const [graceDone, setGraceDone] = useState<string | null>(null);
  const polling = stopped !== key;
  const graceOver = graceDone === key;

  useEffect(() => {
    const ctrl = new AbortController();
    const began = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    // Cleared once this round stops asking.
    let asking = true;
    const grace = justEnded ? setTimeout(() => setGraceDone(key), START_GRACE_MS) : undefined;
    const next = (ms: number) => {
      if (Date.now() - began < GIVE_UP_MS) timer = setTimeout(ask, ms);
      else stop();
    };
    const stop = () => {
      asking = false;
      setStopped(key);
    };
    // Still on its way: being made, or (just after End) about to be. A
    // final status (done, failed, skipped; none or open seen from History)
    // stops asking.
    const waiting = (r: Recap) => r.status === "pending" || (justEnded && (r.status === "open" || r.status === "none"));
    function ask() {
      if (inFlight || ctrl.signal.aborted) return;
      clearTimeout(timer);
      inFlight = true;
      getRecap(id, ctrl.signal).then(
        ({ recap: r }) => {
          inFlight = false;
          setRecap(r);
          setError(null);
          if (waiting(r)) next(POLL_MS);
          else stop();
        },
        (e) => {
          inFlight = false;
          if (ctrl.signal.aborted) return;
          // A dropped request (the network, a server restart) isn't the
          // recap's fate: say so and keep asking, more slowly.
          setError(errText(e));
          next(RETRY_MS);
        },
      );
    }
    // A tab in the background has its timers slowed or stopped: ask at once
    // when it is shown again.
    const onShow = () => {
      if (document.visibilityState === "visible" && asking) ask();
    };
    document.addEventListener("visibilitychange", onShow);
    ask();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      clearTimeout(grace);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [id, justEnded, key]);

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
  // Just after End, before the recap has started: quiet, for the grace.
  const starting = (status === "open" || status === "none") && justEnded && !graceOver && polling;
  const again = (
    <Button variant="ghost" className="px-2 py-1 text-sm sm:text-xs" onClick={() => setRound((n) => n + 1)} data-testid="recap-check">
      Check again
    </Button>
  );
  // An open session elsewhere (History) has no recap yet: nothing to show.
  if (!recap && !error) return null;
  if (status === "open" && !justEnded) return null;

  const well = (recap?.events ?? []).filter((e) => WENT_WELL.has(e.kind));
  const fix = (recap?.events ?? []).filter((e) => !WENT_WELL.has(e.kind));
  const heading = kids ? "What you did today" : "Session recap";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4" aria-label={heading} data-testid="session-recap" data-status={status ?? "error"}>
      <h3 className="text-sm font-medium text-fg">{heading}</h3>
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-err">
            Couldn't get the recap: {error}
            {polling ? " (trying again…)" : ""}
          </p>
          {!polling && again}
        </div>
      )}
      {(status === "pending" || starting) && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-fg-3" role="status">
            {polling ? (kids ? "Thinking about what you did…" : "Writing your recap…") : "Still being written."}
          </p>
          {!polling && again}
        </div>
      )}
      {status === "open" && justEnded && !starting && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-fg-3">The session hasn't finished closing yet; its recap starts when it has.</p>
          {again}
        </div>
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
                {recap.kept.map((k, i) => (
                  <li key={`${i}:${k.text}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium text-fg" lang={locale ?? undefined}>
                      <RubyText text={k.text} locale={locale} />
                    </span>
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
                {well.map((e, i) => (
                  <li key={`${i}:${e.phrase}:${e.kind}`}>
                    <span className="font-medium text-fg" lang={locale ?? undefined}>
                      <RubyText text={e.phrase} locale={locale} />
                    </span>
                    {!kids && <span className="text-fg-3">: {KIND[e.kind]}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Kids see only the corrections here (their events aren't listed),
              so the heading needs one of those. */}
          {(recap.corrections.length > 0 || (!kids && fix.length > 0)) && (
            <div>
              <h4 className="text-xs font-medium tracking-wide text-fg-3 uppercase">{kids ? "Try saying it like this" : "To work on"}</h4>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-fg-2" data-testid="recap-corrections">
                {recap.corrections.map((c, i) => (
                  <li key={`${i}:${c.said}→${c.better}`}>
                    <span className="text-fg-3 line-through" lang={locale ?? undefined}>
                      <RubyText text={c.said} locale={locale} />
                    </span>{" "}
                    →{" "}
                    <span className="font-medium text-fg" lang={locale ?? undefined}>
                      <RubyText text={c.better} locale={locale} />
                    </span>
                    {c.note && <span className="text-fg-3"> ({c.note})</span>}
                  </li>
                ))}
                {!kids &&
                  fix.map((e, i) => (
                    <li key={`${i}:${e.phrase}:${e.kind}`}>
                      <span className="font-medium text-fg" lang={locale ?? undefined}>
                        <RubyText text={e.phrase} locale={locale} />
                      </span>
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
