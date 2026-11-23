import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { CompareSource } from "../pronunciationApi";
import { startRecording, type Recording } from "../recorder";
import { useRubyMode } from "../script/ruby.tsx";
import { readingIn } from "../script/script.ts";
import type { PronunciationScoreReply, PronunciationSyllable } from "../types";
import { CompareView } from "./CompareView";
import { Button } from "./ui";
import { useToneScore, type ScoreState } from "./useToneScore";
import { useWordScore } from "./useWordScore";
import { WordScoreView } from "./WordCheck";

/* Tone marks on a recording that was meant to be known text (stage 1 of
 * pronunciation feedback, docs/VOICE.md §Pronunciation in the app): one
 * mark per character, ok / off / not sure, and a tap opens the picture of
 * that syllable, the tone's textbook shape against the pitch that was
 * heard, with the learner's own take and the model sound to play. Shared
 * by Practice's speak-it, the character card's "say it" (SayItCheck,
 * below) and, later, repeat-after-me drills.
 *
 * The engine flags only when confident; "not sure" is quiet (a dotted
 * underline in the text colour), never a mistake. Kids mode is always
 * gentle: no score, no red, nothing at all on "not sure", and on a clear
 * miss a nudge to listen and try again.
 *
 * Nothing is kept: the take lives in this page's memory as the blob that
 * was sent, and goes with the component. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

const TONE_NAMES: Record<number, string> = { 0: "neutral", 1: "high and level", 2: "rising", 3: "low, dipping", 4: "falling" };
const KID_SHAPES: Record<number, string> = { 1: "stays up high, like a long beep", 2: "goes up, like asking a question", 3: "dips down low and comes back up", 4: "goes down, like a slide" };

/** Why a syllable is "not sure", in words a learner can use. */
function unsureWhy(reason: string | undefined): string {
  switch (reason) {
    case "neutral":
      return "a neutral (light) tone: not checked";
    case "short":
      return "too short to read the tone";
    case "unvoiced":
      return "no voice was heard in it";
    case "creaky":
      return "the voice went creaky, so the pitch couldn't be read";
    case "clipped":
      return "the recording started in the middle of it";
    case "omitted":
      return "it wasn't heard";
    case "soft":
      return "too quiet to read";
    case "every_tone":
      return "this character has readings in every tone, so on its own any tone could be right";
    case "live_bar":
      // A conversation turn's miss below the live bar (pronunciation-live.mjs
      // liveReply): there was something, but not enough to say so.
      return "possibly a slip, but not certain enough to flag in conversation";
    default:
      return "the recording wasn't clear enough here to tell";
  }
}

/** The colour of a mark. Adults: accent for ok, the error colour for a
 *  confident miss, a dotted text-coloured underline for not sure. Kids:
 *  never red; a miss is warm, not sure is plain. */
function markClass(v: PronunciationSyllable["verdict"], kids: boolean): string {
  if (v === "ok") return "border-accent text-accent";
  if (v === "off") return kids ? "border-kiai bg-kiai-soft text-fg" : "border-err bg-err-soft text-err";
  return kids ? "border-transparent text-fg" : "border-dotted border-fg-3 text-fg";
}

export interface ToneCheckProps {
  reply: PronunciationScoreReply;
  /** The recording that was scored, for "Your take". */
  take: Blob | null;
  kids: boolean;
  /** Plays the model sound (the narrator's voice through the existing
   *  sound or phrase-audio routes); absent: no model button. */
  onPlayModel?: () => void;
  modelBusy?: boolean;
  modelError?: string | null;
  /** Where the model comes from, for compare mode (CompareView): absent,
   *  no Compare control. */
  compare?: CompareSource;
}

/** The line under the marks. Kids: a nudge on a clear miss (whether the
 *  pitch or, from Azure, the sound), praise when something was right,
 *  nothing else. */
function toneSummary(reply: PronunciationScoreReply, kids: boolean): string {
  const syl = reply.syllables;
  const ok = syl.filter((s) => s.verdict === "ok").length;
  const off = syl.filter((s) => s.verdict === "off").length;
  const unsure = syl.length - ok - off;
  // The card's character said in another of its readings: say so, so a
  // learner aiming at the usual one isn't just told "right".
  const other = syl.length === 1 && syl[0].verdict === "ok" ? syl[0].usual : undefined;
  // Every syllable withheld because the sound didn't line up with the words
  // (extra voice before or after them): a closer microphone won't help.
  const misplaced = syl.length > 0 && syl.every((s) => s.reason === "edges");
  if (misplaced) return kids ? "Let's try again. Just say the words, nothing before or after!" : "The sound didn't line up with the words this time. Try again, saying just the phrase with nothing before or after it.";
  if (kids) return off ? "Let's listen and try that one again!" : other ? `That's another way to say ${syl[0].char}. Listen for the usual one!` : ok ? "Lovely tones!" : "";
  if (other) return `That's ${syl[0].pinyin}, another reading of ${syl[0].char} (usually ${other}).`;
  if (syl.length === 1 && syl[0].reason === "every_tone") return `${syl[0].char} has readings in every tone, so its tone can't be checked on its own.`;
  if (ok + off === 0) return "Couldn't tell the tones this time. That's not a mistake: try again a little closer to the microphone, somewhere quiet.";
  // Counts side by side, never "1 of 1 right" beside a syllable left out of the count.
  return [`${ok} right`, off ? `${off} off` : "", unsure ? `${unsure} not sure` : ""].filter(Boolean).join(" · ");
}

export function ToneCheck({ reply, take, kids, onPlayModel, modelBusy = false, modelError = null, compare }: ToneCheckProps) {
  const mode = useRubyMode(reply.locale);
  const [open, setOpen] = useState<number | null>(null);
  // Compare mode, opened from the result; a new take closes it.
  const [comparedReply, setComparedReply] = useState<PronunciationScoreReply | null>(null);
  const comparing = comparedReply === reply;
  const setComparing = (on: boolean) => setComparedReply(on ? reply : null);
  // Closing the comparison puts focus back on the button that opened it.
  const compareWrap = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (comparing || !refocus.current) return;
    refocus.current = false;
    compareWrap.current?.querySelector("button")?.focus();
  }, [comparing]);
  const canCompare = !!compare && !!take && !!reply.frames && reply.syllables.some((s) => s.startMs !== null);
  const takePlayer = useTakePlayer(take);
  const syl = reply.syllables;
  const off = syl.filter((s) => s.verdict === "off").length;
  const shown = open !== null ? syl[open] : null;
  const summary = toneSummary(reply, kids);

  return (
    <div className="flex flex-col gap-2" data-testid="tone-check">
      {reply.retry === "clipped" && (
        <p className={`${fine} text-fg-2`} role="status">
          {kids ? "Oops, I missed the start! Press the button first, then talk." : "The recording started mid-word: press record first, then speak."}
        </p>
      )}
      <div className={`flex flex-wrap items-end gap-1 ${kids ? "justify-center" : ""}`} role="group" aria-label="Tone marks">
        {syl.map((s, i) => {
          const reading = mode === "off" ? null : readingIn(mode, s.pinyin);
          const label = `${s.char}${s.pinyin ? ` (${s.pinyin})` : ""}: ${s.verdict === "ok" ? (s.usual ? `another reading (usually ${s.usual})` : "tone right") : s.verdict === "off" ? (kids ? "let's try again" : s.why === "sound" ? "the sound seemed off" : `heard tone ${s.heardTone ?? "?"}, expected tone ${s.expectedTone}`) : "not sure"}`;
          const face = (
            <span className="flex flex-col items-center leading-tight">
              {reading && <span className="text-sm text-fg-3 sm:text-xs">{reading}</span>}
              <span lang={reply.locale} className={kids ? "text-4xl" : "text-2xl"}>
                {s.char}
              </span>
            </span>
          );
          // Kids: "not sure" shows nothing, not even a button.
          if (kids && s.verdict === "unsure") {
            return (
              <span key={i} className="rounded-lg border-b-4 border-transparent px-1.5 py-0.5" data-verdict="unsure">
                {face}
              </span>
            );
          }
          return (
            <button
              key={i}
              type="button"
              aria-label={label}
              title={label}
              aria-expanded={open === i}
              onClick={() => setOpen((o) => (o === i ? null : i))}
              className={`rounded-lg border-b-4 px-1.5 py-0.5 hover:bg-raised ${markClass(s.verdict, kids)} ${open === i ? "ring-2 ring-accent-soft" : ""}`}
              data-verdict={s.verdict}
              data-testid="tone-mark"
            >
              {face}
            </button>
          );
        })}
      </div>
      {summary && (
        <p className={`${kids ? "text-center text-base" : fine} text-fg-2`} data-testid="tone-summary">
          {/* Read out by ToneScoreView's live region. */}
          <span aria-hidden="true">{summary}</span>
          {kids && off > 0 && onPlayModel && (
            <>
              {" "}
              <Button className="ml-1 px-3 py-1 text-base" onClick={onPlayModel} disabled={modelBusy}>
                🔊 Listen
              </Button>
            </>
          )}
        </p>
      )}
      {!kids && (
        <p className={`${fine} text-fg-3`}>
          {reply.engine === "azure" ? "Checked with Azure's timings and this Mac's pitch reader." : "Checked on this Mac."} Tap a character to see its tone{canCompare ? ", or compare the whole take with the model" : ""}.
        </p>
      )}
      {shown && !comparing && <TonePicture s={shown} kids={kids} mode={mode} take={take ? takePlayer : null} onPlayModel={onPlayModel} modelBusy={modelBusy} />}
      {canCompare && !comparing && (
        <div ref={compareWrap} className={kids ? "flex justify-center" : ""}>
          <Button className={kids ? "px-3 py-1.5 text-base" : "px-2.5 py-1 text-sm"} onClick={() => setComparing(true)} data-testid="tone-compare">
            {kids ? "👀 You and the model" : "⇄ Compare with the model"}
          </Button>
        </div>
      )}
      {canCompare && comparing && (
        <CompareView
          reply={reply}
          take={take!}
          kids={kids}
          source={compare!}
          onClose={() => {
            refocus.current = true;
            setComparing(false);
          }}
        />
      )}
      {(modelError || takePlayer.error) && (
        <p className={`${fine} ${kids ? "text-fg-2" : "text-err"}`} role="status">
          Couldn't play it: {modelError ?? takePlayer.error}
        </p>
      )}
    </div>
  );
}

/** The learner's own take, played from the blob in memory. */
function useTakePlayer(take: Blob | null) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const stop = () => {
    if (!el.current) return;
    el.current.audio.pause();
    URL.revokeObjectURL(el.current.url);
    el.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, [take]);
  function play() {
    if (!take) return;
    stop();
    setError(null);
    const url = URL.createObjectURL(take);
    const audio = new Audio(url);
    const mine = { audio, url };
    el.current = mine;
    audio.onended = () => {
      if (el.current === mine) stop();
    };
    setPlaying(true);
    audio.play().catch((e: unknown) => {
      if (el.current === mine) stop();
      setError(errText(e));
    });
  }
  return { play, playing, error };
}

type TakePlayer = ReturnType<typeof useTakePlayer>;

/* The picture: the tone's textbook shape (dashed) and the pitch heard
 * (solid), both in semitones about their own middle, so only the shapes
 * are compared: how high a voice sits is its own. */
const W = 200;
const H = 90;
const RANGE = 8;
const y = (st: number) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, st)) / RANGE) * (H / 2 - 6);
const x = (i: number, n: number) => 8 + (i / Math.max(1, n - 1)) * (W - 16);

/** An SVG path over the points, broken at the nulls (unvoiced frames). */
function pathOf(points: (number | null)[]): string {
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p === null || !Number.isFinite(p)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i, points.length).toFixed(1)} ${y(p).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

function TonePicture({ s, kids, mode, take, onPlayModel, modelBusy }: { s: PronunciationSyllable; kids: boolean; mode: ReturnType<typeof useRubyMode>; take: TakePlayer | null; onPlayModel?: () => void; modelBusy: boolean }) {
  const reading = mode === "off" ? "" : readingIn(mode, s.pinyin);
  const heardColour = s.verdict === "off" ? (kids ? "var(--kiai)" : "var(--err)") : s.verdict === "ok" ? "var(--accent)" : "var(--fg-2)";
  const heardPath = pathOf(s.heard);
  const refPath = s.reference ? pathOf(s.reference) : "";
  let line: string;
  // Kids hear the shape to aim for and nothing about what went wrong: a
  // miss on the sound itself (Azure's `why: "sound"`) reads the same.
  if (kids) line = s.expectedTone >= 1 && s.expectedTone <= 4 ? `This one ${KID_SHAPES[s.expectedTone]}.` : "";
  else if (s.verdict === "off") line = s.why === "sound" ? "The tone may be fine; the sound itself seemed off." : `Expected tone ${s.expectedTone} (${TONE_NAMES[s.expectedTone]}); it sounded like tone ${s.heardTone} (${TONE_NAMES[s.heardTone ?? 0] ?? "?"}).`;
  else if (s.verdict === "ok" && s.usual) line = `That's ${s.pinyin}, tone ${s.expectedTone} (${TONE_NAMES[s.expectedTone]}): another reading of ${s.char}. Its usual reading is ${s.usual}.`;
  else if (s.verdict === "ok") line = `Tone ${s.expectedTone} (${TONE_NAMES[s.expectedTone]}): sounded right.`;
  else line = `Not sure: ${unsureWhy(s.reason)}.`;
  const label = `${s.char}: the tone's shape${s.heard.length ? " and the pitch heard" : ""}`;
  return (
    <div className={`flex flex-col gap-2 rounded-xl border border-line bg-raised p-3 ${kids ? "items-center text-center" : ""}`} data-testid="tone-picture">
      <p className={`${kids ? "text-base" : "text-sm"} text-fg`}>
        <span lang="zh" className="mr-1 text-lg font-medium">
          {s.char}
        </span>
        {reading && <span className="mr-2 text-fg-2">{reading}</span>}
        {line}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-sm" role="img" aria-label={label}>
        <line x1="8" x2={W - 8} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeWidth="1" />
        {refPath && <path d={refPath} fill="none" stroke="var(--fg-3)" strokeWidth="3" strokeDasharray="6 5" strokeLinecap="round" strokeLinejoin="round" />}
        {heardPath && <path d={heardPath} fill="none" stroke={heardColour} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${fine} text-fg-2`}>
        {refPath && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="1" x2="21" y1="3" y2="3" stroke="var(--fg-3)" strokeWidth="3" strokeDasharray="5 4" />
            </svg>
            {kids ? "how it goes" : `tone ${s.expectedTone}, as in the textbook`}
          </span>
        )}
        {heardPath ? (
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="1" x2="21" y1="3" y2="3" stroke={heardColour} strokeWidth="3.5" />
            </svg>
            {kids ? "how you said it" : "what was heard"}
          </span>
        ) : (
          <span>{kids ? "" : "No pitch could be read here."}</span>
        )}
      </div>
      {!kids && <p className={`${fine} text-fg-3`}>Shapes only: how high a voice starts is its own.</p>}
      <div className="flex flex-wrap gap-2">
        {take && (
          <Button className={kids ? "px-3 py-1.5 text-base" : "px-2.5 py-1 text-sm"} onClick={take.play} aria-pressed={take.playing} data-testid="tone-play-take">
            ▶ {kids ? "Hear yourself" : "Your take"}
          </Button>
        )}
        {onPlayModel && (
          <Button className={kids ? "px-3 py-1.5 text-base" : "px-2.5 py-1 text-sm"} onClick={onPlayModel} disabled={modelBusy} data-testid="tone-play-model">
            🔊 {kids ? "Listen" : "Model"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The marks for a recording already made, or a quiet line while they come. */
export function ToneScoreView({ state, kids, onPlayModel, modelBusy, modelError, compare }: { state: ScoreState; kids: boolean } & Omit<ToneCheckProps, "reply" | "take" | "kids">) {
  // One live region, mounted before anything changes in it, so a screen
  // reader hears "Checking the tones…" and then the summary; what is drawn
  // below is the same words, hidden from it so they aren't read twice.
  const said =
    state.step === "scoring" ? (kids ? "Listening to your tones…" : "Checking the tones…")
    : state.step === "failed" ? (kids ? "Couldn't listen that time. Try once more!" : `The tones couldn't be checked: ${state.message}`)
    : state.step === "done" && state.reply ? toneSummary(state.reply, kids)
    : "";
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only" data-testid="tone-status">
        {said}
      </p>
      <div aria-hidden={state.step !== "done" ? true : undefined}>
        {state.step === "scoring" && <p className={`${fine} text-fg-3`}>{said}</p>}
        {state.step === "failed" && <p className={kids ? "text-center text-base text-fg-2" : `${fine} text-fg-3`}>{said}</p>}
      </div>
      {state.step === "done" && state.reply && <ToneCheck reply={state.reply} take={state.take} kids={kids} onPlayModel={onPlayModel} modelBusy={modelBusy} modelError={modelError} compare={compare} />}
    </>
  );
}

/** Why the microphone couldn't start, briefly. */
function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked for this page. Allow it in the browser's site settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  return `The microphone couldn't start (${errText(e)}).`;
}

type SayState = { step: "idle" } | { step: "opening" } | { step: "recording"; level: number } | { step: "reading" };

/**
 * Say `text` and see its tones (the character card): Record, stop by hand
 * or after a short pause, then the marks. Recording again replaces them.
 * Keyed on the text by its caller, so another character starts afresh.
 * `words`: a phrase in a language beyond Mandarin (the Phrase bank's
 * card, ld-ne0.16): word marks (WordCheck.tsx) instead of tones, recorded
 * as a voice turn is (the microphone's processing on: only the words are
 * judged, and no pitch is read).
 */
export function SayItCheck({ text, kids, onPlayModel, modelBusy, modelError, compare, words = false }: { text: string; kids: boolean; words?: boolean } & Omit<ToneCheckProps, "reply" | "take" | "kids">) {
  const [say, setSay] = useState<SayState>({ step: "idle" });
  const [take, setTake] = useState<Blob | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const gen = useRef(0);
  // The card's one character: judged against every reading it lists
  // (readings=all), which Practice never asks for.
  const score = useToneScore(take, text, !words, [...text].length === 1);
  const wordScore = useWordScore(take, text, words);
  const check = words ? wordScore : score;
  useEffect(
    () => () => {
      gen.current++;
      rec.current?.cancel();
      rec.current = null;
    },
    [],
  );

  async function start() {
    if (rec.current || say.step === "opening") return;
    setProblem(null);
    const mine = ++gen.current;
    setSay({ step: "opening" });
    try {
      const r = await startRecording({
        processing: words ? "conversation" : "pitch",
        silenceMs: words ? 1200 : 1000,
        maxMs: words ? 15000 : 8000,
        idleMs: 6000,
        onLevel: (level) => setSay((s) => (s.step === "recording" ? { step: "recording", level } : s)),
        onAutoStop: () => {
          if (rec.current === r) void stop();
        },
      });
      if (mine !== gen.current) return r.cancel();
      rec.current = r;
      setSay({ step: "recording", level: 0 });
    } catch (e) {
      if (mine !== gen.current) return;
      setProblem(micProblem(e));
      setSay({ step: "idle" });
    }
  }

  async function stop() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    const mine = gen.current;
    setSay({ step: "reading" });
    try {
      const { wav } = await r.stop();
      if (mine !== gen.current) return;
      if (!wav) setProblem(kids ? "I didn't hear anything. Try again!" : "Nothing was recorded. Press the button, say it, then stop.");
      else setTake(wav);
    } catch (e) {
      if (mine === gen.current) setProblem(`The recording couldn't be read (${errText(e)}).`);
    }
    if (mine === gen.current) setSay({ step: "idle" });
  }

  // The server doesn't score this language: no control at all.
  if (check.step === "done" && !check.reply) return null;
  const big = kids ? "px-4 py-2 text-base" : "px-2.5 py-1 text-sm";
  return (
    <div className={`flex flex-col gap-2 ${kids ? "items-center" : "items-start"}`} data-testid="say-it-check">
      <div className="flex flex-wrap items-center gap-2">
        {say.step === "recording" ? (
          <Button variant="primary" className={big} onClick={() => void stop()} data-testid="say-it-record">
            ■ {kids ? "Done" : "Stop"}
          </Button>
        ) : (
          <Button variant="primary" className={big} onClick={() => void start()} disabled={say.step !== "idle" || check.step === "scoring"} data-testid="say-it-record">
            {say.step === "opening" ? "Starting the microphone…" : say.step === "reading" ? "Listening…" : kids ? "🎤 Your turn to say it" : take ? "🎙 Say it again" : words ? "🎙 Say it, check it" : "🎙 Say it, check the tone"}
          </Button>
        )}
        {say.step === "recording" && (
          <div className="h-2 w-24 overflow-hidden rounded-full bg-ground" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${Math.round(say.level * 100)}%` }} />
          </div>
        )}
      </div>
      {problem && (
        <p className="text-sm text-fg-2" role="status">
          {problem}
        </p>
      )}
      <div className="w-full">
        {words ? <WordScoreView state={wordScore} kids={kids} onPlayModel={onPlayModel} modelBusy={modelBusy} modelError={modelError} /> : <ToneScoreView state={score} kids={kids} onPlayModel={onPlayModel} modelBusy={modelBusy} modelError={modelError} compare={compare} />}
      </div>
    </div>
  );
}
