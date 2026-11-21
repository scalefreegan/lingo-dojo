import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { answerRound, gameStatus, pictureBlob, startGame, wordAudio } from "../gameApi";
import type { GameRound, PictureStatus } from "../types";
import { Mochi } from "./Mascots";

/* The kids word game (docs/DATA.md §Kids word game): the Practice tab of a
 * kids learner, and all of it. The child hears a word in the language they
 * are learning and taps the matching picture. Usable without reading: big
 * icons and pictures, everything said aloud, no text the child must read.
 * A right tap is a cheer and a star; a wrong one is gentle: the right
 * picture is shown and the word played again, nothing counted against
 * them. Each tap is recorded quietly as a review of the word's listen card
 * (the server grades it, never the page). About eight rounds, then a
 * celebration.
 *
 * Smooth rounds: a game is built from ready pictures only, and before the
 * first round every round's picture and word are fetched (the audio is
 * cached on the server; a miss there is a paid TTS call, made here in the
 * opening step rather than mid-round), behind one short friendly wait.
 * Nothing loads between rounds.
 *
 * The small grey lines are for the grown-up (why there is no game yet, a
 * missing key); a child never needs them. This page never starts picture
 * drawing except by starting a game (a top-up the game never waits for);
 * the grown-up's controls (draw the backlog, remove, redraw) are in the
 * Library's Phrase bank, out of a child's way. Animations honour
 * prefers-reduced-motion. */

const POLL_MS = 5000;
/** How long a cheer shows before the next round. */
const CHEER_MS = 1400;

interface Loaded {
  round: GameRound;
  audio: HTMLAudioElement;
  /** Picture id → blob URL. */
  urls: Map<string, string>;
}

type Phase =
  | { kind: "home" }
  | { kind: "loading" }
  | { kind: "round"; i: number; picked: string | null; right: string | null; result: "right" | "wrong" | null }
  | { kind: "done" };

/** The time a round was shown and answered (for the review's duration). */
const clock = () => Date.now();
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

export default function KidsGameView() {
  const [status, setStatus] = useState<PictureStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "home" });
  const [game, setGame] = useState<Loaded[]>([]);
  const [stars, setStars] = useState(0);
  const shownAt = useRef(0);
  const submitIds = useRef(new Map<string, string>());
  // Blob URLs and audio made for the game in hand, released when it goes.
  const made = useRef<{ urls: string[]; audio: HTMLAudioElement[] }>({ urls: [], audio: [] });

  const release = () => {
    for (const a of made.current.audio) a.pause();
    for (const u of made.current.urls) URL.revokeObjectURL(u);
    made.current = { urls: [], audio: [] };
  };
  useEffect(() => release, []);

  // The status, and again every few seconds while pictures are drawn (a
  // read of counts: it never starts a drawing).
  useEffect(() => {
    if (phase.kind !== "home") return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      gameStatus(ctrl.signal).then(
        (r) => {
          setStatus(r.status);
          if (r.status.drawing) timer = setTimeout(load, POLL_MS);
        },
        (e) => {
          if (!ctrl.signal.aborted) setNote(errText(e));
        },
      );
    void load();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [phase.kind]);

  async function play() {
    setNote(null);
    setPhase({ kind: "loading" });
    release();
    try {
      const r = await startGame();
      setStatus(r.status);
      if (!r.rounds.length) return setPhase({ kind: "home" });
      // Every round's picture and word up front, two at a time; a round
      // whose word or picture won't load is left out rather than shown half.
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
            console.warn("word game: a round couldn't be loaded:", errText(e));
          }
        }
      };
      await Promise.all([worker(), worker()]);
      const loaded = out.filter((x): x is Loaded => !!x);
      if (!loaded.length) {
        setNote("For grown-ups: the words couldn't be loaded. Check the voice settings, then try again.");
        return setPhase({ kind: "home" });
      }
      submitIds.current.clear();
      setGame(loaded);
      setStars(0);
      enter(0, loaded);
    } catch (e) {
      setNote(`For grown-ups: ${errText(e)}`);
      setPhase({ kind: "home" });
    }
  }

  function say(item: Loaded) {
    item.audio.currentTime = 0;
    item.audio.play().catch(() => {});
  }

  function enter(i: number, list = game) {
    if (i >= list.length) {
      setPhase({ kind: "done" });
      return;
    }
    shownAt.current = clock();
    setPhase({ kind: "round", i, picked: null, right: null, result: null });
    say(list[i]);
  }

  async function tap(pictureId: string) {
    if (phase.kind !== "round" || phase.picked) return;
    const item = game[phase.i];
    const i = phase.i;
    setPhase({ ...phase, picked: pictureId });
    const r = item.round;
    // One submit id per round: a resend (a double tap that got through, a
    // retried fetch) replays the first answer instead of recording twice.
    const submitId = submitIds.current.get(r.phraseId) ?? crypto.randomUUID();
    submitIds.current.set(r.phraseId, submitId);
    try {
      const reply = await answerRound({ phraseId: r.phraseId, version: r.version, revision: r.revision, submitId, pictureId, durationMs: clock() - shownAt.current });
      if (reply.right) {
        setStars((s) => s + 1);
        setPhase({ kind: "round", i, picked: pictureId, right: reply.pictureId, result: "right" });
        setTimeout(() => enter(i + 1), CHEER_MS);
      } else {
        setPhase({ kind: "round", i, picked: pictureId, right: reply.pictureId, result: "wrong" });
        say(item);
      }
    } catch (e) {
      // Stale (the word edited, the card practised elsewhere): nothing was
      // recorded, and nothing to show a child: on to the next.
      console.warn("word game: a tap wasn't recorded:", errText(e));
      enter(i + 1);
    }
  }

  if (phase.kind === "loading") {
    return (
      <div className="flex flex-col items-center gap-4 py-16" role="status" aria-label="Getting the game ready" data-testid="game-loading">
        <Mochi mood="thinking" size={128} />
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="flex flex-col items-center gap-6 py-10" data-testid="game-done">
        <div className="ld-cheer">
          <Mochi mood="happy" size={140} title="Well done!" />
        </div>
        <StarRow n={Math.max(stars, 1)} big />
        <BigButton label="Play again" onClick={() => void play()} testId="game-again">
          <AgainIcon />
        </BigButton>
      </div>
    );
  }

  if (phase.kind === "round") {
    const item = game[phase.i];
    const choices = item.round.choices;
    return (
      <div className="flex flex-col items-center gap-4 py-2" data-testid="game-round">
        <StarRow n={stars} />
        <div className="flex items-center gap-4">
          <Mochi mood={phase.result === "right" ? "happy" : "listening"} size={72} className={phase.result === "right" ? "ld-cheer" : ""} />
          <BigButton label="Hear it again" onClick={() => say(item)} testId="game-replay">
            <SpeakerIcon />
          </BigButton>
        </div>
        <div className="grid w-full max-w-sm grid-cols-2 gap-3">
          {choices.map((c, k) => {
            const isRight = phase.right === c.id;
            const isPicked = phase.picked === c.id;
            const faded = phase.result === "wrong" && !isRight;
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
                className={`relative aspect-square overflow-hidden rounded-3xl border-4 bg-panel shadow-sm transition focus-visible:outline-4 focus-visible:outline-accent motion-safe:active:scale-95 ${
                  isRight ? "border-accent ring-4 ring-kiai motion-safe:scale-105" : isPicked ? "border-line-strong" : "border-line"
                } ${faded ? "opacity-30" : ""}`}
              >
                <img src={item.urls.get(c.id)} alt="" className="size-full object-cover" draggable={false} />
                {isRight && phase.result === "right" && (
                  <span className="ld-pop absolute top-1 right-2 text-5xl drop-shadow" aria-hidden="true">
                    ⭐
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {phase.result === "wrong" && (
          <BigButton label="Next" onClick={() => enter(phase.i + 1)} testId="game-next">
            <NextIcon />
          </BigButton>
        )}
        <p className="sr-only" role="status">
          {phase.result === "right" ? "Yes! A star." : phase.result === "wrong" ? "This one. Listen again." : ""}
        </p>
      </div>
    );
  }

  // Home: the big Play button once there are enough pictures; until then a
  // friendly wait for the child and a line for the grown-up.
  return (
    <div className="flex flex-col items-center gap-6 py-10" data-testid="game-home">
      {status?.ready ? (
        <>
          <Mochi mood="idle" size={140} />
          <BigButton label="Play" onClick={() => void play()} testId="game-play" huge>
            <PlayIcon />
          </BigButton>
        </>
      ) : (
        <>
          <Mochi mood={status?.drawing ? "thinking" : "idle"} size={140} />
          <div className="text-6xl" aria-hidden="true">
            🎨
          </div>
        </>
      )}
      {status && <GrownUpNote status={status} />}
      {note && <p className="max-w-md text-center text-sm text-err">{note}</p>}
    </div>
  );
}

/** The grown-up's line under the game: why there is no game yet, or what
 *  is missing. Small and grey: nothing a child needs to read. */
function GrownUpNote({ status }: { status: PictureStatus }) {
  const lines: string[] = [];
  if (!status.ready) {
    if (status.problem) lines.push(status.problem);
    else if (status.drawing) lines.push(`Pictures are being drawn for the word game (${status.pictured} ready so far). The game opens once there are at least 3.`);
    else if (status.limited) lines.push(`Today's pictures for this language are used up; more are drawn tomorrow. ${status.pictured} ready so far.`);
    else if (status.waiting > 0) lines.push(`${status.waiting} word(s) are waiting for pictures. They are drawn after each session, or from Library → Phrase bank → Draw pictures.`);
    else lines.push("The word game needs at least 3 words with pictures. Words come from sessions on the Go tab; pictures are drawn after each one.");
  } else if (status.problem) lines.push(status.problem);
  if (status.audio) lines.push(`Words can't be played aloud: ${status.audio}`);
  if (!lines.length) return null;
  return (
    <div className="max-w-md text-center text-sm text-fg-3" data-testid="game-grownup">
      <span className="font-medium">For grown-ups: </span>
      {lines.join(" ")}
    </div>
  );
}

function StarRow({ n, big = false }: { n: number; big?: boolean }) {
  return (
    <div className={`flex min-h-10 flex-wrap justify-center gap-1 ${big ? "text-5xl" : "text-3xl"}`} aria-hidden="true" data-testid="game-stars">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="ld-pop">
          ⭐
        </span>
      ))}
    </div>
  );
}

function BigButton({ label, onClick, children, testId, huge = false }: { label: string; onClick: () => void; children: ReactNode; testId: string; huge?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={`grid place-items-center rounded-full bg-accent text-accent-ink shadow-md transition hover:bg-accent-hover focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-accent motion-safe:active:scale-95 ${
        huge ? "size-36" : "size-20"
      }`}
    >
      {children}
    </button>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" className="size-1/2" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
  </svg>
);
const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" className="size-1/2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
const NextIcon = () => (
  <svg viewBox="0 0 24 24" className="size-1/2" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);
const AgainIcon = () => (
  <svg viewBox="0 0 24 24" className="size-1/2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />
  </svg>
);
