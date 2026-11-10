import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError, addLibraryVoice, getCast, getVoiceSettings, listVoices, saveVoiceSettings, searchLibrary, speakLine, transcribe, voiceTurn, type VoiceLanguages,
} from "../api";
import { startRecording, type Recording } from "../recorder";
import { Mochi, SpeakerCritter, type MochiMood } from "./Mascots";
import { Glossed } from "./Glossed";
import { SessionTimeline } from "./SessionTimeline";
import { isSentence, sentenceGlosses } from "../gloss";
import type {
  LibrarySort, LibraryVoice, Mode, PackInput, TtsProvider, VoiceChoice, VoiceGender, VoiceHistoryItem, VoiceLine, VoiceSegment, VoiceSettings,
  VoiceCastReply, VoiceGloss, VoicePlanItem, VoiceSettingsReply, VoiceSlot, VoiceSpeaker,
} from "../types";
import { useCopyStatus } from "../useCopyStatus";
import { Button, Card, Chevron, inputClass } from "./ui";

/* Voice practice on the Go tab: run the pack as a spoken session right here.
 * Each turn is record → transcribe → one dojo-master reply → speak each line
 * in its speaker's voice (web/server/voice.ts). The learner decides when a
 * turn ends — a tap, or a pause as long as they chose — so thinking and
 * backtracking never get talked over. The session lives in this component;
 * nothing is saved. */

type Phase = "idle" | "opening" | "recording" | "transcribing" | "thinking" | "speaking";

const SPEAKER_LABEL: Record<VoiceSpeaker, string> = { narrator: "Narrator", character: "Character", sidekick: "Sidekick" };
const PROVIDER_LABEL: Record<TtsProvider, string> = { elevenlabs: "ElevenLabs", azure: "Azure Speech", system: "macOS voices (free)" };

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError" || (e instanceof ApiError && e.status === 499);

/** The Skip, Help and Explain buttons' messages; scripts/voice.mjs SKIP,
 *  HELP and EXPLAIN must match (the adapter tells the dojo master what each means). */
const SKIP = "[skip]";
const HELP = "[help]";
const EXPLAIN = "[explain]";
/** Prefix of a timeline jump; scripts/voice.mjs JUMP must match. */
const JUMP = "[jump]";
const CONTROL_LABEL: Record<string, string> = { [SKIP]: "Skipped", [HELP]: "Asked for help", [EXPLAIN]: "Asked for an explanation" };
/** Prefix of a message straight to the dojo master (scripts/voice.mjs DIRECT). */
const DIRECT = "[direct]";
/** Whether the timeline beside the transcript is open (per browser). */
const TIMELINE_KEY = "lingo-dojo:voice-timeline";
/** What the narrator says when the Dojo master button is tapped. */
const MASTER_ACK = "Yes? I'm listening.";
const directText = (t: string) => (t.startsWith(`${DIRECT} `) ? t.slice(DIRECT.length + 1) : null);

export default function VoicePanel({
  mode,
  pack,
  langs,
  openRequest = false,
  onOpened,
  active = true,
}: {
  mode: Mode;
  pack: PackInput;
  langs: VoiceLanguages;
  /** False while the Go tab is hidden: nothing plays or listens then. */
  active?: boolean;
  /** Open now (the sticky bar's Practice); onOpened acknowledges it. */
  openRequest?: boolean;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState(openRequest);
  // A request while closed opens it during render (React's pattern for state
  // that follows a prop); the effect then tells the parent it's handled.
  if (openRequest && !open) setOpen(true);
  useEffect(() => {
    if (openRequest) onOpened?.();
  }, [openRequest, onOpened]);
  if (!open) {
    return (
      <section className="tatami mx-auto flex w-full max-w-3xl flex-col items-center gap-4 rounded-2xl border border-line-strong/60 px-5 py-6 text-center sm:flex-row sm:text-left">
        <Mochi size={88} mood="idle" />
        <div className="flex flex-1 flex-col gap-1">
          <h2 className="text-xl font-semibold text-fg">Step onto the mat</h2>
          <p className="text-sm text-fg-2">Sensei Mochi runs the scene out loud with native voices. Answer by talking, or type if you'd rather.</p>
        </div>
        <Button variant="primary" className="shrink-0 justify-center px-5 py-2.5 text-lg" onClick={() => setOpen(true)} data-testid="voice-open">
          Practice in the dojo
        </Button>
      </section>
    );
  }
  return <VoiceSession mode={mode} pack={pack} langs={langs} active={active} onClose={() => setOpen(false)} />;
}

function VoiceSession({ mode, pack, langs, active, onClose }: { mode: Mode; pack: PackInput; langs: VoiceLanguages; active: boolean; onClose: () => void }) {
  const [reply, setReply] = useState<VoiceSettingsReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VoiceHistoryItem[]>([]);
  // The definition open under one line ("turn:line"), from a tap on a
  // glossed word or sentence; tapping it again closes it.
  const [picked, setPicked] = useState<{ at: string; gloss: VoiceGloss } | null>(null);
  const glosses = useMemo(() => sessionGlosses(entries), [entries]);
  // By term, not identity: a line's translate button builds its gloss fresh
  // each render.
  const pick = useCallback((at: string, gloss: VoiceGloss) => setPicked((p) => (p?.at === at && p.gloss.term === gloss.term ? null : { at, gloss })), []);
  const closePick = useCallback(() => setPicked(null), []);
  // Replay reads the session's latest state; the transcript gets a stable
  // handle to it so its memo holds.
  const replayRef = useRef<(i: number, j: number, lines: VoiceLine[]) => Promise<void>>(async () => {});
  useEffect(() => {
    replayRef.current = replay;
  });
  const onReplay = useCallback((i: number, j: number, lines: VoiceLine[]) => void replayRef.current(i, j, lines), []);
  // The session's parts (from the server, each turn) and where it is now.
  const [plan, setPlan] = useState<VoicePlanItem[]>([]);
  // A reply that answers a jump without naming its part is taken to be
  // where it was sent, so "here" can't stay on the part it left (and that
  // part stays one to jump back to).
  const stage = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.role !== "master") continue;
      if (e.stage) return e.stage;
      const before = entries[i - 1];
      const target = before?.role === "learner" ? jumpTarget(before.text) : null;
      if (target) return target;
    }
    return null;
  }, [entries]);
  const [timelineOpen, setTimelineOpen] = useState(() => {
    try {
      return localStorage.getItem(TIMELINE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleTimeline = () =>
    setTimelineOpen((o) => {
      try {
        localStorage.setItem(TIMELINE_KEY, o ? "closed" : "open");
      } catch {
        /* a remembered panel state is a convenience */
      }
      return !o;
    });
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  useEffect(() => {
    composerTextRef.current = composer;
  }, [composer]);
  // The composer (and the recording behind it) speaks straight to the dojo
  // master, in the native language, rather than answering the practice.
  // `direct` is the composer's toggle. It turns on only when a recording to
  // the dojo master lands in the box, and off when the learner clears the
  // tag (×) or empties the box, on send, and when a recording goes straight
  // out with nothing drafted; a cancelled or unheard recording leaves it as
  // it was. The recording's own mode is fixed when it starts (directRef,
  // and recDirect for its label).
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    directTagRef.current = direct;
  }, [direct]);
  const directRef = useRef(false);
  const [recDirect, setRecDirect] = useState(false);
  // The mic level is written straight to the meter's width: it changes 20
  // times a second while recording, and a state update would re-render the
  // whole session (every glossed line) each time.
  const levelElRef = useRef<HTMLSpanElement | null>(null);
  const setLevel = useCallback((v: number) => {
    const el = levelElRef.current;
    if (el) el.style.width = `${Math.round(v * 100)}%`;
  }, []);
  const [playing, setPlaying] = useState<string | null>(null);
  const [chars, setChars] = useState(0);
  // This session's voices, drawn at Start (Random slots differ each session)
  // and kept until Restart, so every character keeps one voice throughout.
  const [cast, setCast] = useState<VoiceCastReply | null>(null);
  const castRef = useRef<VoiceCastReply | null>(null);
  const [thinkingSecs, setThinkingSecs] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [copyStatus, copy] = useCopyStatus();

  // Mutable session plumbing the async flows read without stale closures.
  const entriesRef = useRef<VoiceHistoryItem[]>([]);
  const recRef = useRef<Recording | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // Every clip playing right now: usually one, two while lines overlap.
  const audiosRef = useRef(new Set<HTMLAudioElement>());
  const urls = useRef(new Map<string, Promise<string>>());
  // Segment keys already counted in "characters spoken".
  const counted = useRef(new Set<string>());
  const settingsRef = useRef<VoiceSettings | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // The tag and the box's text as of the latest render, for code that runs
  // after an await (the hands-free re-listen, a transcript landing) and must
  // not see the values from the render that started it.
  const directTagRef = useRef(false);
  const composerTextRef = useRef("");
  const hasEntries = entries.length > 0;
  const reviewOn = !!reply?.settings.review;
  // The box grows with what's in it (up to its max height, then scrolls).
  // Measured before paint so it never flickers a line short; only when the
  // text (or the placeholder that sizes an empty box) changes, since each
  // measure forces a layout.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [composer, direct, hasEntries, reviewOn]);
  // The phase as the async flows see it (state lags a render behind).
  const phaseRef = useRef<Phase>("idle");

  const settings = reply?.settings ?? null;
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const locale = reply?.locales.target ?? null;
  const nativeLocale = reply?.locales.native ?? null;
  // The translate button names the language it translates into, by its
  // code ("EN", "ZH", "SV"), not the first letters of its English name.
  const trLabel = nativeLocale?.split(/[-_]/)[0]?.toUpperCase() || "Tr";
  // Each master line's translation (what its translate button shows), worked
  // out once per transcript change rather than on every render: the level
  // meter re-renders many times a second while recording.
  const translations = useMemo(
    () =>
      entries.map((m) =>
        m.role === "master"
          ? m.lines.map((l) => {
              const tr = sentenceGlosses((l.segments ?? []).filter((g) => g.lang === "target").map((g) => g.text), glosses, locale ?? undefined);
              if (!tr.length) return null;
              // "line" when a whole sentence is in it, else the phrase(s)
              // it shows, so the button says which.
              const whole = tr.some((t) => isSentence(t, locale ?? undefined));
              const gloss = tr.length === 1 ? tr[0] : { term: tr.map((t) => t.term).join(" · "), meaning: tr.map((t) => t.meaning).join(" · ") };
              return { gloss, whole };
            })
          : [],
      ),
    [entries, glosses, locale],
  );
  const anyTranslation = translations.some((ls) => ls.some(Boolean));
  const slots = reply?.slots[mode] ?? (["narrator:female", "narrator:male", "character:female", "character:male"] as VoiceSlot[]);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };

  const setSession = (next: VoiceHistoryItem[]) => {
    entriesRef.current = next;
    setEntries(next);
  };

  useEffect(() => {
    let live = true;
    getVoiceSettings(langs).then(
      (r) => live && (setReply(r), setLoadError(null)),
      (e) => live && setLoadError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [langs]);

  // The elapsed counter while the dojo master thinks.
  useEffect(() => {
    if (phase !== "thinking") return;
    const start = Date.now();
    const t = window.setInterval(() => setThinkingSecs(Math.round((Date.now() - start) / 1000)), 500);
    return () => {
      window.clearInterval(t);
      setThinkingSecs(0);
    };
  }, [phase]);

  // Every async flow (open mic → record → transcribe → turn → speak) captures
  // this generation when it starts and gives up after any await that finds it
  // changed. Stop, Restart and Close bump it, so nothing in flight — a mic
  // still opening, a WAV still encoding — can carry on after the learner has
  // moved on: no orphaned mic, no paid call or audio with no UI behind it.
  const genRef = useRef(0);

  // Leaving the panel stops everything: no mic left open, no audio playing on.
  useEffect(() => {
    const cache = urls.current;
    const gen = genRef;
    const audios = audiosRef;
    return () => {
      gen.current += 1;
      ctrlRef.current?.abort();
      recRef.current?.cancel();
      for (const a of audios.current) a.pause();
      for (const p of cache.values()) void p.then(URL.revokeObjectURL, () => {});
    };
  }, []);

  // Another tab opened: the session stays (Go is only hidden), but the
  // dojo master stops talking and the mic closes. A turn already on its way
  // is stopped too, so nothing starts speaking behind the learner's back.
  useEffect(() => {
    if (!active) stopAll();
    // stopAll only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Saves can overlap (a slider sends one per step); only the newest one's
  // answer may replace the settings, or an older answer arriving last would
  // undo a later change on screen and then, via the next merge, on disk.
  const saveSeq = useRef(0);
  const update = useCallback(
    (patch: Partial<VoiceSettings>) => {
      const seq = ++saveSeq.current;
      setReply((r) => (r ? { ...r, settings: { ...r.settings, ...patch } } : r));
      saveVoiceSettings(patch, langs).then(
        (r) => seq === saveSeq.current && setReply(r),
        (e) => setError(`Could not save the setting: ${errText(e)}`),
      );
    },
    [langs],
  );

  /** Stop whatever is happening: the request in flight, the audio, the mic,
   *  and anything still on its way to starting one of those. */
  function stopAll() {
    genRef.current += 1;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    recRef.current?.cancel();
    recRef.current = null;
    for (const a of audiosRef.current) a.pause();
    audiosRef.current.clear();
    setPlaying(null);
    setLevel(0);
    setPhase("idle");
  }

  function freshCtrl() {
    ctrlRef.current?.abort();
    const c = new AbortController();
    ctrlRef.current = c;
    return c;
  }

  /** One segment's audio, fetched once and kept for replay. Each segment is
   *  said in its own language (target or native) by the line's voice. */
  function audioFor(key: string, line: VoiceLine, seg: VoiceSegment, signal: AbortSignal, retry = false): Promise<string> {
    let p = urls.current.get(key);
    if (!p) {
      if (!locale) return Promise.reject(new Error("no locale for the target language"));
      // A refetch (after someone else's abort, or a replay after a failed
      // fetch left the cache) is the same line, not more of it.
      if (!counted.current.has(key)) {
        counted.current.add(key);
        setChars((c) => c + seg.text.length);
      }
      p = speakLine(
        { speaker: line.speaker, gender: line.gender ?? null, text: seg.text, locale, lang: seg.lang, nativeLocale: nativeLocale ?? undefined, voice: castVoiceFor(castRef.current, line), fallback: castFallbackFor(castRef.current, line), provider: castRef.current?.provider },
        signal,
      ).then((b) => URL.createObjectURL(b));
      const mine = p;
      urls.current.set(key, mine);
      // A failed fetch leaves the cache (this handler runs before the
      // caller's, so a retry below finds the slot empty).
      mine.catch(() => {
        if (urls.current.get(key) === mine) urls.current.delete(key);
      });
    }
    // The cached fetch carries the signal of whoever started it. When that
    // caller was stopped (a prefetch cut off by tapping ▶, a "yes?" cut off
    // by a second tap) but this one wasn't, fetch again rather than inherit
    // their abort and play nothing. Once: a second abort is its own.
    return p.catch((e: unknown) => {
      if (isAbort(e) && !signal.aborted && !retry) return audioFor(key, line, seg, signal, true);
      throw e;
    });
  }

  /** Play one clip. Resolves when it ends, or `leadMs` before it ends when
   *  the next line overlaps it; the clip then plays on to its end (or until
   *  Stop) while the next one starts. */
  function playUrl(url: string, signal: AbortSignal, leadMs = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      audiosRef.current.add(a);
      let poll = 0;
      let settled = false;
      const release = () => {
        settled = true;
        window.clearInterval(poll);
      };
      const finish = () => {
        audiosRef.current.delete(a);
        signal.removeEventListener("abort", stop);
        window.clearInterval(poll);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const stop = () => {
        a.pause();
        finish();
      };
      a.onended = finish;
      a.onerror = () => {
        finish();
        reject(new Error("the browser could not play that audio"));
      };
      signal.addEventListener("abort", stop, { once: true });
      a.play().then(() => {
        if (leadMs <= 0) return;
        // Watch the time left: timeupdate fires only ~4 times a second, too
        // coarse for a 0.3 s overlap.
        poll = window.setInterval(() => {
          if (Number.isFinite(a.duration) && a.duration - a.currentTime <= leadMs / 1000) {
            release();
            resolve();
          }
        }, 25);
      }, (e) => {
        finish();
        reject(e);
      });
    });
  }

  /** Wait between lines; Stop cuts it short. */
  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = window.setTimeout(done, ms);
      function done() {
        window.clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Speak lines in order, segment by segment, fetching the next segment
   *  while the current one plays. A line from before segments existed (or
   *  with none) is spoken whole as the target language. */
  async function playLines(entryIdx: number, lines: VoiceLine[], signal: AbortSignal, from = 0, only = false) {
    setPhase("speaking");
    const last = only ? from : lines.length - 1;
    // `pauseMs` is the gap before a line's first segment (none before the
    // first line played); segments within a line run back to back.
    const queue: { key: string; lineKey: string; line: VoiceLine; seg: VoiceSegment; pauseMs: number }[] = [];
    for (let i = from; i <= last; i++) {
      const segs = lines[i].segments?.length ? lines[i].segments : [{ lang: "target" as const, text: lines[i].text }];
      segs.forEach((seg, k) =>
        queue.push({ key: `${entryIdx}:${i}:${k}`, lineKey: `${entryIdx}:${i}`, line: lines[i], seg, pauseMs: k === 0 && i > from ? (lines[i].pauseMs ?? 0) : 0 }),
      );
    }
    for (let q = 0; q < queue.length; q++) {
      if (signal.aborted) return;
      const cur = queue[q];
      const url = await audioFor(cur.key, cur.line, cur.seg, signal);
      const next = queue[q + 1];
      if (next) void audioFor(next.key, next.line, next.seg, signal).catch(() => {});
      if (signal.aborted) return;
      if (cur.pauseMs > 0) await pause(cur.pauseMs, signal);
      if (signal.aborted) return;
      setPlaying(cur.lineKey);
      // An overlapping next line starts this far before this clip ends.
      const lead = next && next.pauseMs < 0 ? -next.pauseMs : 0;
      await playUrl(url, signal, lead);
    }
    // The turn is over when every clip has finished, not when an overlap
    // let the loop move on (a short line can overlap into a longer one).
    while (audiosRef.current.size && !signal.aborted) await pause(50, signal);
    setPlaying(null);
  }

  async function runTurn(message: string, gen = genRef.current) {
    if (!settingsRef.current || gen !== genRef.current) return;
    setError(null);
    setNotice(null);
    const before = entriesRef.current;
    const history = message ? [...before, { role: "learner" as const, text: message }] : before;
    setSession(history);
    const ctrl = freshCtrl();
    setPhase("thinking");
    try {
      // The first turn draws the cast; later turns reuse it, unless the voice
      // provider changed mid-session (settings are shared by every open
      // window), whose voices the old cast can't name.
      if (locale && (!castRef.current || castRef.current.provider !== settingsRef.current.tts)) {
        castRef.current = await getCast({ mode, locale, units: pack.units }, ctrl.signal);
        if (ctrl.signal.aborted || gen !== genRef.current) return;
        setCast(castRef.current);
      }
      const r = await voiceTurn({ mode, pack, history: before, message, narratorGender: castRef.current?.narratorGender }, ctrl.signal);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      const idx = history.length;
      setSession([...history, { role: "master", lines: r.lines, ...(r.glosses?.length ? { glosses: r.glosses } : {}), ...(r.choices?.length ? { choices: r.choices } : {}), ...(r.stage ? { stage: r.stage } : {}) }]);
      if (r.plan?.length) setPlan(r.plan);
      await playLines(idx, r.lines, ctrl.signal);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      setPhase("idle");
      const s = settingsRef.current;
      if (s?.handsFree && s.turn === "pause") void startListening();
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e) || gen !== genRef.current) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  async function startListening(toMaster = false) {
    const s = settingsRef.current;
    // "opening" covers the await on the mic: a second Space or a double tap
    // while the permission prompt is up must not open a second recording.
    if (!s || recRef.current || phaseRef.current === "opening") return;
    // Talking over the dojo master is allowed: it stops them.
    stopAll();
    // Talk with the tag on dictates to the master too, matching the tag.
    directRef.current = toMaster || directTagRef.current;
    setRecDirect(directRef.current);
    const gen = genRef.current;
    phaseRef.current = "opening";
    setPhase("opening");
    setError(null);
    setNotice(null);
    let mine: Recording | null = null;
    try {
      mine = await startRecording({
        silenceMs: s.turn === "pause" ? s.silenceMs : null,
        onLevel: setLevel,
        // Only the recording that is current may end the turn.
        onAutoStop: (why) => {
          if (mine && recRef.current === mine) void finishListening(why);
        },
      });
      if (gen !== genRef.current) {
        mine.cancel();
        return;
      }
      recRef.current = mine;
      setPhase("recording");
    } catch (e) {
      if (gen !== genRef.current) return;
      setPhase("idle");
      setError(`Could not open the microphone: ${errText(e)}`);
    }
  }

  async function finishListening(why: "tap" | "pause" | "max" | "idle") {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    const gen = genRef.current;
    setLevel(0);
    setPhase("transcribing");
    try {
      const { wav, spoke, ms } = await rec.stop();
      if (gen !== genRef.current) return;
      // A tap ends the turn even when the level meter heard nothing (a soft
      // voice can stay under it), but a short silent tap is a mis-tap: don't
      // pay to transcribe it.
      if (!wav || why === "idle" || (!spoke && (why !== "tap" || ms < 1500))) {
        setPhase("idle");
        setNotice("Didn't hear anything — tap the wave when you're ready.");
        return;
      }
      const ctrl = freshCtrl();
      const toMaster = directRef.current;
      // Practice speech is taken as the target language with the expected
      // phrases as hints; a direct request is the native language, no hints.
      const locales = (toMaster ? [nativeLocale] : [locale, nativeLocale]).filter((l): l is string => !!l);
      const { text } = await transcribe(wav, locales, ctrl.signal, toMaster ? [] : expectedPhrases(entriesRef.current));
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      if (!text) {
        setPhase("idle");
        setNotice("Couldn't make out any words — try again.");
        return;
      }
      // A request to the dojo master with a practice answer already drafted
      // in the box goes straight out: the tag covers the whole box, so
      // joining them would send the draft to the dojo master too.
      const draft = composerTextRef.current.trim();
      const intoBox = settingsRef.current?.review && !(toMaster && draft && !directTagRef.current);
      if (intoBox) {
        setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text));
        if (toMaster) setDirect(true);
        setPhase("idle");
        window.setTimeout(() => composerRef.current?.focus(), 0);
        return;
      }
      if (!draft || !toMaster) setDirect(false);
      await runTurn(toMaster ? `${DIRECT} ${text}` : text, gen);
    } catch (e) {
      if (isAbort(e) || gen !== genRef.current) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  /** Skip ("[skip]": move on), Help ("[help]": what's asked, plus a hint
   *  that grows each time) or Explain ("[explain]": more on what was just
   *  said). Like Send, either cuts off speech, and it
   *  drops a recording in progress. */
  function control(message: string) {
    if (phase !== "idle" && phase !== "speaking" && phase !== "recording") return;
    if (phase !== "idle") stopAll();
    void runTurn(message);
  }

  /** Sending while the dojo master is still talking cuts them off, the
   *  same as Talk does: the learner never has to wait out a long line. */
  function sendComposer() {
    const text = composer.trim();
    if (!text || (phase !== "idle" && phase !== "speaking")) return;
    if (phase === "speaking") stopAll();
    setComposer("");
    setDirect(false);
    void runTurn(direct ? `${DIRECT} ${text}` : text);
  }

  /** A tapped check-in answer ("Keep going") goes to the dojo master as a
   *  direct request, not as a practice answer to correct. */
  function choose(label: string) {
    if (!canAct) return;
    if (phase !== "idle") stopAll();
    // The choices disappear with this turn; focus goes somewhere on purpose
    // rather than falling to the page.
    composerRef.current?.focus();
    void runTurn(`${DIRECT} ${label}`);
  }

  /** A part of the session tapped on the timeline: the dojo master goes
   *  straight there ("[jump] <id>"). */
  function jump(item: VoicePlanItem) {
    if (!canAct || item.id === stage) return;
    if (phase !== "idle") stopAll();
    setPicked(null);
    void runTurn(`${JUMP} ${item.id}`);
  }

  /** The Dojo master button: the narrator answers "yes?" in the learner's
   *  own language, then the mic opens for a direct request. The "yes?" is a
   *  fixed line in the narrator's voice (cached after the first time), not a
   *  model turn: it has to be instant. With a native language other than
   *  English there is no fixed line to say, so the mic just opens. */
  async function askMaster() {
    if (!canAct || !sttReady) return;
    stopAll();
    const gen = genRef.current;
    if (/^english$/i.test(langs.native ?? "") && castRef.current) {
      const ctrl = freshCtrl();
      const line: VoiceLine = { speaker: "narrator", gender: castRef.current.narratorGender, text: MASTER_ACK, segments: [{ lang: "native", text: MASTER_ACK }] };
      try {
        setPhase("speaking");
        const url = await audioFor(`ack:${castRef.current.provider}:${castRef.current.narratorGender}`, line, line.segments[0], ctrl.signal);
        if (ctrl.signal.aborted || gen !== genRef.current) return;
        await playUrl(url, ctrl.signal);
      } catch {
        // A "yes?" that can't be spoken is not worth an error: just listen.
      }
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      setPhase("idle");
    }
    await startListening(true);
  }

  async function replay(entryIdx: number, lineIdx: number, lines: VoiceLine[]) {
    stopAll();
    const gen = genRef.current;
    const ctrl = freshCtrl();
    try {
      await playLines(entryIdx, lines, ctrl.signal, lineIdx, true);
    } catch (e) {
      if (!ctrl.signal.aborted && !isAbort(e) && gen === genRef.current) setError(errText(e));
    } finally {
      if (!ctrl.signal.aborted && gen === genRef.current) setPhase("idle");
    }
  }

  function restart() {
    stopAll();
    for (const p of urls.current.values()) void p.then(URL.revokeObjectURL, () => {});
    urls.current.clear();
    // A new session draws a new cast.
    castRef.current = null;
    setCast(null);
    setSession([]);
    setPicked(null);
    setPlan([]);
    setComposer("");
    setError(null);
    setNotice(null);
  }

  const provider = settings?.tts ?? "elevenlabs";
  const ttsReady = !!reply?.configured[provider];
  const sttReady = !!settings && !!reply?.configured[settings.stt];

  // Space toggles the mic (outside text fields and buttons, where it types or
  // clicks). Re-bound each render so it sees the current phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable]") || t.isContentEditable)) return;
      if (!entriesRef.current.length || !sttReady) return;
      e.preventDefault();
      if (phase === "recording") void finishListening("tap");
      else if (phase === "idle" || phase === "speaking") void startListening();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // No voice has to be chosen first: Random slots are filled by the cast at
  // Start.
  const canStart = !!settings && !!locale && ttsReady;
  const started = entries.length > 0;
  const busy = phase === "thinking" || phase === "transcribing" || phase === "opening";
  // Quick requests may cut off speech or a recording, like Talk does, but
  // not a turn already on its way.
  const canAct = phase === "idle" || phase === "speaking" || phase === "recording";
  // Check-in answers belong to the latest turn only: once anything else is
  // said, they are stale.
  const lastEntry = entries[entries.length - 1];
  const lastChoices = lastEntry?.role === "master" ? (lastEntry.choices ?? []) : [];

  // The timeline is its own column beside the session card (above it on
  // narrow screens), scrolling on its own, so it never squeezes or
  // lengthens the transcript.
  return (
    // Before Start there is only a button and settings: they keep the page's
    // reading width rather than stretching across a wide screen.
    <div className={`flex flex-col gap-3 lg:flex-row lg:items-start ${started ? "" : "mx-auto w-full max-w-3xl"}`}>
    {started && plan.length > 0 && (
      <aside className={`shrink-0 lg:sticky lg:top-(--below-bars) lg:flex lg:max-h-[calc(100dvh-var(--below-bars)-1rem)] lg:flex-col ${timelineOpen ? "lg:w-60" : "lg:w-8"}`}>
        <SessionTimeline plan={plan} stage={stage} open={timelineOpen} onToggle={toggleTimeline} onJump={jump} disabled={!canAct} />
      </aside>
    )}
    <Card className="tatami flex min-w-0 flex-1 flex-col gap-4 border-line-strong/60" data-testid="voice-panel">
      {/* The buttons drop below the title on a phone rather than squeezing it. */}
      <div className="flex flex-wrap items-start gap-3">
        <Mochi size={56} className="shrink-0" mood={mochiMood(phase, started)} title={`Sensei Mochi, ${MOOD_LABEL[mochiMood(phase, started)]}`} />
        <div className="flex min-w-40 flex-1 flex-col gap-0.5 pt-1">
        <h2 className="text-xl font-semibold text-fg">Practice by voice</h2>
        {reply && (
          <span className="text-sm text-fg-3 sm:text-xs">
            {PROVIDER_LABEL[provider]}
            {locale ? ` · ${locale}` : ""}
            {chars > 0 && ` · ${chars.toLocaleString()} characters spoken`}
            {cast && Object.keys(cast.cast).length > 0 && (
              <span className="block" data-testid="voice-cast" title="Random slots draw new voices each session; Restart draws again">
                Voices this session: {castSummary(cast)}
              </span>
            )}
          </span>
        )}
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-fg-2 hover:bg-panel/70 hover:text-fg"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((o) => !o)}
        >
          Voice settings <Chevron open={showSettings} />
        </button>
        <Button
          variant="ghost"
          onClick={() => {
            stopAll();
            onClose();
          }}
        >
          Close
        </Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-err">Could not load voice settings: {loadError}</p>}
      {reply && !locale && (
        <p className="rounded-md bg-warn-soft p-3 text-sm text-warn">
          No voice locale is known for “{langs.variant || langs.target || "no target language"}”. Pick a target language on the Scene tab.
        </p>
      )}

      {reply && settings && (showSettings || !canStart) && (
        <SettingsBlock reply={reply} settings={settings} locale={locale} slots={slots} onChange={update} />
      )}

      {canStart && !started && (
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="justify-center self-stretch px-5 py-2.5 text-base sm:self-start" onClick={() => void runTurn("")} disabled={busy} data-testid="voice-start">
            {phase === "thinking" ? "Starting…" : "Start session"}
          </Button>
          <p className="text-sm text-fg-3 sm:text-xs">
            The dojo master speaks first. {settings?.turn === "pause" ? `Your turn ends after ${(settings.silenceMs / 1000).toFixed(1)} s of quiet.` : "Tap the wave to answer, and ■ when you're done."}
            {!sttReady && " No speech-to-text provider is set up, so type your answers."}
          </p>
        </div>
      )}

      {started && (
        <Transcript
          entries={entries}
          plan={plan}
          playing={playing}
          picked={picked}
          translations={translations}
          glosses={glosses}
          locale={locale}
          trLabel={trLabel}
          onPick={pick}
          onClosePick={closePick}
          onReplay={onReplay}
        />
      )}
      {lastChoices.length > 0 && canAct && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick answers" data-testid="voice-choices">
          {lastChoices.map((c, k) => (
            <QuickButton key={`${k}:${c}`} variant="choice" onClick={() => choose(c)}>
              {c}
            </QuickButton>
          ))}
          <QuickButton variant="choice" onClick={() => void askMaster()} disabled={!sttReady}>
            🎙 I'll tell you
          </QuickButton>
        </div>
      )}
      {glosses.length > 0 && (
        <p className="text-xs text-fg-3">
          Tap an underlined word for its meaning{anyTranslation ? `; ${trLabel} beside a line translates it.` : "."}
        </p>
      )}

      {(phase !== "idle" || notice) && (
        <p className="flex items-center gap-2 text-sm text-fg-2" role="status" data-testid="voice-status">
          {phase === "recording" && (
            <>
              <span className="inline-block h-2 w-16 overflow-hidden rounded bg-raised" aria-hidden="true">
                <span ref={levelElRef} className="block h-full bg-accent transition-[width]" style={{ width: "0%" }} />
              </span>
              {recDirect ? `Listening in ${langs.native || "your language"}, to the dojo master` : "Listening"}{settings?.turn === "pause" ? ` — ends after ${(settings.silenceMs / 1000).toFixed(1)} s of quiet` : settings?.review ? " — tap ■ when you've finished" : " — tap ■ to send"}
            </>
          )}
          {phase === "opening" && "Opening the microphone…"}
          {phase === "transcribing" && "Transcribing…"}
          {phase === "thinking" && `The dojo master is thinking… ${thinkingSecs}s`}
          {phase === "speaking" && "Speaking…"}
          {phase === "idle" && notice}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-err-soft p-3 text-sm text-err" data-testid="voice-error">
          {error}
        </p>
      )}

      {started && (
        <div className="flex flex-col gap-2">
          {/* Quick requests: one tap each, no recording needed (except the
              dojo master, which opens the mic after its "yes?"). */}
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Quick requests">
            <QuickButton onClick={() => void askMaster()} disabled={!sttReady || !canAct} title={`Talk straight to the dojo master in ${langs.native || "your language"}: change the scene, redo something, ask a question`} testid="voice-direct">
              <Mochi size={18} /> Dojo master
            </QuickButton>
            <QuickButton onClick={() => control(HELP)} disabled={!canAct} title="What am I being asked? Get a hint — ask again for a bigger one" testid="voice-help">
              💡 Help
            </QuickButton>
            <QuickButton onClick={() => control(EXPLAIN)} disabled={!canAct} title="Explain what was just said: the meaning, the key words, any local note" testid="voice-explain">
              🔎 Explain
            </QuickButton>
            <QuickButton onClick={() => control(SKIP)} disabled={!canAct} title="Skip this exercise and move on" testid="voice-skip">
              ⏭ Skip
            </QuickButton>
            {(phase === "speaking" || phase === "thinking") && (
              <QuickButton onClick={stopAll} title="Stop the dojo master" testid="voice-stop">
                ■ Stop
              </QuickButton>
            )}
            <span className="flex-1" />
            <Button variant="ghost" className="px-2 py-1" onClick={() => copy(transcriptText(entries))}>
              {copyStatus === "copied" ? "Copied" : "Copy transcript"}
            </Button>
            <Button variant="ghost" className="px-2 py-1" onClick={restart}>
              Restart
            </Button>
          </div>
          {/* A message for the dojo master waiting in the box is tagged, not
              a mode: ▶ sends it to the dojo master; × makes it a practice answer. */}
          {direct && (
            <span className="flex items-center gap-1 self-start rounded-full bg-accent-soft py-0.5 pr-1 pl-2.5 text-sm text-fg sm:text-xs" data-testid="voice-direct-tag">
              💬 To the dojo master · {langs.native || "your language"}
              <button
                type="button"
                className="rounded-full px-1.5 text-fg-3 hover:bg-raised hover:text-fg"
                onClick={() => setDirect(false)}
                aria-label="Send it as a practice answer instead"
                title="Send it as a practice answer instead"
              >
                ×
              </button>
            </span>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendComposer();
            }}
          >
            <textarea
              ref={composerRef}
              aria-label="Your answer"
              className={`${inputClass} max-h-48 min-h-11 flex-1 resize-none overflow-y-auto`}
              rows={1}
              placeholder={
                direct
                  ? `To the dojo master, in ${langs.native || "your language"}: change the scene, redo that, slower please…`
                  : settings?.review
                    ? "Your words land here to check before sending — or type"
                    : "Type an answer, or tap the wave to speak"
              }
              value={composer}
              onChange={(e) => {
                setComposer(e.target.value);
                // An emptied box is no longer a message to the dojo master.
                if (!e.target.value.trim()) setDirect(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendComposer();
                }
              }}
            />
            {phase === "recording" ? (
              <>
                <RoundButton variant="ghost" onClick={stopAll} label="Cancel the recording" testid="voice-cancel">
                  ×
                </RoundButton>
                <RoundButton onClick={() => void finishListening("tap")} label={settings?.review ? "Done — put my words in the box" : "Done — send what I said"} testid="voice-done">
                  <StopIcon />
                </RoundButton>
              </>
            ) : (
              <RoundButton onClick={() => void startListening()} disabled={!sttReady || busy} label={sttReady ? "Talk — Space also works" : "Set up a speech-to-text provider first"} testid="voice-talk">
                <VoiceWave />
              </RoundButton>
            )}
            <RoundButton type="submit" variant="secondary" disabled={!composer.trim() || (phase !== "idle" && phase !== "speaking")} label="Send what's in the box" testid="voice-send">
              <SendIcon />
            </RoundButton>
          </form>
        </div>
      )}
    </Card>
    </div>
  );
}

const GENDER_LABEL: Record<VoiceGender, string> = { female: "woman", male: "man" };

function lineLabel(l: VoiceLine): string {
  // The narrator is one voice for the whole session (the cast fixes it), so
  // its line-by-line gender tag says nothing and can be wrong.
  if (l.speaker === "narrator" || !l.gender) return SPEAKER_LABEL[l.speaker];
  return `${SPEAKER_LABEL[l.speaker]} · ${GENDER_LABEL[l.gender]}`;
}

function slotLabel(slot: VoiceSlot): string {
  const [speaker, gender] = slot.split(":") as [VoiceSpeaker, VoiceGender];
  return `${SPEAKER_LABEL[speaker]} · ${GENDER_LABEL[gender]}`;
}

function transcriptText(entries: VoiceHistoryItem[]): string {
  return entries
    .map((m) => (m.role === "learner" ? `Me: ${CONTROL_LABEL[m.text] ? `(${CONTROL_LABEL[m.text].toLowerCase()})` : jumpTarget(m.text) != null ? `(jumped to ${jumpTarget(m.text)})` : directText(m.text) != null ? `(to the dojo master) ${directText(m.text)}` : m.text}` : m.lines.map((l) => `${lineLabel(l)}: ${l.text}`).join("\n") + (m.glosses?.length ? `\n${m.glosses.map((g) => `  ${g.term} = ${g.meaning}`).join("\n")}` : "")))
    .join("\n\n");
}

/* ------------------------------- settings ------------------------------- */

function SettingsBlock({
  reply,
  settings,
  locale,
  slots,
  onChange,
}: {
  reply: VoiceSettingsReply;
  settings: VoiceSettings;
  locale: string | null;
  slots: VoiceSlot[];
  onChange: (patch: Partial<VoiceSettings>) => void;
}) {
  const { configured } = reply;
  const missing = (["elevenlabs", "azure"] as const).filter((p) => !configured[p]);
  const label = "flex flex-col gap-1 text-sm text-fg-2";
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-4" data-testid="voice-settings">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          Voices
          <select className={inputClass} value={settings.tts} onChange={(e) => onChange({ tts: e.target.value as TtsProvider })}>
            {(["elevenlabs", "azure", "system"] as const).map((p) => (
              <option key={p} value={p} disabled={!configured[p]}>
                {PROVIDER_LABEL[p]}
                {configured[p] ? "" : " (not set up)"}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Listening (speech to text)
          <select className={inputClass} value={settings.stt} onChange={(e) => onChange({ stt: e.target.value as VoiceSettings["stt"] })}>
            {(["elevenlabs", "azure"] as const).map((p) => (
              <option key={p} value={p} disabled={!configured[p]}>
                {PROVIDER_LABEL[p]}
                {configured[p] ? "" : " (not set up)"}
              </option>
            ))}
          </select>
        </label>
        {settings.tts === "elevenlabs" && (
          <label className={label}>
            ElevenLabs model
            <select className={inputClass} value={settings.elevenModel} onChange={(e) => onChange({ elevenModel: e.target.value })}>
              {reply.elevenModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={label}>
          Dojo master model
          <select className={inputClass} value={settings.model} onChange={(e) => onChange({ model: e.target.value })}>
            {reply.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.note}
              </option>
            ))}
          </select>
        </label>
      </div>

      {locale && configured[settings.tts] && (
        <VoicePickers provider={settings.tts} locale={locale} slots={slots} settings={settings} onChange={onChange} />
      )}

      <fieldset className="flex flex-col gap-2 text-sm text-fg-2">
        <legend className="mb-1">When does your turn end?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="turn" checked={settings.turn === "tap"} onChange={() => onChange({ turn: "tap" })} />
          When I tap Done (best for thinking out loud, and for kids)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="turn" checked={settings.turn === "pause"} onChange={() => onChange({ turn: "pause" })} />
          After a pause of
          <input
            type="range"
            aria-label="Pause length"
            min={reply.silence.min}
            max={reply.silence.max}
            step={100}
            value={settings.silenceMs}
            disabled={settings.turn !== "pause"}
            onChange={(e) => onChange({ silenceMs: Number(e.target.value) })}
          />
          <span className="tabular-nums">{(settings.silenceMs / 1000).toFixed(1)} s</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.review} onChange={(e) => onChange({ review: e.target.checked })} />
          Let me check (and fix) what it heard before sending
        </label>
        <label className={`flex items-center gap-2 ${settings.turn === "pause" ? "" : "opacity-50"}`}>
          <input type="checkbox" checked={settings.handsFree} disabled={settings.turn !== "pause"} onChange={(e) => onChange({ handsFree: e.target.checked })} />
          Start listening again as soon as the dojo master finishes
        </label>
      </fieldset>

      {missing.length > 0 && (
        <p className="text-sm text-fg-3 sm:text-xs">
          To set up {missing.map((p) => PROVIDER_LABEL[p]).join(" or ")}, add{" "}
          {missing.map((p) => (p === "elevenlabs" ? "ELEVENLABS_API_KEY" : "AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")).join(", or ")} to{" "}
          <code className="font-mono">{reply.envFile}</code> (gitignored). No restart needed.
        </p>
      )}
    </div>
  );
}

/** One voice select per slot (each speaker as a woman and as a man), from
 *  the provider's list for the target locale. Empty slots get defaults the
 *  first time the list loads — natives first, matching gender, all distinct —
 *  so a fresh setup can start right away. ElevenLabs adds a browser for the
 *  whole Voice Library. */
function VoicePickers({
  provider,
  locale,
  slots,
  settings,
  onChange,
}: {
  provider: TtsProvider;
  locale: string;
  slots: VoiceSlot[];
  settings: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
}) {
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Bumped after a library voice is added, to re-list the account's voices.
  const [listVersion, setListVersion] = useState(0);
  const current: Record<string, string | undefined> = settings.voices[provider]?.[locale] ?? {};
  // The latest voices, for merges that land after an await (a library add):
  // the render that started it may be older than a pick made meanwhile.
  const voicesRef = useRef(settings.voices);
  useEffect(() => {
    voicesRef.current = settings.voices;
  }, [settings.voices]);

  useEffect(() => {
    const ctrl = new AbortController();
    listVoices(provider, locale, ctrl.signal).then(
      (r) => {
        setError(null);
        setVoices(r.voices);
      },
      (e) => !ctrl.signal.aborted && setError(errText(e)),
    );
    return () => ctrl.abort();
  }, [provider, locale, listVersion]);

  const setVoice = useCallback(
    (patch: Record<string, string>) => {
      const all = voicesRef.current;
      const byLocale = { ...(all[provider] ?? {}) };
      byLocale[locale] = { ...(byLocale[locale] ?? {}), ...patch };
      const next = { ...all, [provider]: byLocale };
      // Update the ref now too, so two merges in one tick both survive.
      voicesRef.current = next;
      onChange({ voices: next });
    },
    [provider, locale, onChange],
  );

  // An empty slot is Random: the session's cast draws a native voice of that
  // gender each time (/api/voice/cast), so nothing is auto-picked here.

  if (error) return <p className="text-sm text-err">Could not list voices: {error}</p>;
  if (!voices) return <p className="text-sm text-fg-3">Loading voices…</p>;
  const natives = voices.filter((v) => v.match);
  const others = voices.filter((v) => !v.match);
  const option = (v: VoiceChoice) => (
    <option key={v.id} value={v.id}>
      {v.name}
      {v.gender ? ` · ${v.gender.toLowerCase()}` : ""}
      {v.note ? ` · ${v.note}` : ""}
    </option>
  );
  return (
    <div className="flex flex-col gap-3">
      {voices.length === 0 ? (
        <p className="text-sm text-warn">
          {provider === "system"
            ? `No macOS voice for ${locale} is installed. Add one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.`
            : provider === "elevenlabs"
              ? "Your ElevenLabs account has no voices yet — browse the Voice Library below."
              : `Azure has no voices for ${locale}.`}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="voice-pickers">
          {slots.map((slot) => (
            <label key={slot} className="flex flex-col gap-1 text-sm text-fg-2">
              {slotLabel(slot)}
              <select className={inputClass} value={current[slot] ?? ""} onChange={(e) => setVoice({ [slot]: e.target.value })}>
                <option value="">🎲 Random — a new native voice each session</option>
                {natives.length > 0 && <optgroup label={`Speaks ${locale}`}>{natives.map(option)}</optgroup>}
                {others.length > 0 && <optgroup label={natives.length ? "Other voices" : "Voices"}>{others.map(option)}</optgroup>}
                {current[slot] && !voices.some((v) => v.id === current[slot]) && <option value={current[slot]}>{current[slot]} (saved)</option>}
              </select>
            </label>
          ))}
        </div>
      )}
      {provider === "elevenlabs" && (
        <>
          <Button className="self-start" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing} data-testid="library-toggle">
            {browsing ? "Hide the Voice Library" : `Browse the Voice Library for ${locale} voices`}
          </Button>
          {browsing && (
            <LibraryBrowser
              key={locale}
              locale={locale}
              slots={slots}
              current={current}
              onUse={(slot, voiceId) => {
                setVoice({ [slot]: voiceId });
                setListVersion((n) => n + 1);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "usage_character_count_1y", label: "Most used this year" },
  { id: "trending", label: "Trending" },
  { id: "cloned_by_count", label: "Most added" },
  { id: "created_date", label: "Newest" },
];

/** The ElevenLabs Voice Library, narrowed to native speakers of the target
 *  locale: search, gender, popularity, a description and a preview for each,
 *  and "Use as…" a slot — which adds the voice to the ElevenLabs account
 *  (that is how the API lets you synthesize with a library voice). */
function LibraryBrowser({
  locale,
  slots,
  current,
  onUse,
}: {
  locale: string;
  slots: VoiceSlot[];
  current: Record<string, string | undefined>;
  onUse: (slot: VoiceSlot, voiceId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState("");
  const [sort, setSort] = useState<LibrarySort>("usage_character_count_1y");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<LibraryVoice[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Voices being added, by id: each row stays busy until its own add settles.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  // A new search starts over; "More" appends the next page. "Loading" is
  // derived: the search on screen is not yet the one that has answered.
  const searchKey = JSON.stringify([locale, gender, query, sort, page]);
  const [answered, setAnswered] = useState<string | null>(null);
  const loading = answered !== searchKey;
  useEffect(() => {
    const ctrl = new AbortController();
    searchLibrary({ locale, gender, q: query, sort, page }, ctrl.signal).then(
      (r) => {
        setRows((prev) => (page === 0 ? r.voices : [...prev, ...r.voices]));
        setHasMore(r.hasMore);
        setTotal(r.total);
        setError(null);
        setAnswered(searchKey);
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setError(errText(e));
        // A failed first page leaves no rows from the previous search for
        // "More voices" to append to; a failed later page keeps what loaded.
        if (page === 0) setRows([]);
        setHasMore(false);
        setAnswered(searchKey);
      },
    );
    return () => ctrl.abort();
  }, [locale, gender, query, sort, page, searchKey]);

  useEffect(() => () => previewRef.current?.pause(), []);

  function restartWith(fn: () => void) {
    fn();
    setPage(0);
  }

  function preview(v: LibraryVoice) {
    const old = previewRef.current;
    if (old) {
      old.onended = null;
      old.pause();
    }
    previewRef.current = null;
    if (previewing === v.id || !v.previewUrl) {
      setPreviewing(null);
      return;
    }
    const a = new Audio(v.previewUrl);
    previewRef.current = a;
    // Pausing a sample that is still loading rejects its play() with an
    // AbortError; only the sample that is still current may reset the button.
    const done = () => previewRef.current === a && setPreviewing(null);
    a.onended = done;
    setPreviewing(v.id);
    a.play().catch(done);
  }

  async function use(v: LibraryVoice, slot: VoiceSlot) {
    if (busyRef.current.has(v.id)) return;
    busyRef.current.add(v.id);
    setBusy(new Set(busyRef.current));
    setStatus(null);
    try {
      const id = v.added ? v.id : (await addLibraryVoice({ ownerId: v.ownerId, voiceId: v.id, name: v.name })).voiceId;
      setRows((rs) => rs.map((r) => (r.id === v.id ? { ...r, added: true } : r)));
      onUse(slot, id);
      setStatus(`${slotLabel(slot)} now speaks as ${v.name}${v.added ? "" : " (added to your ElevenLabs voices)"}.`);
    } catch (e) {
      setStatus(`Could not use ${v.name}: ${errText(e)}`);
    } finally {
      busyRef.current.delete(v.id);
      setBusy(new Set(busyRef.current));
    }
  }

  const inUse = new Map<string, string[]>();
  for (const slot of slots) {
    const id = current[slot];
    if (id) inUse.set(id, [...(inUse.get(id) ?? []), slotLabel(slot)]);
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3" data-testid="library">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          restartWith(() => setQuery(q.trim()));
        }}
      >
        <input className={`${inputClass} min-w-40 flex-1`} placeholder="Search: warm, older, storyteller…" aria-label="Search voices" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${inputClass} w-auto`} aria-label="Gender" value={gender} onChange={(e) => restartWith(() => setGender(e.target.value))}>
          <option value="">Women and men</option>
          <option value="female">Women</option>
          <option value="male">Men</option>
        </select>
        <select className={`${inputClass} w-auto`} aria-label="Sort" value={sort} onChange={(e) => restartWith(() => setSort(e.target.value as LibrarySort))}>
          {SORTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <Button type="submit">Search</Button>
      </form>
      <p className="text-sm text-fg-3 sm:text-xs">
        Native {locale} speakers from the ElevenLabs Voice Library{total != null ? ` · ${total.toLocaleString()} voices` : ""}. ▶ plays the sharer's sample; "Use as" adds the voice to your
        ElevenLabs account.
      </p>
      {status && (
        <p className="text-sm text-accent" role="status">
          {status}
        </p>
      )}
      {error && <p className="text-sm text-err">Could not search the library: {error}</p>}
      <ul className="flex max-h-[32rem] flex-col divide-y divide-line overflow-y-auto" aria-label="Library voices">
        {rows.map((v) => (
          <li key={v.id} className="flex flex-col gap-1 py-2" data-testid="library-voice">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="shrink-0 rounded border border-line px-2 py-0.5 text-sm text-fg-2 hover:bg-raised disabled:opacity-40"
                onClick={() => preview(v)}
                disabled={!v.previewUrl}
                aria-label={previewing === v.id ? `Stop the sample of ${v.name}` : `Play a sample of ${v.name}`}
              >
                {previewing === v.id ? "■" : "▶"}
              </button>
              <span className="font-medium text-fg">{v.name}</span>
              <span className="text-sm text-fg-3 sm:text-xs">
                {[v.gender, v.age, v.accent, v.useCase].filter(Boolean).join(" · ")}
              </span>
              <span className="flex-1" />
              <span className="text-sm text-fg-3 tabular-nums sm:text-xs" title={`${v.usage1y.toLocaleString()} characters this year · ${v.clonedBy.toLocaleString()} adds`}>
                {compact.format(v.usage1y)} chars/yr · {compact.format(v.clonedBy)} adds
              </span>
            </div>
            {v.description && <p className="line-clamp-2 text-sm text-fg-2">{v.description}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${inputClass} w-auto`}
                aria-label={`Use ${v.name} as`}
                value=""
                disabled={busy.has(v.id)}
                onChange={(e) => e.target.value && void use(v, e.target.value as VoiceSlot)}
              >
                <option value="">{busy.has(v.id) ? "Adding…" : "Use as…"}</option>
                {[...slots]
                  .sort((a, b) => Number(b.endsWith(`:${v.gender}`)) - Number(a.endsWith(`:${v.gender}`)))
                  .map((slot) => (
                    <option key={slot} value={slot}>
                      {slotLabel(slot)}
                    </option>
                  ))}
              </select>
              {inUse.has(v.id) && <span className="text-sm text-accent sm:text-xs">In use: {inUse.get(v.id)!.join(", ")}</span>}
              {v.added && !inUse.has(v.id) && <span className="text-sm text-fg-3 sm:text-xs">In your voices</span>}
            </div>
          </li>
        ))}
      </ul>
      {loading && <p className="text-sm text-fg-3">Loading…</p>}
      {!loading && rows.length === 0 && !error && <p className="text-sm text-fg-3">No voices match.</p>}
      {hasMore && !loading && (
        <Button className="self-start" onClick={() => setPage((p) => p + 1)}>
          More voices
        </Button>
      )}
    </div>
  );
}

/** The target-language phrases of the dojo master's last two turns, newest
 *  first: what the learner is most likely about to say. Sent as hints for
 *  speech to text, capped so the URL stays short. */
function expectedPhrases(history: VoiceHistoryItem[]): string[] {
  const out: string[] = [];
  // The query string must stay well under Node's 16 KB header limit, and
  // CJK text grows ~9x when URL-encoded: cap the encoded total, not a count.
  let budget = 6000;
  const masters = history.filter((h): h is Extract<VoiceHistoryItem, { role: "master" }> => h.role === "master").slice(-2).reverse();
  for (const h of masters) {
    for (const line of h.lines) {
      for (const g of line.segments ?? []) {
        if (g.lang !== "target") continue;
        const phrase = g.text.slice(0, 300);
        const cost = encodeURIComponent(phrase).length + 6;
        if (cost > budget) return out;
        budget -= cost;
        out.push(phrase);
      }
    }
  }
  return out;
}

/** The voice id this session's cast gives a line: its speaker and gender's
 *  slot. An untagged narrator line takes the session's narrator gender; an
 *  untagged character line, whichever of the speaker's slots exists. */
function castSlotFor(cast: VoiceCastReply | null, line: VoiceLine): string | undefined {
  if (!cast) return undefined;
  // The narrator keeps the session's voice even when a line's tag says
  // otherwise: one narrator, one voice.
  const g = line.speaker === "narrator" ? cast.narratorGender : line.gender;
  if (g) return `${line.speaker}:${g}`;
  return [`${line.speaker}:female`, `${line.speaker}:male`].find((k) => cast.cast[k]);
}

function castVoiceFor(cast: VoiceCastReply | null, line: VoiceLine): string | undefined {
  const slot = castSlotFor(cast, line);
  return slot ? cast?.cast[slot]?.id : undefined;
}

/** The account voice to say a line in if its cast voice is refused (a
 *  free plan and a library voice). */
function castFallbackFor(cast: VoiceCastReply | null, line: VoiceLine): string | undefined {
  const slot = castSlotFor(cast, line);
  return slot ? cast?.fallbacks?.[slot] : undefined;
}

/** "Narrator Marlene · Character (woman) Regina · Character (man) Alejandro":
 *  the narrator for the gender this session uses, then the scene's voices. */
function castSummary(cast: VoiceCastReply): string {
  const parts: string[] = [];
  const narrator = cast.cast[`narrator:${cast.narratorGender}`];
  if (narrator) parts.push(`Narrator ${narrator.name}`);
  for (const [slot, v] of Object.entries(cast.cast)) {
    const [speaker, gender] = slot.split(":");
    if (speaker === "narrator") continue;
    parts.push(`${speaker[0].toUpperCase()}${speaker.slice(1)} (${gender === "female" ? "woman" : "man"}) ${v.name}`);
  }
  return parts.join(" · ");
}

/** Sensei Mochi follows the session: talking while lines play, listening
 *  while the mic is open, thinking while a turn or transcript is on its way,
 *  and a calm bow otherwise. */
function mochiMood(phase: string, started: boolean): MochiMood {
  if (phase === "speaking") return "talking";
  if (phase === "recording") return "listening";
  if (phase === "thinking" || phase === "transcribing" || phase === "opening") return "thinking";
  return started ? "happy" : "idle";
}

const MOOD_LABEL: Record<MochiMood, string> = {
  idle: "ready to begin",
  happy: "waiting for you",
  thinking: "thinking",
  talking: "speaking",
  listening: "listening",
};

/** The Talk button's icon: a sound wave, the usual mark for "talk to the
 *  assistant" in voice apps, rather than a microphone. */
function VoiceWave() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M3 8.5v3M7 5.5v9M11 3v14M15 6.5v7M19 9v2" />
    </svg>
  );
}

/** Every gloss in the session so far, the first wording of a term winning:
 *  the dojo master doesn't re-gloss a word it already explained, so a word
 *  from turn two must still be tappable in turn five. */
function sessionGlosses(entries: { role: string; glosses?: VoiceGloss[] }[]): VoiceGloss[] {
  const seen = new Set<string>();
  const out: VoiceGloss[] = [];
  for (const e of entries) {
    for (const g of e.glosses ?? []) {
      const k = g.term.toLocaleLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(g);
    }
  }
  return out;
}

type LineTranslation = { gloss: VoiceGloss; whole: boolean } | null;

/** The session's transcript. Memoised: the session re-renders for things
 *  that don't touch it (the thinking counter, the composer), and every
 *  glossed line is laid out again on each render. It follows the session:
 *  a new turn scrolls into view when the learner was already at the bottom
 *  (not when they had scrolled up to reread), and the line being spoken is
 *  kept in view. Both move only the list's own scroll, never the page. */
const Transcript = memo(function Transcript({
  entries,
  plan,
  playing,
  picked,
  translations,
  glosses,
  locale,
  trLabel,
  onPick,
  onClosePick,
  onReplay,
}: {
  entries: VoiceHistoryItem[];
  plan: VoicePlanItem[];
  playing: string | null;
  picked: { at: string; gloss: VoiceGloss } | null;
  translations: LineTranslation[][];
  glosses: VoiceGloss[];
  locale: string | null;
  trLabel: string;
  onPick: (at: string, gloss: VoiceGloss) => void;
  onClosePick: () => void;
  onReplay: (i: number, j: number, lines: VoiceLine[]) => void;
}) {
  const olRef = useRef<HTMLOListElement | null>(null);
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = olRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const count = entries.length;
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el) return;
    // The learner's own message always comes into view: they just sent it.
    if (atBottom.current || entries[count - 1]?.role === "learner") {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
    // Only a new entry moves the list, not a re-render of the same ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el || !playing) return;
    const row = el.querySelector<HTMLElement>(`[data-line="${playing}"]`);
    if (!row) return;
    const box = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const pad = 8;
    if (r.top < box.top + pad || r.height > box.height) el.scrollTop += r.top - box.top - pad;
    else if (r.bottom > box.bottom - pad) el.scrollTop += r.bottom - box.bottom + pad;
  }, [playing]);
  return (
<ol ref={olRef} onScroll={onScroll} className="flex max-h-[min(28rem,calc(100dvh-22rem))] min-h-48 min-w-0 flex-1 lg:max-h-[max(28rem,calc(100dvh-26rem))] flex-col gap-2 overflow-y-auto rounded-2xl border border-line bg-panel p-3" aria-label="Session transcript" data-testid="voice-transcript">
  {entries.map((m, i) =>
    m.role === "learner" ? (
      <li key={i} className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm text-fg">
        {CONTROL_LABEL[m.text] ? (
          <span className="text-fg-3 italic">{CONTROL_LABEL[m.text]}</span>
        ) : jumpTarget(m.text) != null ? (
          <span className="text-fg-3 italic">Jumped to {planTitle(plan, jumpTarget(m.text) as string)}</span>
        ) : directText(m.text) != null ? (
          <>
            <span className="text-fg-3 italic">To the dojo master: </span>
            {directText(m.text)}
          </>
        ) : (
          m.text
        )}
      </li>
    ) : (
      <li key={i} className="flex flex-col gap-1">
        {m.lines.map((l, j) => (
          <div key={j} data-line={`${i}:${j}`} className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors ${playing === `${i}:${j}` ? "bg-kiai-soft" : ""}`}>
            <SpeakerCritter speaker={l.speaker} size={30} />
            <span className="w-16 shrink-0 pt-1.5 font-[family-name:var(--font-display)] text-xs break-words text-fg-3 sm:w-24">{lineLabel(l)}</span>
            <span className="min-w-0 max-w-[72ch] flex-1 text-fg [overflow-wrap:anywhere]">
              {(l.segments?.length ? l.segments : [{ lang: "native" as const, text: l.text }]).map((g, k) => (
                <span key={k} className={g.lang === "target" ? "font-medium text-accent" : ""} lang={g.lang === "target" ? (locale ?? undefined) : undefined}>
                  {k > 0 && !/^[.,;:!?)\]»…]/.test(g.text) ? " " : ""}
                  {g.lang === "target" ? <Glossed text={g.text} glosses={glosses} locale={locale ?? undefined} picked={picked?.at === `${i}:${j}` ? picked.gloss : null} onPick={(gl) => onPick(`${i}:${j}`, gl)} /> : g.text}
                </span>
              ))}
              {picked?.at === `${i}:${j}` && (
                <span className="mt-1.5 flex items-start gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-sm text-fg" role="status" data-testid="voice-gloss">
                  <span className="flex-1">
                    <span className="font-medium text-accent" lang={locale ?? undefined}>{picked.gloss.term}</span>
                    <span className="text-fg-3"> — </span>
                    {picked.gloss.meaning}
                  </span>
                  <button type="button" className="text-fg-3 hover:text-fg" aria-label="Close definition" onClick={onClosePick}>
                    ×
                  </button>
                </span>
              )}
            </span>
            {(() => {
              // The line's translation: every glossed sentence (or
              // phrase that isn't a button) in it, one tap, and the
              // keyboard's way to them.
              const tr = translations[i]?.[j];
              if (!tr) return null;
              const { gloss, whole } = tr;
              const what = whole ? "this line" : "this phrase";
              return (
                <button type="button" className="shrink-0 rounded px-0.5 text-xs text-fg-3 hover:text-fg" aria-label={`${trLabel}: translate ${what}`} title={`Translate ${what}`} aria-pressed={picked?.at === `${i}:${j}` && picked.gloss.term === gloss.term} onClick={() => onPick(`${i}:${j}`, gloss)}>
                  {trLabel}
                </button>
              );
            })()}
            <button type="button" className="shrink-0 text-fg-3 hover:text-fg" aria-label="Replay line" title="Replay" onClick={() => onReplay(i, j, m.lines)}>
              ▶
            </button>
          </div>
        ))}
      </li>
    ),
  )}
</ol>
  );
});

/** A quick-request chip above the composer, or a check-in answer. */
function QuickButton({ onClick, disabled, title, testid, variant = "quick", children }: { onClick: () => void; disabled?: boolean; title?: string; testid?: string; variant?: "quick" | "choice"; children: ReactNode }) {
  const look = variant === "choice"
    ? "border-accent bg-accent-soft text-fg hover:bg-accent hover:text-accent-ink"
    : "border-line bg-panel text-fg-2 hover:bg-raised hover:text-fg";
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-[family-name:var(--font-display)] text-sm transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${look}`}
      // aria-disabled, not disabled: a disabled button drops keyboard focus
      // to the page while a turn runs, and the next Space would open the mic.
      onClick={() => {
        if (!disabled) onClick();
      }}
      aria-disabled={disabled || undefined}
      title={title}
      data-testid={testid}
    >
      {children}
    </button>
  );
}

/** Talk, Done and Send beside the composer: round icon buttons, like a
 *  chat app's. The label is the accessible name and the tooltip. */
function RoundButton({ onClick, disabled, label, testid, type = "button", variant = "primary", children }: { onClick?: () => void; disabled?: boolean; label: string; testid?: string; type?: "button" | "submit"; variant?: "primary" | "secondary" | "ghost"; children: ReactNode }) {
  const look = {
    primary: "border-accent-edge bg-accent text-accent-ink shadow-[0_3px_0_var(--accent-edge)] hover:bg-accent-hover active:translate-y-[2px] active:shadow-[0_1px_0_var(--accent-edge)]",
    secondary: "border-line bg-panel text-fg shadow-[0_3px_0_var(--line)] hover:bg-raised active:translate-y-[2px] active:shadow-[0_1px_0_var(--line)]",
    ghost: "border-transparent text-fg-3 hover:bg-raised hover:text-fg text-xl",
  }[variant];
  return (
    <button
      type={type}
      className={`mb-[3px] inline-flex size-11 shrink-0 items-center justify-center rounded-full border transition-[background-color,transform,box-shadow] duration-75 disabled:cursor-not-allowed disabled:opacity-50 ${look}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testid}
    >
      {children}
    </button>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="4" y="4" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}

/** A right-facing triangle: send. */
function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M5 3.5 17 10 5 16.5Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** The part id of a "[jump] <id>" message; null for anything else. */
function jumpTarget(text: string): string | null {
  return text.startsWith(`${JUMP} `) ? text.slice(JUMP.length + 1).trim() : null;
}

function planTitle(plan: VoicePlanItem[], id: string): string {
  return plan.find((p) => p.id === id)?.title ?? id;
}
