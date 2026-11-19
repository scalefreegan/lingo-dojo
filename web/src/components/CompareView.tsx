import { useEffect, useMemo, useRef, useState } from "react";
import { alignTakes, compareTips, describeTakes, type AlignedTakes, type ModelInput, type Tip } from "../../shared/compare.ts";
import { ApiError } from "../api";
import { modelAnalysis, modelClip, type CompareSource } from "../pronunciationApi";
import { useRubyMode } from "../script/ruby.tsx";
import { readingIn } from "../script/script.ts";
import type { PronunciationModelReply, PronunciationScoreReply } from "../types";
import { Button } from "./ui";

/* Compare mode (ld-ne0.9; docs/VOICE.md §Compare mode): the learner's take
 * laid against the model's, opened from a tone check's result (the
 * character card's "say it", Practice speak-it). One time axis, the
 * learner's: the pitch of both (each voice in semitones about its own
 * middle, so a low voice compares with a high one) and, for adults, their
 * loudness beneath; the syllables marked and labelled; the model stretched
 * syllable by syllable onto the learner's timing (or, with "Real lengths",
 * only shifted so both start together). Under it a few tips, each tied to
 * its syllable (hovering or focusing one highlights it), and playback: my
 * take, the model, both in turn, and one syllable of either on a loop.
 *
 * The model's analysis comes from the server (made once per clip from its
 * own cached audio); the take's frames came with its marks. Nothing is
 * stored: the take is the blob in this page's memory.
 *
 * Kids see less: the pitch lane only (no loudness, no "real lengths", no
 * loop), bigger characters, never red, no numbers, and at most one tip,
 * worded gently, only on a clear miss. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

/* ------------------------------- playback -------------------------------- */

type Playing = null | "mine" | "model" | "both" | "loop-mine" | "loop-model";

/** Both clips through Web Audio, so one syllable can be cut out by its
 *  timings and looped exactly. The context is made on the first press (a
 *  user gesture) and closed with the view. */
function useComparePlayer(take: Blob, model: () => Promise<Blob>) {
  const [playing, setPlaying] = useState<Playing>(null);
  const [error, setError] = useState<string | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const buffers = useRef<{ mine?: Promise<AudioBuffer>; model?: Promise<AudioBuffer> }>({});
  const source = useRef<AudioBufferSourceNode | null>(null);
  const seq = useRef(0);
  // Set when the view closes: a model clip arriving after that must not
  // open an AudioContext no one will close.
  const closed = useRef(false);

  // (Re)opened: React's dev double mount runs the cleanup below once first.
  useEffect(() => {
    closed.current = false;
  }, []);
  useEffect(
    () => () => {
      closed.current = true;
      seq.current++;
      try {
        source.current?.stop();
      } catch {
        /* already stopped */
      }
      void ctx.current?.close();
      ctx.current = null;
    },
    [],
  );

  const audio = () => {
    if (closed.current) throw new Error("the comparison was closed");
    return (ctx.current ??= new AudioContext());
  };
  const bufferOf = (which: "mine" | "model") =>
    (buffers.current[which] ??= (which === "mine" ? Promise.resolve(take) : model())
      .then((b) => b.arrayBuffer())
      .then((a) => audio().decodeAudioData(a))
      .catch((e: unknown) => {
        buffers.current[which] = undefined;
        throw e;
      }));

  function stop() {
    seq.current++;
    try {
      source.current?.stop();
    } catch {
      /* already stopped */
    }
    source.current = null;
    setPlaying(null);
  }

  /** Play one clip from `fromMs` to `toMs` (the whole clip without them);
   *  `loop` repeats that piece until stopped. Resolves when it ends. */
  async function playOne(which: "mine" | "model", mine: number, { fromMs, toMs, loop = false }: { fromMs?: number; toMs?: number; loop?: boolean } = {}): Promise<void> {
    const buf = await bufferOf(which);
    if (mine !== seq.current) return;
    const ac = audio();
    if (ac.state === "suspended") await ac.resume();
    // Stop (or another button, or closing) pressed while the context woke:
    // start nothing, or a loop would play on with no Stop showing.
    if (mine !== seq.current || closed.current) return;
    const node = ac.createBufferSource();
    node.buffer = buf;
    node.connect(ac.destination);
    source.current = node;
    const from = Math.max(0, (fromMs ?? 0) / 1000);
    const to = Math.min(buf.duration, toMs !== undefined ? toMs / 1000 : buf.duration);
    await new Promise<void>((resolve) => {
      node.onended = () => resolve();
      if (loop) {
        node.loop = true;
        node.loopStart = from;
        node.loopEnd = to;
        node.start(0, from);
      } else node.start(0, from, Math.max(0.01, to - from));
    });
  }

  async function run(kind: Exclude<Playing, null>, fn: (mine: number) => Promise<void>) {
    stop();
    setError(null);
    const mine = seq.current;
    setPlaying(kind);
    try {
      await fn(mine);
    } catch (e) {
      if (mine === seq.current) setError(errText(e));
    }
    if (mine === seq.current) setPlaying(null);
  }

  return {
    playing,
    error,
    stop,
    play: (which: "mine" | "model") => run(which, (m) => playOne(which, m)),
    /** The model first, then the take, a beat apart. */
    both: () =>
      run("both", async (m) => {
        await playOne("model", m);
        if (m !== seq.current) return;
        await new Promise((r) => setTimeout(r, 350));
        if (m === seq.current) await playOne("mine", m);
      }),
    loop: (which: "mine" | "model", fromMs: number, toMs: number) => run(which === "mine" ? "loop-mine" : "loop-model", (m) => playOne(which, m, { fromMs, toMs, loop: true })),
  };
}

/* -------------------------------- picture -------------------------------- */

/** The pitch lane's range, semitones either side of a voice's middle. */
const RANGE = 10;
const VW = 1000;
const PH = 100;
const LH = 100;

function linePath(values: (number | null)[], x: (k: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((v, k) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(k).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** A loudness envelope as a filled area from the middle line, up (`dir`
 *  −1) or down (+1). */
function envelopePath(levels: number[], x: (k: number) => number, dir: 1 | -1): string {
  if (!levels.length) return "";
  const h = (db: number) => (Math.max(0, db + 48) / 48) * (LH / 2 - 4);
  let d = `M${x(0).toFixed(1)} ${LH / 2}`;
  levels.forEach((db, k) => (d += ` L${x(k).toFixed(1)} ${(LH / 2 + dir * h(db)).toFixed(1)}`));
  d += ` L${x(levels.length - 1).toFixed(1)} ${LH / 2} Z`;
  return d;
}

interface PictureProps {
  aligned: AlignedTakes;
  reply: PronunciationScoreReply;
  kids: boolean;
  /** The syllable highlighted (a tip hovered or focused, or the one picked). */
  lit: number | null;
  picked: number | null;
  onPick: (i: number) => void;
  label: (i: number) => { char: string; reading: string };
}

function Picture({ aligned, reply, kids, lit, picked, onPick, label }: PictureProps) {
  const span = Math.max(1, aligned.toMs - aligned.fromMs);
  const xMs = (ms: number) => ((ms - aligned.fromMs) / span) * VW;
  const xk = (k: number) => xMs(aligned.t[k]);
  const yP = (v: number) => PH / 2 - (Math.max(-RANGE, Math.min(RANGE, v)) / RANGE) * (PH / 2 - 4);
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - aligned.fromMs) / span) * 100))}%`;
  const mineColour = "var(--accent)";
  const modelColour = "var(--fg-2)";
  const bands = aligned.bands.filter((b) => Number.isFinite(b.fromMs) && Number.isFinite(b.toMs));
  const stroke = kids ? 4 : 2.5;
  return (
    <div className="flex flex-col gap-1">
      {/* The syllables, over their bands: buttons, so a keyboard can pick one. */}
      <div className={`relative ${kids ? "h-14" : "h-11"}`}>
        {bands.map((b) => {
          const s = reply.syllables[b.i];
          const { char, reading } = label(b.i);
          const off = s.verdict === "off";
          return (
            <button
              key={b.i}
              type="button"
              className={`absolute top-0 flex h-full min-w-0 flex-col items-center justify-end overflow-hidden rounded-md px-0.5 leading-tight hover:bg-raised ${picked === b.i ? "ring-2 ring-accent" : ""} ${off ? (kids ? "text-fg" : "text-err") : "text-fg"}`}
              style={{ left: pct(b.fromMs), width: `calc(${pct(b.toMs)} - ${pct(b.fromMs)})` }}
              aria-pressed={picked === b.i}
              aria-label={`${char}${reading ? ` (${reading})` : ""}: pick this syllable${kids ? "" : " to loop it"}`}
              onClick={() => onPick(b.i)}
              data-testid="compare-syllable"
            >
              {reading && <span className={`${fine} text-fg-3`}>{reading}</span>}
              <span lang={reply.locale} className={kids ? "text-3xl" : "text-xl"}>
                {char}
              </span>
            </button>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${VW} ${PH}`} preserveAspectRatio="none" className={`w-full rounded-lg bg-ground ${kids ? "h-48" : "h-40"}`} aria-hidden="true" data-testid="compare-pitch">
        {bands.map((b) => (
          <rect key={b.i} x={xMs(b.fromMs)} width={Math.max(0, xMs(b.toMs) - xMs(b.fromMs))} y={0} height={PH} fill={lit === b.i ? "var(--accent-soft)" : "var(--raised)"} opacity={lit === b.i ? 1 : 0.55} />
        ))}
        <line x1={0} x2={VW} y1={PH / 2} y2={PH / 2} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {bands.flatMap((b) => [b.fromMs, b.toMs]).map((ms, k) => (
          <line key={k} x1={xMs(ms)} x2={xMs(ms)} y1={0} y2={PH} stroke="var(--line-strong)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        ))}
        {!aligned.warped &&
          bands.map((b) =>
            b.modelFromMs !== null && b.modelToMs !== null ? (
              <g key={`m${b.i}`}>
                <line x1={xMs(b.modelFromMs)} x2={xMs(b.modelToMs)} y1={3} y2={3} stroke={modelColour} strokeWidth={3} vectorEffect="non-scaling-stroke" />
              </g>
            ) : null,
          )}
        <path d={linePath(aligned.model.textbook, xk, yP)} fill="none" stroke="var(--fg-3)" strokeWidth={stroke} strokeDasharray="7 6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={linePath(aligned.model.pitch, xk, yP)} fill="none" stroke={modelColour} strokeWidth={stroke + 1} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} vectorEffect="non-scaling-stroke" />
        <path d={linePath(aligned.mine.pitch, xk, yP)} fill="none" stroke={mineColour} strokeWidth={stroke + 0.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {!kids && (
        <svg viewBox={`0 0 ${VW} ${LH}`} preserveAspectRatio="none" className="h-16 w-full rounded-lg bg-ground" aria-hidden="true" data-testid="compare-level">
          {bands.map((b) => (
            <rect key={b.i} x={xMs(b.fromMs)} width={Math.max(0, xMs(b.toMs) - xMs(b.fromMs))} y={0} height={LH} fill={lit === b.i ? "var(--accent-soft)" : "transparent"} />
          ))}
          <path d={envelopePath(aligned.model.level, xk, -1)} fill={modelColour} opacity={0.35} />
          <path d={envelopePath(aligned.mine.level, xk, 1)} fill={mineColour} opacity={0.45} />
          <line x1={0} x2={VW} y1={LH / 2} y2={LH / 2} stroke="var(--line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {bands.flatMap((b) => [b.fromMs, b.toMs]).map((ms, k) => (
            <line key={k} x1={xMs(ms)} x2={xMs(ms)} y1={0} y2={LH} stroke="var(--line-strong)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
          {!aligned.warped &&
            bands.flatMap((b) => (b.modelFromMs !== null && b.modelToMs !== null ? [b.modelFromMs, b.modelToMs] : [])).map((ms, k) => (
              <line key={`m${k}`} x1={xMs(ms)} x2={xMs(ms)} y1={0} y2={LH / 2} stroke={modelColour} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ))}
        </svg>
      )}
    </div>
  );
}

function Swatch({ colour, dashed = false, thick = 3 }: { colour: string; dashed?: boolean; thick?: number }) {
  return (
    <svg width="22" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" x2="21" y1="4" y2="4" stroke={colour} strokeWidth={thick} strokeDasharray={dashed ? "5 4" : undefined} strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------- view ---------------------------------- */

type ModelState = { step: "loading" } | { step: "done"; reply: PronunciationModelReply } | { step: "failed"; message: string };

export interface CompareViewProps {
  reply: PronunciationScoreReply;
  take: Blob;
  kids: boolean;
  source: CompareSource;
  onClose: () => void;
}

export function CompareView({ reply, take, kids, source, onClose }: CompareViewProps) {
  const mode = useRubyMode(reply.locale);
  const [model, setModel] = useState<ModelState>({ step: "loading" });
  const [warp, setWarp] = useState(true);
  const [picked, setPicked] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const sourceKey = source.kind === "sound" ? `s\u0001${source.text}\u0001${source.locale}` : `p\u0001${source.phraseId}`;
  // The model's clip for playback, fetched on the first press and kept.
  const clip = useRef<Promise<Blob> | null>(null);
  const player = useComparePlayer(take, () => (clip.current ??= modelClip(source).catch((e: unknown) => {
    clip.current = null;
    throw e;
  })));
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setModel({ step: "loading" });
    modelAnalysis(source, ctrl.signal).then(
      (r) => !ctrl.signal.aborted && setModel({ step: "done", reply: r }),
      (e: unknown) => !ctrl.signal.aborted && setModel({ step: "failed", message: errText(e) }),
    );
    return () => ctrl.abort();
    // The source's identity is its key: a new object for the same model is the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  useEffect(() => headingRef.current?.focus(), []);

  const frames = reply.frames!;
  // The model, when its analysis is in and lines up with the take (the
  // same characters, one by one); else the textbook shapes stand in.
  const modelInput: ModelInput | null = useMemo(() => {
    if (model.step !== "done" || !model.reply.available) return null;
    const m = model.reply;
    if (m.syllables.length !== reply.syllables.length || m.syllables.some((s, i) => s.char !== reply.syllables[i].char)) return null;
    return { frames: m.frames, syllables: m.syllables, durationMs: m.durationMs };
  }, [model, reply.syllables]);
  const aligned = useMemo(() => alignTakes({ mine: reply.syllables, frames, model: modelInput, warp: kids || warp }), [reply.syllables, frames, modelInput, warp, kids]);
  const label = (i: number) => {
    const s = reply.syllables[i];
    return { char: s.char, reading: mode === "off" ? "" : readingIn(mode, s.pinyin) };
  };
  const name = (i: number) => {
    const { char, reading } = label(i);
    return reading ? `${char} (${reading})` : char;
  };
  const tips: Tip[] = useMemo(
    () => (model.step === "loading" ? [] : compareTips({ mine: reply.syllables, frames, model: modelInput, kids, name })),
    // name() reads the aid mode only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model.step, reply.syllables, frames, modelInput, kids, mode],
  );
  const words = useMemo(() => describeTakes({ mine: reply.syllables, frames, model: modelInput }), [reply.syllables, frames, modelInput]);
  const lit = hovered ?? picked;
  const textbookOnly = reply.syllables.map((s, i) => ({ s, i })).filter(({ s, i }) => s.expectedTone !== 0 && !aligned.bands[i]?.real);
  const judged = reply.syllables.some((s) => s.verdict !== "unsure");
  const pickedSyl = picked !== null ? reply.syllables[picked] : null;
  const pickedModel = picked !== null ? modelInput?.syllables[picked] : null;
  const big = kids ? "px-3 py-1.5 text-base" : "px-2.5 py-1 text-sm";
  const PAD = 30;

  let modelNote = "";
  if (model.step === "loading") modelNote = kids ? "Getting the model ready…" : "Reading the model's pitch…";
  else if (model.step === "failed") modelNote = kids ? "" : `The model's pitch couldn't be read (${model.message}), so the textbook shapes stand in.`;
  else if (!model.reply.available) modelNote = kids ? "" : model.reply.why === "no_decoder" ? "This server can't decode the model's audio, so the textbook shapes stand in." : "The model's audio couldn't be read, so the textbook shapes stand in.";
  else if (!modelInput) modelNote = kids ? "" : "The model's clip doesn't line up with these characters, so the textbook shapes stand in.";

  let tipsEmpty = "";
  if (model.step !== "loading" && !tips.length) {
    // "Lovely!" only when every syllable was heard right; a take nothing was
    // sure about gets a neutral line, never praise it may not deserve.
    if (kids)
      tipsEmpty = reply.syllables.some((s) => s.verdict === "off")
        ? "Listen to the model, then try again!"
        : reply.syllables.every((s) => s.verdict === "ok")
          ? "Lovely! Listen to the model and say it again."
          : "Listen to the model and say it again.";
    else tipsEmpty = judged ? "No clear differences to point out." : "Nothing here was clear enough to compare. That's not a mistake: try again somewhere quiet.";
  }

  return (
    <section className={`flex flex-col gap-3 rounded-xl border border-line bg-panel p-3 ${kids ? "text-center" : ""}`} aria-labelledby="compare-heading" data-testid="compare-view">
      <div className="flex items-start justify-between gap-2">
        <h3 id="compare-heading" ref={headingRef} tabIndex={-1} className={`font-[family-name:var(--font-display)] font-semibold text-fg outline-none ${kids ? "w-full text-lg" : "text-base"}`}>
          {kids ? "You and the model" : "Your take against the model"}
        </h3>
        <Button variant="ghost" className="px-2 py-0.5 text-sm" onClick={onClose} aria-label="Close the comparison" data-testid="compare-close">
          ✕
        </Button>
      </div>

      <Picture aligned={aligned} reply={reply} kids={kids} lit={lit} picked={picked} onPick={(i) => setPicked((p) => (p === i ? null : i))} label={label} />

      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${fine} text-fg-2 ${kids ? "justify-center" : ""}`}>
        <span className="inline-flex items-center gap-1.5">
          <Swatch colour="var(--accent)" />
          {kids ? "you" : "your pitch"}
        </span>
        {modelInput && (
          <span className="inline-flex items-center gap-1.5">
            <Swatch colour="var(--fg-2)" thick={4} />
            {kids ? "the model" : "the model's pitch"}
          </span>
        )}
        {textbookOnly.length > 0 && model.step !== "loading" && (
          <span className="inline-flex items-center gap-1.5">
            <Swatch colour="var(--fg-3)" dashed />
            {kids ? "how it goes" : "textbook shape"}
          </span>
        )}
        {!kids && (
          <span>
            Below: loudness, the model above the line, yours beneath{aligned.warped ? "" : "; the model's syllables are the marks along the top"}.
          </span>
        )}
      </div>
      {!kids && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${fine} text-fg-3`}>
          <span data-testid="compare-axis">
            {aligned.warped
              ? "Aligned by syllable: the model is stretched to your timing, so each character lines up. Heights are each voice against its own middle."
              : "Real lengths: both start together, each at its own speed. Heights are each voice against its own middle."}
          </span>
          {modelInput && (
            <label className="inline-flex items-center gap-1.5 text-fg-2">
              <input type="checkbox" checked={!warp} onChange={(e) => setWarp(!e.target.checked)} data-testid="compare-real-lengths" />
              Real lengths
            </label>
          )}
        </div>
      )}
      {modelNote && (
        <p className={`${fine} text-fg-3`} role="status">
          {modelNote}
        </p>
      )}
      {!kids && modelInput && textbookOnly.length > 0 && (
        <p className={`${fine} text-fg-3`}>
          For {textbookOnly.map(({ i }) => reply.syllables[i].char).join(", ")}, the model's clip couldn't be read with confidence, so the dashed textbook shape stands in.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {tips.length > 0 && (
          <ol className="flex flex-col gap-1.5" aria-label={kids ? "Something to try" : "What to change"} data-testid="compare-tips">
            {tips.map((t) => (
              <li key={`${t.syllable}-${t.kind}`}>
                <button
                  type="button"
                  className={`w-full rounded-lg border px-3 py-2 text-left ${kids ? "border-kiai bg-kiai-soft text-center text-base" : "border-line bg-raised text-sm"} text-fg hover:border-accent focus-visible:border-accent ${lit === t.syllable ? "border-accent" : ""}`}
                  onMouseEnter={() => setHovered(t.syllable)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(t.syllable)}
                  onBlur={() => setHovered(null)}
                  onClick={() => setPicked(t.syllable)}
                  data-testid="compare-tip"
                  data-kind={t.kind}
                >
                  {t.text}
                </button>
              </li>
            ))}
          </ol>
        )}
        {tipsEmpty && <p className={`${kids ? "text-base" : "text-sm"} text-fg-2`} data-testid="compare-no-tips">{tipsEmpty}</p>}
      </div>

      <div className={`flex flex-wrap gap-2 ${kids ? "justify-center" : ""}`}>
        <Button className={big} onClick={() => (player.playing === "mine" ? player.stop() : void player.play("mine"))} aria-pressed={player.playing === "mine"} data-testid="compare-play-mine">
          ▶ {kids ? "Hear yourself" : "My take"}
        </Button>
        <Button className={big} onClick={() => (player.playing === "model" ? player.stop() : void player.play("model"))} aria-pressed={player.playing === "model"} data-testid="compare-play-model">
          🔊 {kids ? "Listen" : "Model"}
        </Button>
        <Button className={big} onClick={() => (player.playing === "both" ? player.stop() : void player.both())} aria-pressed={player.playing === "both"} data-testid="compare-play-both">
          ⇄ {kids ? "Both" : "Both in turn"}
        </Button>
        {!kids && pickedSyl && pickedSyl.startMs !== null && pickedSyl.endMs !== null && (
          <Button
            className={big}
            onClick={() => (player.playing === "loop-mine" ? player.stop() : void player.loop("mine", pickedSyl.startMs! - PAD, pickedSyl.endMs! + PAD))}
            aria-pressed={player.playing === "loop-mine"}
            data-testid="compare-loop-mine"
          >
            ⟳ Loop my {pickedSyl.char}
          </Button>
        )}
        {!kids && pickedModel && pickedModel.startMs !== null && pickedModel.endMs !== null && (
          <Button
            className={big}
            onClick={() => (player.playing === "loop-model" ? player.stop() : void player.loop("model", pickedModel.startMs! - PAD, pickedModel.endMs! + PAD))}
            aria-pressed={player.playing === "loop-model"}
            data-testid="compare-loop-model"
          >
            ⟳ Loop the model's {pickedModel.char}
          </Button>
        )}
        {player.playing && (
          <Button variant="ghost" className={big} onClick={player.stop} data-testid="compare-stop">
            ■ Stop
          </Button>
        )}
      </div>
      {!kids && picked === null && <p className={`${fine} text-fg-3`}>Pick a character above to loop it.</p>}
      {player.error && (
        <p className={`${fine} ${kids ? "text-fg-2" : "text-err"}`} role="status">
          Couldn't play it: {player.error}
        </p>
      )}

      {/* The picture in words: the tips are most of it; this is the rest. */}
      {kids ? (
        <ul className="sr-only">
          {words.map((w) => (
            <li key={w.syllable}>
              {reply.syllables[w.syllable].char}: yours {w.mine}; the model {w.model === "textbook shape" ? "is shown as its usual shape" : w.model}.
            </li>
          ))}
        </ul>
      ) : (
        <details className={`${fine} text-fg-2`}>
          <summary className="cursor-pointer text-fg-3">The picture in words</summary>
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="compare-words">
            {words.map((w) => (
              <li key={w.syllable}>
                {name(w.syllable)}: yours {w.mine}
                {w.mineMs !== null ? ` (${(w.mineMs / 1000).toFixed(2)} s)` : ""}; the model's {w.model}
                {w.modelMs !== null && modelInput ? ` (${(w.modelMs / 1000).toFixed(2)} s)` : ""}.
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
