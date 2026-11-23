import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { toneTrend } from "../pronunciationApi";
import type { ToneTrendReply } from "../types";
import { Button, Card } from "./ui";

/* The per-tone trend (pronunciation stage 3, ld-ne0.4; docs/VOICE.md §Tones
 * after the session), in History beside the 7-day card: share of syllables
 * heard right per tone per day, from the tone checks kept with the
 * learner's Go-tab turns. Small multiples, one panel per tone in one hue,
 * so no tone needs a colour of its own and every panel reads alone at
 * phone width. A day with fewer than the server's minimum syllables of a
 * tone has no point (it is still in the table, with its count); a tap or a
 * hover on a point says what it rests on. Adults only (the caller mounts
 * it for adults; the server answers nothing for a child). */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const SHAPE: Record<number, string> = { 1: "high, level", 2: "rising", 3: "low, dipping", 4: "falling" };
const WINDOWS = [30, 90] as const;

type Point = ToneTrendReply["points"][number];

const W = 240;
const H = 84;
const PAD = { l: 26, r: 8, t: 8, b: 16 };
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function Panel({ tone, points, from, to, picked, onPick }: { tone: number; points: Point[]; from: number; to: number; picked: string | null; onPick: (key: string | null) => void }) {
  const x = (d: string) => PAD.l + ((dayMs(d) - from) / Math.max(1, to - from)) * (W - PAD.l - PAD.r);
  const y = (share: number) => PAD.t + (1 - share) * (H - PAD.t - PAD.b);
  const drawn = points.map((p) => ({ p, t: p.tones.find((t) => t.tone === tone)! })).filter((d) => d.t && d.t.share != null);
  const latest = drawn.at(-1);
  // A line only between points on consecutive days: a day without a point
  // (no practice, or too few syllables) is left open rather than bridged
  // as if it had been measured.
  let path = "";
  drawn.forEach((d, i) => {
    const joined = i > 0 && dayMs(d.p.day) - dayMs(drawn[i - 1].p.day) <= 86_400_000;
    path += `${joined ? "L" : "M"}${x(d.p.day).toFixed(1)} ${y(d.t.share!).toFixed(1)} `;
  });
  const sel = drawn.find((d) => `${tone}:${d.p.day}` === picked);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line p-2" data-testid={`tone-trend-${tone}`}>
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
        <span className="font-medium text-fg">
          Tone {tone} <span className={`${fine} font-normal text-fg-3`}>{SHAPE[tone]}</span>
        </span>
        <span className={`${fine} text-fg-2 tabular-nums`}>{latest ? `${Math.round(latest.t.share! * 100)}% · ${fmt(latest.p.day)}` : "not enough yet"}</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Tone ${tone}: share heard right per day, ${drawn.length} day${drawn.length === 1 ? "" : "s"} with enough syllables`}>
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--fg-3)">
              {v * 100}%
            </text>
          </g>
        ))}
        {drawn.length > 1 && <path d={path.trim()} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {drawn.map((d) => {
          const key = `${tone}:${d.p.day}`;
          const on = key === picked;
          return (
            <g key={key} className="cursor-pointer" onClick={() => onPick(on ? null : key)} onMouseEnter={() => onPick(key)}>
              {/* A hit target bigger than the dot. */}
              <circle cx={x(d.p.day)} cy={y(d.t.share!)} r="9" fill="transparent" />
              <circle cx={x(d.p.day)} cy={y(d.t.share!)} r={on ? 4.5 : 3.5} fill="var(--accent)" stroke="var(--panel)" strokeWidth="2" />
              <title>{`${fmt(d.p.day)}: ${d.t.ok} of ${d.t.n} right (${Math.round(d.t.share! * 100)}%)`}</title>
            </g>
          );
        })}
        <text x={PAD.l} y={H - 3} fontSize="9" fill="var(--fg-3)">
          {fmt(new Date(from).toISOString().slice(0, 10))}
        </text>
        <text x={W - PAD.r} y={H - 3} fontSize="9" textAnchor="end" fill="var(--fg-3)">
          {fmt(new Date(to).toISOString().slice(0, 10))}
        </text>
      </svg>
      <p className={`${fine} min-h-[1.25rem] text-fg-2 tabular-nums`} aria-live="polite">
        {sel ? `${fmt(sel.p.day)}: ${sel.t.ok} of ${sel.t.n} syllables right` : ""}
      </p>
    </div>
  );
}

/** The trend card, or nothing while there are no checks in the window. */
export function ToneTrendCard() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<ToneTrendReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    toneTrend(days, ctrl.signal).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [days]);
  if (error) return <p className={`${fine} text-fg-3`}>The tone trend couldn't be loaded: {error}</p>;
  // Nothing checked in the window (the dial off, another language, no
  // sessions): no card, as the 7-day card hides with no sessions. The 90-day
  // view stays reachable from a 30-day one only while that has some.
  if (!data || (!data.points.length && days === 30)) return null;
  // The panels' x axis: the window's days, as the server counted them.
  const fromDay = dayMs(data.from);
  const toDay = dayMs(data.to);
  const anyDrawn = data.points.some((p) => p.tones.some((t) => t.share != null));
  return (
    <Card className="flex flex-col gap-2" data-testid="tone-trend">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-fg">Your tones over time</h2>
        <div role="group" aria-label="Window" className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button key={w} variant={days === w ? "primary" : "ghost"} className="px-2 py-0.5 text-sm sm:text-xs" aria-pressed={days === w} onClick={() => setDays(w)}>
              {w} days
            </Button>
          ))}
        </div>
      </div>
      <p className={`${fine} text-fg-3`}>
        Share of syllables heard right per day, from the tone checks of your Go-tab sessions. A day needs {data.minSyllables} syllables of a tone for a point; tap one to see what it rests on.
      </p>
      {!anyDrawn && <p className="text-sm text-fg-2">Not enough yet: no day has {data.minSyllables} syllables of one tone in this window.</p>}
      {anyDrawn && (
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          {[1, 2, 3, 4].map((tone) => (
            <Panel key={tone} tone={tone} points={data.points} from={fromDay} to={toDay} picked={picked} onPick={setPicked} />
          ))}
        </div>
      )}
      {data.points.length > 0 && (
        <div>
          <button type="button" className={`${fine} text-fg-3 underline hover:text-fg`} aria-expanded={table} onClick={() => setTable((t) => !t)}>
            {table ? "Hide the numbers" : "Show the numbers"}
          </button>
          {table && (
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-sm text-fg-2 tabular-nums" data-testid="tone-trend-table">
                <thead>
                  <tr className={`${fine} text-fg-3`}>
                    <th scope="col" className="py-1 pr-2 text-left font-normal">
                      Day
                    </th>
                    {[1, 2, 3, 4].map((t) => (
                      <th key={t} scope="col" className="px-1 py-1 text-right font-normal">
                        Tone {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data.points].reverse().map((p) => (
                    <tr key={p.day} className="border-t border-line">
                      <th scope="row" className="py-1 pr-2 text-left font-normal">
                        {fmt(p.day)}
                      </th>
                      {p.tones.map((t) => (
                        <td key={t.tone} className={`px-1 py-1 text-right ${t.share == null ? "text-fg-3" : ""}`}>
                          {t.n ? `${t.ok}/${t.n}` : "–"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
