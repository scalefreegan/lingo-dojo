import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { answerRound, fillPictures, gameStatus, pictureBlob, startGame, wordAudio } from "../gameApi";
import type { GameAnswerReply, GameRound, PictureStatus } from "../types";
import { RubyText } from "./Ruby";
import { Badge, Button, Card } from "./ui";

/* The picture game for an adult learner (bead ld-318; docs/DATA.md §Kids
 * word game, §The game): a mode of the Practice tab beside flashcards,
 * listening, speak-it and fill the gap (not part of Mixed). The same game
 * as a kid's (web/server/pictures.ts): hear a word, tap its picture among
 * 2-4, the server draws the round and checks the tap, and the tap is a
 * review of the word's listen card through the same answer path. What
 * differs is the presentation: Practice's look, a progress bar, the word
 * and its meaning after each tap (the server sends them to adults only),
 * Next instead of an automatic advance, and a count at the end. A kid
 * keeps stars and never sees a score (KidsGameView).
 *
 * Every round's sound and pictures are fetched before the first, as the
 * kids game does, so nothing loads mid-round. Fewer than three pictured
 * words: a plain explanation and, when words are waiting, Draw pictures
 * (the same trigger as the Phrase bank's; the counts' poll only reads). */

const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const POLL_MS = 5000;
/** The time a round was shown and answered (for the review's duration). */
const clock = () => Date.now();

interface Loaded {
  round: GameRound;
  audio: HTMLAudioElement;
  /** Picture id → blob URL. */
  urls: Map<string, string>;
}

type Phase =
  | { kind: "home" }
  | { kind: "loading" }
  | { kind: "round"; i: number; picked: string | null; reply: GameAnswerReply | null; error: string | null }
  | { kind: "done" };

/** One answered round, for the end's count. */
interface Answered {
  phraseId: string;
  right: boolean;
  text: string;
  meaning: string | null;
}

export default function PictureGameView({
  header,
  modePicker,
  locale,
  lang,
}: {
  /** Practice's heading, shown above the home card. */
  header: ReactNode;
  /** Practice's mode chips, inside the home card, so the mode can be changed back. */
  modePicker: ReactNode;
  locale: string | null;
  lang?: string;
}) {
  const [status, setStatus] = useState<PictureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "home" });
  const [game, setGame] = useState<Loaded[]>([]);
  const [done, setDone] = useState<Answered[]>([]);
  const [tick, setTick] = useState(0);
  const shownAt = useRef(0);
  const submitIds = useRef(new Map<string, string>());
  const made = useRef<{ urls: string[]; audio: HTMLAudioElement[] }>({ urls: [], audio: [] });

  const release = () => {
    for (const a of made.current.audio) a.pause();
    for (const u of made.current.urls) URL.revokeObjectURL(u);
    made.current = { urls: [], audio: [] };
  };
  useEffect(() => release, []);

  // The counts on the home screen, read again every few seconds while
  // pictures are being drawn (a read: it never starts a drawing).
  useEffect(() => {
    if (phase.kind !== "home") return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    gameStatus(ctrl.signal).then(
      (r) => {
        setStatus(r.status);
        if (r.status.drawing) timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [phase.kind, tick]);

  async function drawPictures() {
    setBusy(true);
    setError(null);
    try {
      setStatus((await fillPictures()).status);
      setTick((n) => n + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function play() {
    setError(null);
    setPhase({ kind: "loading" });
    release();
    try {
      const r = await startGame();
      setStatus(r.status);
      if (!r.rounds.length) {
        setError("No round could be made: there are fewer than 3 words with pictures right now.");
        return setPhase({ kind: "home" });
      }
      const out: (Loaded | null)[] = new Array(r.rounds.length).fill(null);
      const blobs = new Map<string, Promise<string>>();
      const picture = (id: string, file: string) => {
        if (!blobs.has(id)) {
          blobs.set(
            id,
            pictureBlob(id, file).then((b) => {
              const u = URL.createObjectURL(b);
              made.current.urls.push(u);
              return u;
            }),
          );
        }
        return blobs.get(id)!;
      };
      let next = 0;
      let failure: string | null = null;
      const worker = async () => {
        while (next < r.rounds.length) {
          const i = next++;
          const round = r.rounds[i];
          try {
            const [sound, ...urls] = await Promise.all([wordAudio(round.phraseId), ...round.choices.map((c) => picture(c.id, c.file))]);
            const u = URL.createObjectURL(sound);
            made.current.urls.push(u);
            const audio = new Audio(u);
            made.current.audio.push(audio);
            out[i] = { round, audio, urls: new Map(round.choices.map((c, k) => [c.id, urls[k]])) };
          } catch (e) {
            // A round whose word or pictures won't load is left out rather
            // than shown half; the reason is said if none is left.
            failure = errText(e);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      const loaded = out.filter((x): x is Loaded => !!x);
      if (!loaded.length) {
        setError(`The rounds couldn't be loaded${failure ? `: ${failure}` : ""}. ${r.status.audio ? `Words can't be played aloud: ${r.status.audio}` : "Check the voice settings on the Go tab, then try again."}`);
        return setPhase({ kind: "home" });
      }
      submitIds.current.clear();
      setGame(loaded);
      setDone([]);
      enter(0, loaded);
    } catch (e) {
      setError(errText(e));
      setPhase({ kind: "home" });
    }
  }

  function say(item: Loaded) {
    item.audio.currentTime = 0;
    item.audio.play().catch(() => {});
  }

  function enter(i: number, list = game) {
    if (i >= list.length) return setPhase({ kind: "done" });
    shownAt.current = clock();
    setPhase({ kind: "round", i, picked: null, reply: null, error: null });
    say(list[i]);
  }

  async function tap(pictureId: string) {
    if (phase.kind !== "round" || phase.picked) return;
    const i = phase.i;
    const r = game[i].round;
    setPhase({ ...phase, picked: pictureId, error: null });
    // One submit id per round: a resend replays the first answer.
    const submitId = submitIds.current.get(r.phraseId) ?? crypto.randomUUID();
    submitIds.current.set(r.phraseId, submitId);
    try {
      const reply = await answerRound({ phraseId: r.phraseId, version: r.version, revision: r.revision, submitId, pictureId, durationMs: clock() - shownAt.current });
      setPhase({ kind: "round", i, picked: pictureId, reply, error: null });
      setDone((d) => [...d.filter((x) => x.phraseId !== r.phraseId), { phraseId: r.phraseId, right: reply.right, text: reply.word?.text ?? "", meaning: reply.word?.meaning ?? null }]);
      if (!reply.right) say(game[i]);
    } catch (e) {
      // Stale (the word edited, the card practised elsewhere): nothing was
      // recorded; say so and let the round be skipped.
      setPhase({ kind: "round", i, picked: null, reply: null, error: errText(e) });
    }
  }

  if (phase.kind === "loading") {
    return (
      <div className="flex flex-col gap-3" data-testid="picture-game-loading">
        {header}
        <Card>
          <p className="text-sm text-fg-2" role="status">
            Getting the pictures and sounds ready…
          </p>
        </Card>
      </div>
    );
  }

  if (phase.kind === "done") {
    const right = done.filter((d) => d.right).length;
    const missed = done.filter((d) => !d.right);
    return (
      <div className="flex flex-col gap-3" data-testid="picture-game-summary">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Pictures done</h2>
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-fg-2" data-testid="picture-game-score">
            {right} of {done.length} picked right{done.length < game.length ? ` (${game.length - done.length} skipped)` : ""}.
          </p>
          {missed.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className={`${fine} text-fg-3`}>To hear again soon:</p>
              <ul className="flex flex-col gap-0.5 text-sm">
                {missed.map((d) => (
                  <li key={d.phraseId}>
                    <span className="font-medium text-fg" lang={lang}>
                      <RubyText text={d.text} locale={locale} />
                    </span>{" "}
                    {d.meaning && <span className="text-fg-2">· {d.meaning}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void play()}>
              Play again
            </Button>
            <Button onClick={() => setPhase({ kind: "home" })}>Done</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (phase.kind === "round") {
    const item = game[phase.i];
    const reply = phase.reply;
    const total = game.length;
    const last = phase.i + 1 === total;
    return (
      <div className="flex flex-col gap-3" data-testid="picture-game-round">
        <div className="flex items-center gap-3">
          <span className={`${fine} text-fg-3 tabular-nums`} data-testid="practice-progress">
            {phase.i + 1} / {total}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(phase.i / total) * 100}%` }} />
          </div>
          <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => setPhase({ kind: "done" })}>
            End
          </Button>
        </div>
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Pictures</Badge>
            <span className={`${fine} text-fg-3`}>Hear it, pick its picture</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-[family-name:var(--font-display)] text-xl font-semibold text-fg">Listen</p>
            <Button onClick={() => say(item)} data-testid="picture-game-replay">
              <SpeakerIcon /> {reply ? "Play again" : "Replay"}
            </Button>
          </div>
          <div role="group" aria-label="Pictures" className="mx-auto grid w-full max-w-md grid-cols-2 gap-3">
            {item.round.choices.map((c, k) => {
              const isRight = !!reply && reply.pictureId === c.id;
              const isPicked = phase.picked === c.id;
              const wrongPick = !!reply && isPicked && !reply.right;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`Picture ${k + 1}`}
                  data-testid="game-picture"
                  data-picture={c.id}
                  data-right={isRight ? "true" : undefined}
                  disabled={!!phase.picked}
                  onClick={() => void tap(c.id)}
                  className={`relative aspect-square overflow-hidden rounded-2xl border-2 bg-raised transition focus-visible:outline-3 focus-visible:outline-accent ${
                    isRight ? "border-accent ring-3 ring-accent-soft" : wrongPick ? "border-err" : "border-line hover:border-line-strong"
                  } ${reply && !isRight && !isPicked ? "opacity-40" : ""}`}
                >
                  <img src={item.urls.get(c.id)} alt="" className="size-full object-cover" draggable={false} />
                  {isRight && (
                    <span className="absolute top-1.5 right-1.5">
                      <Badge tone="accent">✓</Badge>
                    </span>
                  )}
                  {wrongPick && (
                    <span className="absolute top-1.5 right-1.5">
                      <Badge tone="err">✗</Badge>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {reply && (
            <div className="flex flex-col gap-2 border-t border-line pt-3" data-testid="picture-game-result">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={reply.right ? "accent" : "err"}>{reply.right ? "Correct" : "Not quite"}</Badge>
                {reply.word && (
                  <p className="text-lg font-semibold text-fg" lang={lang} data-testid="picture-game-word">
                    <RubyText text={reply.word.text} locale={locale} reading={reply.word.reading} />
                  </p>
                )}
                {reply.word?.meaning && <p className="text-sm text-fg-2">· {reply.word.meaning}</p>}
              </div>
              {!reply.right && <p className={`${fine} text-fg-3`}>The right picture is marked; it comes back soon.</p>}
              <div>
                <Button variant="primary" onClick={() => enter(phase.i + 1)} data-testid="picture-game-next">
                  {last ? "Finish" : "Next"}
                </Button>
              </div>
            </div>
          )}
          {phase.error && (
            <div className="flex flex-col gap-2 rounded-md bg-err-soft p-3 text-sm text-err" role="alert">
              <p>{phase.error}</p>
              <div>
                <Button onClick={() => enter(phase.i + 1)}>Skip this round</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    );
  }

  // Home: the counts and Start, or why there is no game yet.
  return (
    <div className="flex flex-col gap-3" data-testid="practice">
      {header}
      <Card className="flex flex-col gap-4">
        {status && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="picture-game-stats">
            <Stat label="Words with pictures" value={status.pictured} />
            <Stat label="Waiting for pictures" value={status.waiting} />
            <Stat label="Pictures today" value={`${status.imagesToday} / ${status.imagesCap}`} />
          </dl>
        )}
        {modePicker}
        {status && !status.ready && <NotReady status={status} busy={busy} onDraw={() => void drawPictures()} />}
        {status?.ready && status.audio && (
          <p className="rounded-md bg-warn-soft p-3 text-sm text-fg" role="status">
            Words can't be played aloud: {status.audio} The voice provider is chosen in the Go tab's voice settings.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void play()} disabled={!status?.ready || busy} data-testid="picture-game-start">
            Start
          </Button>
          {status?.ready && <span className={`${fine} text-fg-3`}>Up to 8 rounds from your {status.pictured} pictured words</span>}
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

/** Why there is no game yet, said plainly, with Draw pictures when words
 *  are waiting and nothing stands in the way. */
function NotReady({ status, busy, onDraw }: { status: PictureStatus; busy: boolean; onDraw: () => void }) {
  const lines: string[] = [`The picture game needs at least 3 words with pictures; ${status.pictured === 0 ? "none has one" : `${status.pictured} ${status.pictured === 1 ? "has" : "have"} one`} so far.`];
  if (status.problem) lines.push(status.problem);
  else if (status.drawing) lines.push("Pictures are being drawn now.");
  else if (status.limited) lines.push("Today's pictures for this language are drawn; more tomorrow.");
  else if (status.waiting > 0) lines.push(`${status.waiting} word${status.waiting === 1 ? " is" : "s are"} waiting for a picture. They are drawn after each session, or now with Draw pictures.`);
  else lines.push("Words come from your sessions and your phrase bank; each gets a picture when one fits (greetings and the like get none). Pictures are managed in the menu's Picture library.");
  const canDraw = status.waiting > 0 && !status.drawing && !status.problem && !status.limited;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-raised p-3 text-sm text-fg-2" role="status" data-testid="picture-game-not-ready">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {canDraw && (
        <div>
          <Button onClick={onDraw} disabled={busy} data-testid="picture-game-draw">
            Draw pictures
          </Button>
        </div>
      )}
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

const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
