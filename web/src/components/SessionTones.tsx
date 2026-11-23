import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { checkClip, sessionTones } from "../pronunciationApi";
import type { SessionTonesReply, ToneCount, ToneFlag, ToneMove, ToneVsLast } from "../types";
import { MarkedText } from "./Ruby";

/* The recap's Tones section (pronunciation stage 3, ld-ne0.4; docs/VOICE.md
 * §Tones after the session): the session's stored tone checks, counted on
 * the server with no model call. How many syllables were checked and how
 * they came out, by tone, the flagged ones in their lines with the kept
 * recording to hear, and the last attempt of the scene compared. Adults
 * only (the caller never mounts it for a child, and the server answers
 * nothing for one); a session with no checks (the dial off, another
 * language) shows nothing at all. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const TONE_LABEL: Record<number, string> = { 1: "Tone 1", 2: "Tone 2", 3: "Tone 3", 4: "Tone 4", 0: "Neutral" };
const TONE_SHAPE: Record<number, string> = { 1: "high, level", 2: "rising", 3: "low, dipping", 4: "falling", 0: "light" };
const pct = (ok: number, n: number) => (n ? `${Math.round((ok / n) * 100)}%` : "–");

/** Plays a kept clip, whole or one syllable's stretch of it. Each clip is
 *  fetched once per card and decoded in the page; one sound at a time. */
function useClipPlayer() {
  const clips = useRef(new Map<string, Promise<AudioBuffer>>());
  const ctx = useRef<AudioContext | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      playing.current?.stop();
      void ctx.current?.close();
    },
    [],
  );
  async function play(key: string, checkId: string, span: { startMs: number; endMs: number } | null) {
    setError(null);
    setBusy(key);
    try {
      ctx.current ??= new AudioContext();
      const ac = ctx.current;
      if (ac.state === "suspended") await ac.resume();
      let got = clips.current.get(checkId);
      if (!got) {
        got = checkClip(checkId).then(async (b) => ac.decodeAudioData(await b.arrayBuffer()));
        clips.current.set(checkId, got);
        // A failed fetch isn't kept: the next tap asks again.
        got.catch(() => clips.current.delete(checkId));
      }
      const buf = await got;
      playing.current?.stop();
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      playing.current = src;
      // A syllable's stretch with a little air either side: the engine's
      // spans are tight, and a cut mid-onset sounds like another word.
      if (span) {
        const from = Math.max(0, (span.startMs - 120) / 1000);
        const to = Math.min(buf.duration, (span.endMs + 120) / 1000);
        src.start(0, from, Math.max(0.05, to - from));
      } else src.start();
      src.onended = () => setBusy((b) => (b === key ? null : b));
    } catch (e) {
      setBusy(null);
      setError(`The recording couldn't be played: ${errText(e)}`);
    }
  }
  return { play, busy, error };
}

/** The line with its flagged character marked (its `place` among the Han
 *  characters, as the check counted them). */
function FlaggedLine({ f, locale }: { f: ToneFlag; locale: string | null }) {
  const chars = [...f.line];
  let seen = 0;
  let at = -1;
  for (let i = 0; i < chars.length; i++) {
    if (/\p{Script=Han}/u.test(chars[i]) && ++seen === f.place) {
      at = i;
      break;
    }
  }
  if (at < 0) return <span lang={locale ?? undefined}>{f.line}</span>;
  return (
    <span lang={locale ?? undefined}>
      <MarkedText before={chars.slice(0, at).join("")} marked={chars[at]} after={chars.slice(at + 1).join("")} locale={locale} markClassName="rounded bg-err-soft px-0.5 text-err" />
    </span>
  );
}

const MOVE: Record<ToneMove, { sign: string; cls: string }> = {
  up: { sign: "↑", cls: "text-accent" },
  down: { sign: "↓", cls: "text-fg-3" },
  same: { sign: "=", cls: "text-fg-3" },
};

function VsLastTones({ vs }: { vs: ToneVsLast }) {
  const date = new Date(vs.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const line = (label: string, now: { ok: number; checked: number }, was: { ok: number; checked: number }, move: ToneMove, key: string) => (
    <li key={key}>
      <span className={MOVE[move].cls}>{MOVE[move].sign}</span> {label}:{" "}
      <span className="text-fg-3">
        {pct(was.ok, was.checked)} right ({was.ok} of {was.checked}) → {pct(now.ok, now.checked)} ({now.ok} of {now.checked})
      </span>
    </li>
  );
  return (
    <div data-testid="recap-tones-vs-last">
      <p className={`${fine} font-medium text-fg-3`}>Since last time ({date})</p>
      <ul className="mt-0.5 flex flex-col gap-0.5 text-sm text-fg-2">
        {line("All tones", vs.overall.now, vs.overall.was, vs.overall.move, "all")}
        {vs.tones.map((t) => line(TONE_LABEL[t.tone], t.now, t.was, t.move, `t${t.tone}`))}
        {vs.flagged.now !== vs.flagged.was && (
          <li key="flagged">
            <span className={vs.flagged.now < vs.flagged.was ? "text-accent" : "text-fg-3"}>{vs.flagged.now < vs.flagged.was ? "↑" : "↓"}</span> Flagged:{" "}
            <span className="text-fg-3">
              {vs.flagged.was} → {vs.flagged.now}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function ToneRow({ t }: { t: ToneCount & { tone: number } }) {
  const judged = t.tone !== 0;
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1 pr-2 text-left font-normal text-fg">
        {TONE_LABEL[t.tone]} <span className="text-fg-3">({TONE_SHAPE[t.tone]})</span>
      </th>
      <td className="px-1 py-1 text-right tabular-nums">{t.checked}</td>
      <td className="px-1 py-1 text-right text-accent tabular-nums">{t.ok}</td>
      <td className={`px-1 py-1 text-right tabular-nums ${t.off ? "text-err" : ""}`}>{t.off}</td>
      <td className="px-1 py-1 text-right text-fg-3 tabular-nums">{t.unsure}</td>
      <td className="py-1 pl-1 text-right tabular-nums">{judged ? pct(t.ok, t.checked) : "–"}</td>
    </tr>
  );
}

/** The Tones section for conversation `id`, or nothing. */
export function SessionTonesSection({ id, locale }: { id: string; locale: string | null }) {
  const [data, setData] = useState<SessionTonesReply["tones"] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const player = useClipPlayer();
  useEffect(() => {
    const ctrl = new AbortController();
    sessionTones(id, ctrl.signal).then(
      (r) => setData(r.tones),
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [id]);
  if (error) return <p className={`${fine} text-fg-3`}>The tone summary couldn't be loaded: {error}</p>;
  if (!data) return null;
  const t = data;
  return (
    <div className="flex flex-col gap-2" data-testid="recap-tones">
      <h4 className="text-xs font-medium tracking-wide text-fg-3 uppercase">Tones</h4>
      <p className="text-sm text-fg-2" data-testid="recap-tones-summary">
        {t.checked} syllable{t.checked === 1 ? "" : "s"} checked in {t.turns} line{t.turns === 1 ? "" : "s"}: <span className="text-accent">{t.ok} right</span>
        {" · "}
        <span className={t.off ? "text-err" : ""}>{t.off} off</span>
        {" · "}
        {t.unsure} not sure
        {t.judged.checked > 0 && <span className="text-fg-3"> ({pct(t.judged.ok, t.judged.checked)} of tones 1–4 heard right)</span>}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-fg-2" data-testid="recap-tones-table">
          <thead>
            <tr className={`${fine} text-fg-3`}>
              <th scope="col" className="py-1 pr-2 text-left font-normal">
                Tone
              </th>
              <th scope="col" className="px-1 py-1 text-right font-normal">
                Checked
              </th>
              <th scope="col" className="px-1 py-1 text-right font-normal">
                Right
              </th>
              <th scope="col" className="px-1 py-1 text-right font-normal">
                Off
              </th>
              <th scope="col" className="px-1 py-1 text-right font-normal">
                Not sure
              </th>
              <th scope="col" className="py-1 pl-1 text-right font-normal">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {t.byTone.map((row) => (
              <ToneRow key={row.tone} t={row} />
            ))}
          </tbody>
        </table>
      </div>
      {t.flagged.length > 0 && (
        <div>
          <p className={`${fine} font-medium text-fg-3`}>Flagged</p>
          <ul className="mt-1 flex flex-col gap-2" data-testid="recap-tones-flagged">
            {t.flagged.map((f, i) => {
              const key = `${i}:${f.checkId}:${f.place}`;
              const span = f.startMs != null && f.endMs != null && f.endMs > f.startMs ? { startMs: f.startMs, endMs: f.endMs } : null;
              return (
                <li key={key} className="flex flex-col gap-1 rounded-lg border border-line p-2">
                  <p className="text-base text-fg">
                    <FlaggedLine f={f} locale={locale} />
                  </p>
                  <p className={`${fine} text-fg-2`}>
                    <span lang="zh" className="font-medium text-fg">
                      {f.char}
                    </span>{" "}
                    {f.pinyin}: expected tone {f.expectedTone} ({TONE_SHAPE[f.expectedTone]}), heard {f.heardTone != null ? `tone ${f.heardTone} (${TONE_SHAPE[f.heardTone] ?? "?"})` : "another tone"}
                  </p>
                  {f.checkId ? (
                    <div className="flex flex-wrap gap-2">
                      {span && (
                        <button type="button" className={`${fine} rounded-md border border-line px-2 py-0.5 text-fg-2 hover:bg-raised`} onClick={() => void player.play(`${key}:s`, f.checkId!, span)} disabled={player.busy === `${key}:s`} data-testid="recap-tones-play-syllable">
                          ▶ {f.char}
                        </button>
                      )}
                      <button type="button" className={`${fine} rounded-md border border-line px-2 py-0.5 text-fg-2 hover:bg-raised`} onClick={() => void player.play(`${key}:l`, f.checkId!, null)} disabled={player.busy === `${key}:l`} data-testid="recap-tones-play-line">
                        ▶ The whole line
                      </button>
                    </div>
                  ) : (
                    <p className={`${fine} text-fg-3`}>Its recording wasn't kept (a session keeps 20 at most).</p>
                  )}
                </li>
              );
            })}
          </ul>
          {player.error && <p className={`${fine} mt-1 text-err`}>{player.error}</p>}
        </div>
      )}
      {t.vsLast && <VsLastTones vs={t.vsLast} />}
      <p className={`${fine} text-fg-3`}>Checked by the program as you spoke: a flag is only a clear miss, and "not sure" is never a mistake.</p>
    </div>
  );
}
