import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api";
import { answerCard, overrideAnswer, practiceQueue, practiceStats } from "../practiceApi";
import type { PracticeAnswerReply, PracticeDirection, PracticeItem, PracticeRating, PracticeStatsReply, PracticeVerdict } from "../types";
import { Badge, Button, Card, inputClass } from "./ui";

/* Practice: flashcards over the active language's phrase bank (docs/DATA.md
 * §Practice modes). A session is 5, 10 or 20 cards from what is due and
 * what is new, within the day's limits (20 new, 100 reviews; the day turns
 * over at 4 a.m. here). Two directions: recognize (the words shown, type
 * what they mean, or Reveal and grade yourself) and produce (the meaning
 * shown, type the words). Every answer is graded by the server (a lenient
 * match, then a model check on a miss) and recorded at once; the grade can
 * be changed with Again / Hard / Good / Easy. The listening drill, cloze
 * and speak-it come later and will sit beside these as other modes. */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

const LENGTHS = [5, 10, 20] as const;
const PREFS_KEY = "lingo-dojo.practice.v1";

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
  direction: PracticeDirection;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return {
      length: LENGTHS.includes(raw?.length) ? raw.length : 10,
      direction: ["mixed", "recognize", "produce"].includes(raw?.direction) ? raw.direction : "mixed",
    };
  } catch {
    return { length: 10, direction: "mixed" };
  }
}

/** One answered card, for the session's summary. */
interface Done {
  item: PracticeItem;
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

  // The counts, whenever the start screen shows (and after a session).
  useEffect(() => {
    if (items) return;
    const ctrl = new AbortController();
    practiceStats(ctrl.signal).then(
      (r) => {
        setInfo(r);
        setError(null);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [items, reload]);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const r = await practiceQueue(prefs.length, prefs.direction);
      setInfo(r);
      if (!r.items.length) {
        setError("Nothing to practise right now in this direction: no card is due, and no new one is left for today.");
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

  if (items && index < items.length) {
    return (
      <Session
        key={`${items[index].phraseId}:${items[index].skill}:${index}`}
        item={items[index]}
        position={index + 1}
        total={items.length}
        languageName={languageName}
        nativeName={nativeName}
        onNext={(rating) => {
          if (rating) setDone((d) => [...d, { item: items[index], rating }]);
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
  return (
    <div className="flex flex-col gap-3" data-testid="practice">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Practice{languageName ? ` · ${languageName}` : ""}</h2>
        <span className={`${fine} text-fg-3`}>Flashcards from your phrase bank</span>
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
          <legend className={`${fine} mb-1 font-medium text-fg-2`}>How many cards</legend>
          <div role="group" aria-label="Session length" className="flex gap-1">
            {LENGTHS.map((n) => (
              <Chip key={n} on={prefs.length === n} onClick={() => setPrefs((p) => ({ ...p, length: n }))}>
                {n}
              </Chip>
            ))}
          </div>
        </fieldset>
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
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void start()} disabled={loading || !s}>
            {loading ? "Starting…" : "Start"}
          </Button>
          {s && (
            <span className={`${fine} text-fg-3`}>
              {s.ready === 0
                ? s.due + s.new === 0
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

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
    >
      {children}
    </button>
  );
}

/**
 * One card: the prompt, the answer box, then the grade. A recognize card
 * can be revealed instead (then the learner grades it); a produce card has
 * "I don't know" (an empty answer: Again). The grade buttons change a
 * recorded grade (an override); Next moves on.
 */
function Session({
  item,
  position,
  total,
  languageName,
  nativeName,
  onNext,
  onQuit,
}: {
  item: PracticeItem;
  position: number;
  total: number;
  languageName: string;
  nativeName: string;
  onNext: (rating: PracticeRating | null) => void;
  onQuit: () => void;
}) {
  const recognize = item.skill === "recognize";
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<PracticeAnswerReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the card appeared (the session keys Session by card, so this is
  // per card): the review's duration.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);
  // This answer's id: a resend of it (a double click, a retry after a lost
  // reply) is the same submit, and the server answers it with the review it
  // already recorded instead of a second one.
  const [submitId] = useState(() => crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null);
  // A Check that failed leaves the box enabled again: back into it.
  useEffect(() => {
    if (error && !result && !revealed) inputRef.current?.focus();
  }, [error, result, revealed]);

  async function submit(body: { answer?: string; reveal?: boolean; rating?: PracticeRating }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await answerCard({
        phraseId: item.phraseId, skill: item.skill, version: item.version, revision: item.revision, submitId, durationMs: Date.now() - shownAt.current, ...body,
      });
      setResult(r);
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

  function check(e: FormEvent) {
    e.preventDefault();
    void submit({ answer });
  }

  const prompt = recognize ? item.text : item.meaning;
  const ask = recognize ? `What does it mean in ${nativeName}?` : `Say it in ${languageName || "the language you're learning"}`;
  const verdict = result ? VERDICT[result.review.verdict] : null;

  return (
    <div className="flex flex-col gap-3" data-testid="practice-session">
      <div className="flex items-center gap-3">
        <span className={`${fine} text-fg-3 tabular-nums`} data-testid="practice-progress">
          {position} / {total}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${((position - 1) / total) * 100}%` }} />
        </div>
        <Button variant="ghost" className="px-2 py-1 text-sm" onClick={onQuit}>
          End
        </Button>
      </div>
      <Card className="flex flex-col gap-4" data-testid={`practice-card-${item.skill}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.kind === "new" ? "accent" : "neutral"}>{item.kind === "new" ? "New" : "Review"}</Badge>
          <span className={`${fine} text-fg-3`}>{recognize ? `${languageName || "Target"} → ${nativeName}` : `${nativeName} → ${languageName || "target"}`}</span>
          {item.starred && <span className={`${fine} text-fg-3`} aria-label="starred">★</span>}
        </div>
        <p className="font-[family-name:var(--font-display)] text-2xl font-semibold break-words text-fg sm:text-3xl" lang={recognize ? item.lang || undefined : undefined} data-testid="practice-prompt">
          {prompt}
        </p>

        {!result && !revealed && (
          <form onSubmit={check} className="flex flex-col gap-2">
            <label className={`${fine} text-fg-2`} htmlFor="practice-answer">
              {ask}
            </label>
            <input
              id="practice-answer"
              ref={inputRef}
              className={inputClass}
              value={answer}
              maxLength={300}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              lang={recognize ? undefined : item.lang || undefined}
              onChange={(e) => setAnswer(e.target.value)}
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={busy || !answer.trim()}>
                {busy ? "Checking…" : "Check"}
              </Button>
              {recognize ? (
                <Button onClick={() => setRevealed(true)} disabled={busy}>
                  Reveal
                </Button>
              ) : (
                <Button onClick={() => void submit({ answer: "" })} disabled={busy}>
                  I don't know
                </Button>
              )}
            </div>
          </form>
        )}

        {revealed && !result && (
          <div className="flex flex-col gap-3">
            <p className="text-lg text-fg" data-testid="practice-expected">
              {item.meaning}
            </p>
            <p className={`${fine} text-fg-2`}>How well did you know it?</p>
            <RatingRow current={null} busy={busy} focusFirst onPick={(r) => void submit({ reveal: true, rating: r })} />
          </div>
        )}

        {result && verdict && (
          <div className="flex flex-col gap-3" data-testid="practice-result">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={verdict.tone}>{verdict.label}</Badge>
              {result.review.answer && <span className="text-sm text-fg-2">You wrote: “{result.review.answer}”</span>}
            </div>
            {result.review.note && <p className="text-sm text-fg-2" data-testid="practice-note">{result.review.note}</p>}
            <div className="rounded-xl bg-raised px-3 py-2">
              <p className="text-lg font-medium text-fg" lang={item.lang || undefined}>
                {result.expected.text}
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
              <RatingRow current={result.review.rating} busy={busy} onPick={(r) => void regrade(r)} />
            </div>
            <div>
              {/* Focused when the grade arrives, so Enter moves on. */}
              <Button autoFocus variant="primary" onClick={() => onNext(result.review.rating)} disabled={busy}>
                {position === total ? "Finish" : "Next"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-2 rounded-md bg-err-soft p-3 text-sm text-err" role="alert">
            <p>{error}</p>
            <div>
              {/* Only before an answer is recorded: after one (a failed
                  override), Next keeps it in the summary. */}
              {!result && <Button onClick={() => onNext(null)}>Skip this card</Button>}
            </div>
          </div>
        )}
      </Card>
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

function Summary({ done, onAgain, onClose, busy, error }: { done: Done[]; onAgain: () => void; onClose: () => void; busy: boolean; error: string | null }) {
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
                <li key={`${d.item.phraseId}:${d.item.skill}`}>
                  <span className="font-medium text-fg" lang={d.item.lang || undefined}>
                    {d.item.text}
                  </span>{" "}
                  <span className="text-fg-2">· {d.item.meaning}</span>
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
