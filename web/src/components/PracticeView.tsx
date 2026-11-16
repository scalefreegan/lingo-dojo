import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api";
import { answerCard, flagCloze, overrideAnswer, phraseAudio, practiceQueue, practiceStats, transcribeAnswer } from "../practiceApi";
import { startRecording, type Recording } from "../recorder";
import type {
  PracticeAnswerReply, PracticeAnswerRequest, PracticeDirection, PracticeItem, PracticeMode, PracticeRating, PracticeStatsReply, PracticeVerdict,
} from "../types";
import { RubyText, RubyToggle } from "./Ruby";
import { Badge, Button, Card, inputClass } from "./ui";

/* Practice over the active language's phrase bank (docs/DATA.md §Practice
 * modes). A session is 5, 10 or 20 cards from what is due and what is new,
 * within the day's limits (20 new, 100 reviews; the day turns over at
 * 4 a.m. here). Four modes:
 *  - Flashcards: recognize (the words shown, type what they mean, or
 *    Reveal and grade yourself) and produce (the meaning shown, type the
 *    words), both ways or one.
 *  - Listening: the phrase is played in your voice for the language, never
 *    shown; pick its meaning from four (or type the meaning or the words).
 *    The words, and their readings for Mandarin, appear only after.
 *  - Speak it: the meaning shown, say the words; what the recogniser heard
 *    is shown before it is checked, so a mishearing can be recorded again.
 *  - Fill the gap (cloze): a sentence with the phrase left out (from your
 *    own sessions when one fits, else written for practice) and its
 *    meaning as the hint; type or say the missing words. The gap shows no
 *    length, and its words travel only with the grade. A bad sentence can
 *    be flagged: it is never shown again.
 *  - Mixed: recognize as a flashcard, listen by ear, produce aloud (or,
 *    for a phrase with a sentence, every other time as a gap).
 * Every answer is graded by the server (a lenient match, then a model check
 * on a miss; a picked choice at once) and recorded; the grade can be
 * changed with Again / Hard / Good / Easy. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

const LENGTHS = [5, 10, 20] as const;
const PREFS_KEY = "lingo-dojo.practice.v1";
const MODES: { value: PracticeMode; label: string; hint: string }[] = [
  { value: "flashcards", label: "Flashcards", hint: "Read and type, either way" },
  { value: "listening", label: "Listening", hint: "Hear it, pick or type what it means" },
  { value: "speak", label: "Speak it", hint: "See the meaning, say it aloud" },
  { value: "cloze", label: "Fill the gap", hint: "A sentence with the phrase missing: type or say it" },
  { value: "mixed", label: "Mixed", hint: "A bit of everything" },
];

const RATINGS: { value: PracticeRating; label: string; hint: string }[] = [
  { value: 1, label: "Again", hint: "Didn't know it: see it again soon" },
  { value: 2, label: "Hard", hint: "Got it, with effort" },
  { value: 3, label: "Good", hint: "Got it" },
  { value: 4, label: "Easy", hint: "Knew it at once: wait longer" },
];

const VERDICT: Record<PracticeVerdict, { label: string; tone: "accent" | "warn" | "err" | "neutral" }> = {
  exact: { label: "Correct", tone: "accent" },
  close: { label: "Almost", tone: "warn" },
  accepted: { label: "Accepted", tone: "accent" },
  wrong: { label: "Not quite", tone: "err" },
  self: { label: "Your grade", tone: "neutral" },
};

interface Prefs {
  length: number;
  mode: PracticeMode;
  direction: PracticeDirection;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return {
      length: LENGTHS.includes(raw?.length) ? raw.length : 10,
      mode: MODES.some((m) => m.value === raw?.mode) ? raw.mode : "flashcards",
      direction: ["mixed", "recognize", "produce"].includes(raw?.direction) ? raw.direction : "mixed",
    };
  } catch {
    return { length: 10, mode: "flashcards", direction: "mixed" };
  }
}

/** One answered card, for the session's summary: the words and meaning
 *  from the answer's reply (a listening card's item carries neither). */
interface Done {
  key: string;
  text: string;
  meaning: string;
  lang: string;
  rating: PracticeRating;
}

export default function PracticeView() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [info, setInfo] = useState<PracticeStatsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The running session: its cards, where it is, what was answered.
  const [items, setItems] = useState<PracticeItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* blocked storage: the defaults next time */
    }
  }, [prefs]);

  // The counts, whenever the start screen shows (and after a session), for
  // the mode picked: a phrase with several cards due counts once.
  useEffect(() => {
    if (items) return;
    const ctrl = new AbortController();
    practiceStats(prefs.mode, prefs.direction, ctrl.signal).then(
      (r) => {
        setInfo(r);
        setError(null);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [items, reload, prefs.mode, prefs.direction]);

  // Sentences being written for the gap drill: ask again shortly, so the
  // counts (and Start) catch up when they are in.
  const writing = !items && !!info?.cloze?.writing;
  useEffect(() => {
    if (!writing) return;
    const t = setTimeout(() => setReload((n) => n + 1), 4000);
    return () => clearTimeout(t);
  }, [writing, info]);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const r = await practiceQueue(prefs.length, prefs.mode, prefs.direction);
      // The queue doesn't check the voice setup: keep what the counts said.
      setInfo((was) => ({ ...r, setup: r.setup ?? was?.setup ?? null }));
      if (!r.items.length) {
        setError("Nothing to practise right now in this mode: no card is due, and no new one is left for today.");
        return;
      }
      setItems(r.items);
      setIndex(0);
      setDone([]);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  const languageName = info ? info.language.targetVariant || info.language.targetLanguage : "";
  const nativeName = info?.language.nativeLanguage || "English";
  // The profile's locale, as the phrase bank uses: it picks the reading
  // aids (pinyin/zhuyin for Mandarin) and their remembered setting.
  const locale = info?.language.locale ?? null;

  if (items && index < items.length) {
    const item = items[index];
    return (
      <Session
        key={`${item.phraseId}:${item.skill}:${index}`}
        item={item}
        position={index + 1}
        total={items.length}
        languageName={languageName}
        nativeName={nativeName}
        locale={locale}
        speechProblem={info?.setup?.speech ?? null}
        onNext={(answered) => {
          if (answered) {
            setDone((d) => [...d, { key: `${item.phraseId}:${item.skill}`, text: answered.expected.text, meaning: answered.expected.meaning, lang: item.lang, rating: answered.review.rating }]);
          }
          setIndex((i) => i + 1);
        }}
        onQuit={() => {
          setItems(null);
          setReload((n) => n + 1);
        }}
      />
    );
  }

  if (items) {
    return (
      <Summary
        done={done}
        locale={locale}
        onAgain={() => void start()}
        onClose={() => {
          setItems(null);
          setReload((n) => n + 1);
        }}
        busy={loading}
        error={error}
      />
    );
  }

  const s = info?.stats;
  // What the mode needs that this setup can't give, said before a session
  // rather than card by card. Listening or speak-it alone can't start;
  // mixed can (its flashcards still work, and a card that can't be played
  // can be skipped).
  const setup = info?.setup;
  const needsAudio = prefs.mode === "listening" || prefs.mode === "mixed";
  const needsSpeech = prefs.mode === "speak" || prefs.mode === "mixed";
  const setupProblems = [
    ...(needsAudio && setup?.audio ? [`Listening can't play phrases: ${setup.audio.replace(/\.\s*$/, "")}.`] : []),
    ...(needsSpeech && setup?.speech ? [`Speak-it can't hear answers: ${setup.speech.replace(/\.\s*$/, "")}.`] : []),
  ];
  const blocked = (prefs.mode === "listening" && !!setup?.audio) || (prefs.mode === "speak" && !!setup?.speech);
  return (
    <div className="flex flex-col gap-3" data-testid="practice">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Practice{languageName ? ` · ${languageName}` : ""}</h2>
        <span className={`${fine} text-fg-3`}>Drills from your phrase bank</span>
        <RubyToggle locale={locale} className="ml-auto" />
      </div>
      <Card className="flex flex-col gap-4">
        {s ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="practice-stats">
            <Stat label="Due now" value={s.due} />
            <Stat label="New to learn" value={s.new} />
            <Stat label="New today" value={`${s.done.new} / ${s.limits.new}`} />
            <Stat label="Reviews today" value={`${s.done.reviews} / ${s.limits.reviews}`} />
          </dl>
        ) : (
          !error && <p className="text-sm text-fg-3">Loading…</p>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${fine} mb-1 font-medium text-fg-2`}>Mode</legend>
          <div role="group" aria-label="Mode" className="flex flex-wrap gap-1">
            {MODES.map((m) => (
              <Chip key={m.value} on={prefs.mode === m.value} title={m.hint} onClick={() => setPrefs((p) => ({ ...p, mode: m.value }))}>
                {m.label}
              </Chip>
            ))}
          </div>
          <p className={`${fine} text-fg-3`}>{MODES.find((m) => m.value === prefs.mode)?.hint}</p>
          {prefs.mode === "cloze" && info?.cloze && info.cloze.waiting > 0 && (
            <p className={`${fine} text-fg-2`} role="status" data-testid="practice-cloze-waiting">
              {info.cloze.writing
                ? `Writing practice sentences for ${info.cloze.waiting} more phrase${info.cloze.waiting === 1 ? "" : "s"}…`
                : `${info.cloze.waiting} phrase${info.cloze.waiting === 1 ? " has" : "s have"} no sentence yet; they are written when you start (or come back in a moment).`}
            </p>
          )}
          {setupProblems.length > 0 && (
            <div className="rounded-md bg-warn-soft p-3 text-sm text-fg" role="status" data-testid="practice-setup">
              {setupProblems.map((p) => (
                <p key={p}>{p}</p>
              ))}
              <p className={`${fine} mt-1 text-fg-2`}>Voices and speech-to-text are set in the Go tab's voice settings.</p>
            </div>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${fine} mb-1 font-medium text-fg-2`}>How many cards</legend>
          <div role="group" aria-label="Session length" className="flex gap-1">
            {LENGTHS.map((n) => (
              <Chip key={n} on={prefs.length === n} onClick={() => setPrefs((p) => ({ ...p, length: n }))}>
                {n}
              </Chip>
            ))}
          </div>
        </fieldset>
        {prefs.mode === "flashcards" && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className={`${fine} mb-1 font-medium text-fg-2`}>Which way</legend>
            <div role="group" aria-label="Direction" className="flex flex-wrap gap-1">
              <Chip on={prefs.direction === "mixed"} onClick={() => setPrefs((p) => ({ ...p, direction: "mixed" }))}>
                Both ways
              </Chip>
              <Chip on={prefs.direction === "recognize"} onClick={() => setPrefs((p) => ({ ...p, direction: "recognize" }))}>
                {languageName || "Target"} → {nativeName}
              </Chip>
              <Chip on={prefs.direction === "produce"} onClick={() => setPrefs((p) => ({ ...p, direction: "produce" }))}>
                {nativeName} → {languageName || "target"}
              </Chip>
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void start()} disabled={loading || !s || blocked}>
            {loading ? "Starting…" : "Start"}
          </Button>
          {s && (
            <span className={`${fine} text-fg-3`}>
              {s.ready === 0
                ? prefs.mode === "cloze" && (info?.cloze?.waiting ?? 0) > 0
                  ? "No sentence is ready yet."
                  : s.due + s.new === 0
                  ? "Your bank has nothing to practise yet: words from your sessions, and phrases you star or add, show up here."
                  : s.due > 0
                    ? "Today's limit is reached. The day's limits reset at 4 a.m."
                    : s.left.new === 0
                      ? "Nothing is due right now, and today's new cards are done (more after 4 a.m.). Cards you missed come back within minutes."
                      : "Nothing is due right now."
                : `${s.ready} card${s.ready === 1 ? "" : "s"} ready`}
            </span>
          )}
        </div>
        {error && (
          <p className="rounded-md bg-err-soft p-3 text-sm text-err" role="alert">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <dt className={`${fine} text-fg-3`}>{label}</dt>
      <dd className="font-[family-name:var(--font-display)] text-xl font-semibold text-fg tabular-nums">{value}</dd>
    </div>
  );
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
    >
      {children}
    </button>
  );
}

/* --------------------------------- one card -------------------------------- */

type SubmitBody = Pick<PracticeAnswerRequest, "answer" | "choice" | "reveal" | "rating" | "drill" | "spoken">;

/**
 * One card's answer: its submit id (a resend of it, a double click or a
 * retry after a lost reply, is the same submit, and the server answers it
 * with the review it already recorded), the time it was shown, the grade
 * and an override. The session keys each card, so this is per card.
 */
function useAnswer(item: PracticeItem) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PracticeAnswerReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);
  const [submitId] = useState(() => crypto.randomUUID());

  async function submit(body: SubmitBody) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await answerCard({
          phraseId: item.phraseId, skill: item.skill, drill: item.drill, version: item.version, revision: item.revision, submitId,
          // A cloze answer names the sentence it was shown.
          ...(item.drill === "cloze" && item.cloze && (body.drill ?? item.drill) === "cloze" ? { clozeId: item.cloze.id } : {}),
          durationMs: Date.now() - shownAt.current, ...body,
        }),
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function regrade(rating: PracticeRating) {
    if (!result || busy || rating === result.review.rating) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await overrideAnswer(result.review.id, rating));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return { busy, result, error, setError, submit, regrade };
}

type Answer = ReturnType<typeof useAnswer>;

interface CardProps {
  item: PracticeItem;
  languageName: string;
  nativeName: string;
  locale: string | null;
  /** Why answers can't be said aloud here (no speech-to-text key), or null. */
  speechProblem: string | null;
  answer: Answer;
  last: boolean;
  onNext: (answered: PracticeAnswerReply | null) => void;
}

/** The session's frame (progress, End) around the card of its drill. */
function Session({
  item,
  position,
  total,
  onQuit,
  ...rest
}: Omit<CardProps, "answer" | "last"> & { position: number; total: number; onQuit: () => void }) {
  const answer = useAnswer(item);
  const props: CardProps = { item, answer, last: position === total, ...rest };
  return (
    <div className="flex flex-col gap-3" data-testid="practice-session">
      <div className="flex items-center gap-3">
        <span className={`${fine} text-fg-3 tabular-nums`} data-testid="practice-progress">
          {position} / {total}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${((position - 1) / total) * 100}%` }} />
        </div>
        <RubyToggle locale={rest.locale} />
        <Button variant="ghost" className="px-2 py-1 text-sm" onClick={onQuit}>
          End
        </Button>
      </div>
      <Card className="flex flex-col gap-4" data-testid={`practice-card-${item.drill === "flashcard" ? item.skill : item.drill}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.kind === "new" ? "accent" : "neutral"}>{item.kind === "new" ? "New" : "Review"}</Badge>
          <span className={`${fine} text-fg-3`}>{drillLabel(item, rest.languageName, rest.nativeName)}</span>
          {item.starred && <span className={`${fine} text-fg-3`} aria-label="starred">★</span>}
        </div>
        {item.drill === "listening" ? (
          <ListeningCard {...props} />
        ) : item.drill === "speak" ? (
          <SpeakCard {...props} />
        ) : item.drill === "cloze" ? (
          <ClozeCard {...props} />
        ) : (
          <FlashCard {...props} />
        )}
        {answer.error && (
          <div className="flex flex-col gap-2 rounded-md bg-err-soft p-3 text-sm text-err" role="alert">
            <p>{answer.error}</p>
            <div>
              {/* Only before an answer is recorded: after one (a failed
                  override), Next keeps it in the summary. */}
              {!answer.result && <Button onClick={() => rest.onNext(null)}>Skip this card</Button>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function drillLabel(item: PracticeItem, languageName: string, nativeName: string): string {
  const target = languageName || "Target";
  if (item.drill === "listening") return `Listening · ${target} → ${nativeName}`;
  if (item.drill === "speak") return `Speak it · ${nativeName} → ${target}`;
  if (item.drill === "cloze") return `Fill the gap · ${item.cloze?.origin === "example" ? "from one of your sessions" : target}`;
  return item.skill === "recognize" ? `${target} → ${nativeName}` : `${nativeName} → ${target}`;
}

/** The typed answer box: Check, and the drill's other way out. */
function TypedAnswer({
  label,
  lang,
  busy,
  onCheck,
  children,
}: {
  label: string;
  lang?: string;
  busy: boolean;
  onCheck: (answer: string) => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function check(e: FormEvent) {
    e.preventDefault();
    onCheck(value);
  }
  return (
    <form onSubmit={check} className="flex flex-col gap-2">
      <label className={`${fine} text-fg-2`} htmlFor="practice-answer">
        {label}
      </label>
      <input
        id="practice-answer"
        ref={inputRef}
        className={inputClass}
        value={value}
        maxLength={300}
        autoFocus
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        lang={lang}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Check"}
        </Button>
        {children}
      </div>
    </form>
  );
}

/**
 * A flashcard: the prompt, the answer box, then the grade. A recognize
 * card can be revealed instead (then the learner grades it); a produce
 * card has "I don't know" (an empty answer: Again).
 */
function FlashCard({ item, languageName, nativeName, locale, answer, last, onNext }: CardProps) {
  const recognize = item.skill === "recognize";
  const [revealed, setRevealed] = useState(false);
  const { busy, result } = answer;
  // Readings go over the target words only where they are already shown:
  // a recognize card's prompt and the answer once it is out. A produce
  // card's prompt is the meaning, so nothing there gives the answer away.
  const prompt = recognize ? <RubyText text={item.text} locale={locale} /> : item.meaning;
  return (
    <>
      <p className="font-[family-name:var(--font-display)] text-2xl font-semibold break-words text-fg sm:text-3xl" lang={recognize ? item.lang || undefined : undefined} data-testid="practice-prompt">
        {prompt}
      </p>
      {!result && !revealed && (
        <TypedAnswer
          label={recognize ? `What does it mean in ${nativeName}?` : `Say it in ${languageName || "the language you're learning"}`}
          lang={recognize ? undefined : item.lang || undefined}
          busy={busy}
          onCheck={(a) => void answer.submit({ answer: a })}
        >
          {recognize ? (
            <Button onClick={() => setRevealed(true)} disabled={busy}>
              Reveal
            </Button>
          ) : (
            <Button onClick={() => void answer.submit({ answer: "" })} disabled={busy}>
              I don't know
            </Button>
          )}
        </TypedAnswer>
      )}
      {revealed && !result && (
        <div className="flex flex-col gap-3">
          <p className="text-lg text-fg" data-testid="practice-expected">
            {item.meaning}
          </p>
          <p className={`${fine} text-fg-2`}>How well did you know it?</p>
          <RatingRow current={null} busy={busy} focusFirst onPick={(r) => void answer.submit({ reveal: true, rating: r })} />
        </div>
      )}
      {result && <Result result={result} item={item} locale={locale} answer={answer} last={last} onNext={onNext} />}
    </>
  );
}

/**
 * Plays a phrase from /api/practice/audio (cached by the server, so the
 * replay and the next session cost nothing). Fetched once per card; the
 * first play starts by itself when the browser lets it.
 */
function usePhraseAudio(phraseId: string) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    let made: string | null = null;
    let el: HTMLAudioElement | null = null;
    phraseAudio(phraseId, ctrl.signal).then(
      ({ blob }) => {
        // The card went while the audio came: nothing to play, no URL to leak.
        if (ctrl.signal.aborted) return;
        made = URL.createObjectURL(blob);
        el = new Audio(made);
        el.onplay = () => setPlaying(true);
        el.onended = el.onpause = () => setPlaying(false);
        audioRef.current = el;
        setReady(true);
        // The first play; a browser that wants a gesture first leaves it
        // to the Replay button.
        el.play().catch(() => setPlaying(false));
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => {
      ctrl.abort();
      el?.pause();
      if (made) URL.revokeObjectURL(made);
    };
  }, [phraseId]);
  function play() {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = 0;
    a.play().catch(() => setPlaying(false));
  }
  return { ready, error, playing, play };
}

function PlayButton({ audio, label }: { audio: ReturnType<typeof usePhraseAudio>; label: string }) {
  return (
    <Button onClick={audio.play} disabled={!audio.ready} aria-label={label} data-testid="practice-play">
      <span aria-hidden="true">{audio.playing ? "🔊" : "▶"}</span> {audio.ready ? label : audio.error ? "No audio" : "Loading audio…"}
    </Button>
  );
}

/**
 * The listening drill: the phrase is heard, never shown; the learner picks
 * its meaning from the choices (or types the meaning, or the words). The
 * words and their readings appear with the grade.
 */
function ListeningCard({ item, nativeName, locale, answer, last, onNext }: CardProps) {
  const audio = usePhraseAudio(item.phraseId);
  const [typing, setTyping] = useState(!item.choices);
  const { busy, result } = answer;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-[family-name:var(--font-display)] text-xl font-semibold text-fg" data-testid="practice-prompt">
          Listen
        </p>
        <PlayButton audio={audio} label={result ? "Play again" : "Replay"} />
      </div>
      {audio.error && !result && (
        // Nothing heard is nothing to answer: no choices, no typing, no
        // "I don't know" (that would record a lapse). Skip records nothing.
        <div className="flex flex-col gap-2 rounded-md bg-err-soft p-3 text-sm text-err" role="alert" data-testid="practice-audio-error">
          <p>The phrase couldn't be played: {audio.error}</p>
          <p className="text-fg-2">Voices are set in the Go tab's voice settings. Nothing is recorded for this card.</p>
          <div>
            <Button onClick={() => onNext(null)} data-testid="practice-skip">
              Skip this card
            </Button>
          </div>
        </div>
      )}
      {!result && !audio.error && !typing && item.choices && (
        <div className="flex flex-col gap-2">
          <p className={`${fine} text-fg-2`}>What does it mean?</p>
          <div role="group" aria-label="Meanings" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="practice-choices">
            {item.choices.map((c) => (
              <Button key={c} className="justify-start text-left break-words whitespace-normal" disabled={busy || !audio.ready} onClick={() => void answer.submit({ choice: c })}>
                {c}
              </Button>
            ))}
          </div>
          <div>
            <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => setTyping(true)} disabled={busy}>
              Type it instead
            </Button>
          </div>
        </div>
      )}
      {!result && !audio.error && typing && (
        <TypedAnswer label={`What did you hear? Type what it means in ${nativeName}, or the words.`} busy={busy || !audio.ready} onCheck={(a) => void answer.submit({ answer: a })}>
          <Button onClick={() => void answer.submit({ answer: "" })} disabled={busy || !audio.ready}>
            I don't know
          </Button>
        </TypedAnswer>
      )}
      {result && <Result result={result} item={item} locale={locale} answer={answer} last={last} onNext={onNext} how={typing ? "wrote" : "picked"} />}
    </>
  );
}

type RecState =
  | { step: "idle" }
  | { step: "opening" }
  | { step: "recording"; rec: Recording; level: number }
  | { step: "hearing" }
  | { step: "heard"; text: string };

/** Why the microphone couldn't start, in words a learner can act on. */
function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked for this page. Allow it in the browser's site settings, or type your answer instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in, or type your answer instead.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can't record here (it needs https or localhost). Type your answer instead.";
  return `The microphone couldn't start (${errText(e)}). Type your answer instead.`;
}

/**
 * A spoken answer: record (stop on a pause or by hand), transcribe with no
 * hint of the expected answer, and hold what was heard until the card's
 * Check sends it. A blocked microphone, an empty recording or a failed
 * transcription is a `problem`, never an answer. Speak-it and a cloze said
 * aloud share it.
 */
function useSpokenAnswer(answer: Answer) {
  const [state, setState] = useState<RecState>({ step: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const recRef = useRef<Recording | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // Bumped when the card goes: anything awaited across it (the microphone
  // opening, a recording being read) sees it changed and lets go instead of
  // recording, or paying for a transcription, for a card no longer there.
  const genRef = useRef(0);
  // True while the microphone is opening (the permission prompt can be up):
  // a second Record then must not open a second one.
  const openingRef = useRef(false);
  // Leaving the card (Next, End, another tab) lets go of the microphone
  // and any transcription still running.
  useEffect(
    () => () => {
      genRef.current++;
      recRef.current?.cancel();
      recRef.current = null;
      ctrlRef.current?.abort();
    },
    [],
  );

  async function record() {
    if (recRef.current || openingRef.current) return;
    setProblem(null);
    answer.setError(null);
    const gen = genRef.current;
    openingRef.current = true;
    setState({ step: "opening" });
    let mine: Recording | null = null;
    try {
      mine = await startRecording({
        silenceMs: 1500,
        maxMs: 20_000,
        idleMs: 10_000,
        onLevel: (level) => setState((s) => (s.step === "recording" ? { ...s, level } : s)),
        // Only the recording that is current may end it.
        onAutoStop: () => {
          if (mine && recRef.current === mine) void stop();
        },
      });
      if (gen !== genRef.current) {
        // The card went while the microphone opened: close it at once.
        mine.cancel();
        return;
      }
      recRef.current = mine;
      setState({ step: "recording", rec: mine, level: 0 });
    } catch (e) {
      if (gen !== genRef.current) return;
      setProblem(micError(e));
      setState({ step: "idle" });
    } finally {
      openingRef.current = false;
    }
  }

  async function stop() {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    const gen = genRef.current;
    setState({ step: "hearing" });
    let wav: Blob | null;
    try {
      ({ wav } = await rec.stop());
    } catch (e) {
      if (gen !== genRef.current) return;
      setProblem(`The recording couldn't be read (${errText(e)}). Try again.`);
      setState({ step: "idle" });
      return;
    }
    // Gone while the recording was read: no transcription for it.
    if (gen !== genRef.current) return;
    if (!wav) {
      setProblem("Nothing was recorded. Press Record, say it, then stop.");
      setState({ step: "idle" });
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const { text } = await transcribeAnswer(wav, ctrl.signal);
      if (!text) {
        setProblem("Nothing was heard. Try again a little closer to the microphone.");
        setState({ step: "idle" });
      } else setState({ step: "heard", text });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setProblem(`Your answer couldn't be transcribed: ${errText(e)}. Nothing was recorded; try again or type it.`);
      setState({ step: "idle" });
    }
  }

  /** Back to nothing recorded (a recording going on is dropped). */
  function reset() {
    genRef.current++;
    recRef.current?.cancel();
    recRef.current = null;
    ctrlRef.current?.abort();
    setProblem(null);
    setState({ step: "idle" });
  }

  return { state, problem, record, stop, reset };
}

type Spoken = ReturnType<typeof useSpokenAnswer>;

/** Record / Stop with a level meter, and what was heard with Check and
 *  Record again. `extra` goes beside Record (the drill's other ways out). */
function SpokenControls({ spoken, busy, lang, onCheck, extra }: { spoken: Spoken; busy: boolean; lang?: string; onCheck: (heard: string) => void; extra?: ReactNode }) {
  const { state, problem } = spoken;
  return (
    <>
      {state.step === "heard" ? (
        <div className="flex flex-col gap-2" data-testid="practice-heard">
          <p className="rounded-xl bg-raised px-3 py-2 text-lg text-fg" lang={lang}>
            Heard: “{state.text}”
          </p>
          <div className="flex flex-wrap gap-2">
            <Button autoFocus variant="primary" disabled={busy} onClick={() => onCheck(state.text)}>
              {busy ? "Checking…" : "Check"}
            </Button>
            <Button disabled={busy} onClick={() => void spoken.record()}>
              Record again
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {state.step === "recording" ? (
            <Button variant="primary" onClick={() => void spoken.stop()} data-testid="practice-record">
              ■ Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void spoken.record()} disabled={state.step === "hearing" || state.step === "opening"} data-testid="practice-record">
              {state.step === "hearing" ? "Listening…" : state.step === "opening" ? "Starting the microphone…" : "● Record"}
            </Button>
          )}
          {state.step === "recording" && (
            <div className="h-2 w-24 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <div className="h-full bg-accent" style={{ width: `${Math.round(state.level * 100)}%` }} />
            </div>
          )}
          {extra}
        </div>
      )}
      {problem && (
        <p className="rounded-md bg-warn-soft p-3 text-sm text-fg" role="status" data-testid="practice-speak-problem">
          {problem}
        </p>
      )}
    </>
  );
}

/**
 * Speak-it: the meaning shown, the learner says the words. The recording
 * is transcribed (with no hint of the expected answer), what was heard is
 * shown, and only Check records it: a mishearing can be recorded again,
 * and a blocked microphone, an empty recording or a failed transcription
 * never becomes a review. "Type it instead" makes it a typed produce
 * flashcard.
 */
function SpeakCard({ item, languageName, locale, answer, last, onNext }: CardProps) {
  const spoken = useSpokenAnswer(answer);
  const [typing, setTyping] = useState(false);
  const { busy, result } = answer;
  const idle = spoken.state.step === "idle";
  const target = languageName || "the language you're learning";
  return (
    <>
      <p className="font-[family-name:var(--font-display)] text-2xl font-semibold break-words text-fg sm:text-3xl" data-testid="practice-prompt">
        {item.meaning}
      </p>
      {!result && !typing && (
        <div className="flex flex-col gap-2">
          <p className={`${fine} text-fg-2`}>Say it in {target}</p>
          <SpokenControls
            spoken={spoken}
            busy={busy}
            lang={item.lang || undefined}
            onCheck={(heard) => void answer.submit({ answer: heard })}
            extra={
              <>
                <Button variant="ghost" className="px-2 py-1 text-sm" disabled={!idle} onClick={() => setTyping(true)}>
                  Type it instead
                </Button>
                <Button variant="ghost" className="px-2 py-1 text-sm" disabled={!idle || busy} onClick={() => void answer.submit({ answer: "", drill: "flashcard" })}>
                  I don't know
                </Button>
              </>
            }
          />
        </div>
      )}
      {!result && typing && (
        // Typed, it is a produce flashcard: the review says so (mode flashcard).
        <TypedAnswer label={`Type it in ${target}`} lang={item.lang || undefined} busy={busy} onCheck={(a) => void answer.submit({ answer: a, drill: "flashcard" })} />
      )}
      {result && <Result result={result} item={item} locale={locale} answer={answer} last={last} onNext={onNext} how={typing ? "wrote" : "said"} />}
    </>
  );
}

/** The sentence around a gap: the context with its readings (Mandarin),
 *  the gap a fixed-width box that gives no length away (and no reading:
 *  it has no characters on the page to read). */
function GapSentence({ before, after, locale, lang, filled }: { before: string; after: string; locale: string | null; lang?: string; filled?: string }) {
  return (
    <p className="font-[family-name:var(--font-display)] text-2xl leading-relaxed font-semibold break-words text-fg sm:text-3xl" lang={lang} data-testid={filled ? "practice-cloze-filled" : "practice-prompt"}>
      <RubyText text={before} locale={locale} />
      {filled ? (
        <mark className="rounded bg-accent-soft px-1 text-accent">
          <RubyText text={filled} locale={locale} />
        </mark>
      ) : (
        <span className="mx-1 inline-block w-[4.5em] translate-y-1 border-b-2 border-fg-3 align-baseline" role="img" aria-label="the missing words" data-testid="practice-gap" />
      )}
      <RubyText text={after} locale={locale} />
    </p>
  );
}

/**
 * Fill the gap (cloze): a sentence with the phrase left out, its meaning
 * as the hint; the learner types the missing words, or says them (the
 * speak-it recorder and rules: a transcript, held until Check). Graded as
 * the phrase's words. A sentence that is wrong, unnatural or could take
 * other words just as well can be flagged: it is never shown again, and
 * the card is skipped with nothing recorded.
 */
function ClozeCard({ item, languageName, locale, speechProblem, answer, last, onNext }: CardProps) {
  const spoken = useSpokenAnswer(answer);
  const [saying, setSaying] = useState(false);
  const [flag, setFlag] = useState<"idle" | "busy" | "done">("idle");
  const [flagError, setFlagError] = useState<string | null>(null);
  const { busy, result } = answer;
  const cloze = item.cloze;
  const target = languageName || "the language you're learning";
  if (!cloze) return <p className="text-sm text-err">This card has no sentence: skip it.</p>;

  async function flagIt() {
    if (!cloze || flag !== "idle") return;
    setFlag("busy");
    setFlagError(null);
    try {
      await flagCloze(cloze.id);
      spoken.reset();
      setFlag("done");
    } catch (e) {
      setFlagError(errText(e));
      setFlag("idle");
    }
  }

  const flagRow = (
    <div className="flex flex-col gap-1">
      {flag === "done" ? (
        <p className={`${fine} text-fg-2`} role="status" data-testid="practice-cloze-flagged">
          Flagged: this sentence won't be shown again.
        </p>
      ) : (
        <div>
          <Button variant="ghost" className="px-2 py-1 text-sm" disabled={flag === "busy" || busy} onClick={() => void flagIt()} data-testid="practice-cloze-flag">
            {flag === "busy" ? "Flagging…" : "Bad sentence?"}
          </Button>
        </div>
      )}
      {flagError && (
        <p className="text-sm text-err" role="alert">
          {flagError}
        </p>
      )}
    </div>
  );

  return (
    <>
      {result?.cloze ? (
        <GapSentence before={result.cloze.before} after={result.cloze.after} filled={result.cloze.blank} locale={locale} lang={item.lang || undefined} />
      ) : (
        <GapSentence before={cloze.before} after={cloze.after} locale={locale} lang={item.lang || undefined} />
      )}
      <p className="text-sm text-fg-2" data-testid="practice-cloze-hint">
        <span className="text-fg-3">The missing words mean:</span> <span className="font-medium text-fg">{item.meaning}</span>
      </p>
      {!result && flag === "done" && (
        // Flagged before answering: nothing is recorded; the card is skipped.
        <>
          {flagRow}
          <div>
            <Button variant="primary" autoFocus onClick={() => onNext(null)} data-testid="practice-skip">
              {last ? "Finish" : "Next card"}
            </Button>
          </div>
        </>
      )}
      {!result && flag !== "done" && !saying && (
        <TypedAnswer label={`Fill the gap in ${target}`} lang={item.lang || undefined} busy={busy} onCheck={(a) => void answer.submit({ answer: a })}>
          <Button onClick={() => setSaying(true)} disabled={busy || !!speechProblem} title={speechProblem ?? undefined} data-testid="practice-cloze-say">
            Say it
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => void answer.submit({ answer: "" })} disabled={busy}>
            I don't know
          </Button>
        </TypedAnswer>
      )}
      {!result && flag !== "done" && saying && (
        <div className="flex flex-col gap-2">
          <p className={`${fine} text-fg-2`}>Say the missing words in {target}</p>
          <SpokenControls
            spoken={spoken}
            busy={busy}
            lang={item.lang || undefined}
            onCheck={(heard) => void answer.submit({ answer: heard, spoken: true })}
            extra={
              <Button
                variant="ghost"
                className="px-2 py-1 text-sm"
                disabled={spoken.state.step !== "idle"}
                onClick={() => {
                  spoken.reset();
                  setSaying(false);
                }}
              >
                Type it instead
              </Button>
            }
          />
        </div>
      )}
      {!result && flag !== "done" && flagRow}
      {result && <Result result={result} item={item} locale={locale} answer={answer} last={last} onNext={onNext} how={saying ? "said" : "wrote"} />}
      {result && flagRow}
    </>
  );
}

/** The grade: the verdict, what was answered, the card's two sides (with
 *  readings), and the override. */
function Result({
  result,
  item,
  locale,
  answer,
  last,
  onNext,
  how = "wrote",
}: {
  result: PracticeAnswerReply;
  item: PracticeItem;
  locale: string | null;
  answer: Answer;
  last: boolean;
  onNext: (answered: PracticeAnswerReply | null) => void;
  /** How the answer was given: typed, a picked choice, or said aloud. */
  how?: "wrote" | "picked" | "said";
}) {
  const verdict = VERDICT[result.review.verdict];
  const lead = how === "said" ? "Heard" : how === "picked" ? "You picked" : "You wrote";
  const said = result.review.answer ? `${lead}: “${result.review.answer}”` : null;
  return (
    <div className="flex flex-col gap-3" data-testid="practice-result">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        {said && <span className="text-sm text-fg-2">{said}</span>}
      </div>
      {result.review.note && <p className="text-sm text-fg-2" data-testid="practice-note">{result.review.note}</p>}
      <div className="rounded-xl bg-raised px-3 py-2" data-testid="practice-answer-shown">
        <p className="text-lg font-medium text-fg" lang={item.lang || undefined}>
          <RubyText text={result.expected.text} locale={locale} />
        </p>
        <p className="text-sm text-fg-2">{result.expected.meaning}</p>
      </div>
      {result.replayed && (
        <p className={`${fine} text-fg-3`} data-testid="practice-replayed">
          This answer was already recorded (it was sent twice); nothing new was saved.
        </p>
      )}
      {result.alternateAdded && <p className={`${fine} text-fg-3`}>Saved as another way to say it: next time it counts as exact.</p>}
      <div className="flex flex-col gap-1.5">
        <p className={`${fine} text-fg-3`}>Graded {RATINGS[result.review.rating - 1].label}. Disagree? Pick your own grade:</p>
        <RatingRow current={result.review.rating} busy={answer.busy} onPick={(r) => void answer.regrade(r)} />
      </div>
      <div>
        {/* Focused when the grade arrives, so Enter moves on. */}
        <Button autoFocus variant="primary" onClick={() => onNext(result)} disabled={answer.busy}>
          {last ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}

function RatingRow({ current, busy, onPick, focusFirst = false }: { current: PracticeRating | null; busy: boolean; onPick: (r: PracticeRating) => void; focusFirst?: boolean }) {
  return (
    <div role="group" aria-label="Grade" className="grid grid-cols-4 gap-1.5 sm:flex">
      {RATINGS.map((r) => (
        <Button
          key={r.value}
          autoFocus={focusFirst && r.value === 1}
          title={r.hint}
          aria-pressed={current === r.value}
          variant={current === r.value ? "primary" : "secondary"}
          className="justify-center"
          disabled={busy}
          onClick={() => onPick(r.value)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  );
}

function Summary({ done, locale, onAgain, onClose, busy, error }: { done: Done[]; locale: string | null; onAgain: () => void; onClose: () => void; busy: boolean; error: string | null }) {
  const by = (n: PracticeRating) => done.filter((d) => d.rating === n).length;
  const missed = done.filter((d) => d.rating === 1);
  return (
    <div className="flex flex-col gap-3" data-testid="practice-summary">
      <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Session done</h2>
      <Card className="flex flex-col gap-3">
        <p className="text-sm text-fg-2">
          {done.length} card{done.length === 1 ? "" : "s"} practised: {RATINGS.map((r) => `${by(r.value)} ${r.label}`).join(" · ")}
        </p>
        {missed.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className={`${fine} text-fg-3`}>To see again soon:</p>
            <ul className="flex flex-col gap-0.5 text-sm">
              {missed.map((d) => (
                <li key={d.key}>
                  <span className="font-medium text-fg" lang={d.lang || undefined}>
                    <RubyText text={d.text} locale={locale} />
                  </span>{" "}
                  <span className="text-fg-2">· {d.meaning}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onAgain} disabled={busy}>
            {busy ? "Starting…" : "Practice more"}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
        {error && <p className="text-sm text-fg-3">{error}</p>}
      </Card>
    </div>
  );
}
