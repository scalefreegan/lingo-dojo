import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { PronunciationWord, PronunciationWordsReply } from "../types";
import { Button } from "./ui";
import type { WordScoreState } from "./useWordScore";

/* Word marks on a recording of a known phrase, for languages beyond
 * Mandarin (ld-ne0.16; docs/VOICE.md §Words and sounds beyond Mandarin):
 * the word-level twin of ToneCheck.tsx. One mark per word as Azure heard
 * it, laid on the phrase as written: ok, off (Azure heard other sounds
 * there) or not sure, quiet as everywhere. A tap opens the word: what was
 * heard, the learner's own take of just that word (its span in the
 * recording, from Azure's timing) and the model phrase. No pitch picture
 * and no compare mode: a word has no tone shape to draw, and the compare
 * view is built on tones (docs/VOICE.md says why).
 *
 * Kids: no marks at all (the reply carries none), only a gentle "listen
 * and try again" when something was clearly off. Nothing is kept: the take
 * is the blob in this page's memory. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

function markClass(v: PronunciationWord["verdict"]): string {
  if (v === "ok") return "border-accent text-accent";
  if (v === "off") return "border-err bg-err-soft text-err";
  return "border-dotted border-fg-3 text-fg";
}

/** The line under the marks. */
function wordSummary(reply: PronunciationWordsReply, kids: boolean): string {
  if (kids) return reply.nudge ? "Let's listen and try that one again!" : "";
  const w = reply.words;
  const ok = w.filter((x) => x.verdict === "ok").length;
  const off = w.filter((x) => x.verdict === "off").length;
  const unsure = w.length - ok - off;
  if (!w.length || ok + off === 0) return "Couldn't tell this time. That's not a mistake: try again a little closer to the microphone, somewhere quiet.";
  return [`${ok} right`, off ? `${off} off` : "", unsure ? `${unsure} not sure` : ""].filter(Boolean).join(" · ");
}

function wordLine(w: PronunciationWord): string {
  if (w.verdict === "ok") return "Sounded right.";
  if (w.verdict === "off" && w.why === "missing") return "This word wasn't heard as itself: it may have been skipped, or said as another word. Listen to the model and try it again.";
  if (w.verdict === "off") return "This didn't sound like the word: other sounds were heard here. Listen to the model and try it again.";
  if (w.reason === "omitted") return "Not sure: this word wasn't heard.";
  return "Not sure: the check couldn't tell clearly here.";
}

/** The phrase as written, its words as buttons, the text between them
 *  (spaces, punctuation) as it stands. */
function segments(reply: PronunciationWordsReply): ({ text: string; word: null } | { text: string; word: PronunciationWord; i: number })[] {
  const out: ({ text: string; word: null } | { text: string; word: PronunciationWord; i: number })[] = [];
  let at = 0;
  reply.words.forEach((w, i) => {
    if (w.start < at || w.end > reply.text.length) return;
    if (w.start > at) out.push({ text: reply.text.slice(at, w.start), word: null });
    out.push({ text: reply.text.slice(w.start, w.end), word: w, i });
    at = w.end;
  });
  if (at < reply.text.length) out.push({ text: reply.text.slice(at), word: null });
  return out;
}

export interface WordCheckProps {
  reply: PronunciationWordsReply;
  /** The recording that was checked, for "Your word". */
  take: Blob | null;
  kids: boolean;
  onPlayModel?: () => void;
  modelBusy?: boolean;
  modelError?: string | null;
}

export function WordCheck({ reply, take, kids, onPlayModel, modelBusy = false, modelError = null }: WordCheckProps) {
  const [open, setOpen] = useState<number | null>(null);
  const player = useSpanPlayer(take);
  const summary = wordSummary(reply, kids);
  if (kids) {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="word-check">
        <p lang={reply.locale} className="text-center text-2xl">
          {reply.text}
        </p>
        {summary && (
          <p className="text-center text-base text-fg-2" data-testid="word-summary">
            <span aria-hidden="true">{summary}</span>
            {onPlayModel && (
              <Button className="ml-1 px-3 py-1 text-base" onClick={onPlayModel} disabled={modelBusy}>
                🔊 Listen
              </Button>
            )}
          </p>
        )}
      </div>
    );
  }
  const shown = open !== null ? reply.words[open] : null;
  return (
    <div className="flex flex-col gap-2" data-testid="word-check">
      <p lang={reply.locale} className="flex flex-wrap items-end text-xl leading-relaxed" role="group" aria-label="Word marks">
        {segments(reply).map((s, k) =>
          s.word ? (
            <button
              key={k}
              type="button"
              aria-label={`${s.text}: ${s.word.verdict === "ok" ? "sounded right" : s.word.verdict === "off" ? "didn't sound right" : "not sure"}`}
              aria-expanded={open === s.i}
              onClick={() => setOpen((o) => (o === s.i ? null : s.i))}
              className={`rounded-md border-b-4 px-0.5 hover:bg-raised ${markClass(s.word.verdict)} ${open === s.i ? "ring-2 ring-accent-soft" : ""}`}
              data-verdict={s.word.verdict}
              data-testid="word-mark"
            >
              {s.text}
            </button>
          ) : (
            <span key={k} className="whitespace-pre-wrap">
              {s.text}
            </span>
          ),
        )}
      </p>
      {summary && (
        <p className={`${fine} text-fg-2`} data-testid="word-summary">
          <span aria-hidden="true">{summary}</span>
        </p>
      )}
      <p className={`${fine} text-fg-3`}>Checked by Azure, word by word. Tap a word to hear yours against the model.</p>
      {shown && (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-3" data-testid="word-detail">
          <p className="text-sm text-fg">
            <span lang={reply.locale} className="mr-2 text-lg font-medium">
              {shown.text}
            </span>
            {wordLine(shown)}
          </p>
          {shown.sounds?.length ? <p className={`${fine} text-fg-2`}>Weakest sound{shown.sounds.length > 1 ? "s" : ""}: {shown.sounds.map((x) => x.name).join(", ")}</p> : null}
          {typeof shown.score === "number" && <p className={`${fine} text-fg-3`}>Azure's score for the word: {shown.score} of 100.</p>}
          <div className="flex flex-wrap gap-2">
            {take && typeof shown.startMs === "number" && typeof shown.endMs === "number" && (
              <Button className="px-2.5 py-1 text-sm" onClick={() => player.play(shown.startMs!, shown.endMs!)} aria-pressed={player.playing} data-testid="word-play-take">
                ▶ Your word
              </Button>
            )}
            {onPlayModel && (
              <Button className="px-2.5 py-1 text-sm" onClick={onPlayModel} disabled={modelBusy} data-testid="word-play-model">
                🔊 Model
              </Button>
            )}
          </div>
        </div>
      )}
      {(modelError || player.error) && (
        <p className={`${fine} text-err`} role="status">
          Couldn't play it: {modelError ?? player.error}
        </p>
      )}
    </div>
  );
}

/** Plays a stretch of the take (a word's span, with a little room each
 *  side so its edges aren't cut), decoded once from the blob in memory. */
function useSpanPlayer(take: Blob | null) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const decoded = useRef<{ take: Blob; buffer: AudioBuffer } | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  useEffect(
    () => () => {
      source.current?.stop();
      source.current = null;
      void ctx.current?.close();
      ctx.current = null;
      decoded.current = null;
    },
    [take],
  );
  async function play(startMs: number, endMs: number) {
    if (!take) return;
    setError(null);
    try {
      const audio = (ctx.current ??= new AudioContext());
      if (decoded.current?.take !== take) decoded.current = { take, buffer: await audio.decodeAudioData(await take.arrayBuffer()) };
      const buffer = decoded.current.buffer;
      source.current?.stop();
      const from = Math.max(0, startMs / 1000 - 0.08);
      const to = Math.min(buffer.duration, endMs / 1000 + 0.08);
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(audio.destination);
      node.onended = () => {
        if (source.current === node) {
          source.current = null;
          setPlaying(false);
        }
      };
      source.current = node;
      setPlaying(true);
      node.start(0, from, Math.max(0.05, to - from));
    } catch (e) {
      setPlaying(false);
      setError(errText(e));
    }
  }
  return { play: (a: number, b: number) => void play(a, b), playing, error };
}

/** The marks for a recording already made, or a quiet line while they
 *  come; one live region, as ToneScoreView has. */
export function WordScoreView({ state, kids, onPlayModel, modelBusy, modelError }: { state: WordScoreState; kids: boolean } & Omit<WordCheckProps, "reply" | "take" | "kids">) {
  const said =
    state.step === "scoring" ? (kids ? "Listening…" : "Checking the words…")
    : state.step === "failed" ? (kids ? "Couldn't listen that time. Try once more!" : `The words couldn't be checked: ${state.message}`)
    : state.step === "done" && state.reply ? wordSummary(state.reply, kids)
    : "";
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only" data-testid="word-status">
        {said}
      </p>
      <div aria-hidden={state.step !== "done" ? true : undefined}>
        {state.step === "scoring" && <p className={`${fine} text-fg-3`}>{said}</p>}
        {state.step === "failed" && <p className={kids ? "text-center text-base text-fg-2" : `${fine} text-fg-3`}>{said}</p>}
      </div>
      {state.step === "done" && state.reply && <WordCheck reply={state.reply} take={state.take} kids={kids} onPlayModel={onPlayModel} modelBusy={modelBusy} modelError={modelError} />}
    </>
  );
}
