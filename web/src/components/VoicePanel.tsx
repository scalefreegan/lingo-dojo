import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, addLibraryVoice, getCast, getVoiceSettings, listVoices, saveVoiceSettings, searchLibrary, speakLine, transcribe, voiceTurn, type VoiceLanguages,
} from "../api";
import { startRecording, type Recording } from "../recorder";
import { Mochi, SpeakerCritter, type MochiMood } from "./Mascots";
import { Glossed } from "./Glossed";
import type {
  LibrarySort, LibraryVoice, Mode, PackInput, TtsProvider, VoiceChoice, VoiceGender, VoiceHistoryItem, VoiceLine, VoiceSegment, VoiceSettings,
  VoiceCastReply, VoiceGloss, VoiceSettingsReply, VoiceSlot, VoiceSpeaker,
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

/** The Skip and Help buttons' messages; scripts/voice.mjs SKIP and HELP
 *  must match (the adapter tells the dojo master what each means). */
const SKIP = "[skip]";
const HELP = "[help]";
const CONTROL_LABEL: Record<string, string> = { [SKIP]: "Skipped", [HELP]: "Asked for help" };
/** Prefix of a message straight to the dojo master (scripts/voice.mjs DIRECT). */
const DIRECT = "[direct]";
const directText = (t: string) => (t.startsWith(`${DIRECT} `) ? t.slice(DIRECT.length + 1) : null);

export default function VoicePanel({
  mode,
  pack,
  langs,
  openRequest = false,
  onOpened,
}: {
  mode: Mode;
  pack: PackInput;
  langs: VoiceLanguages;
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
      <section className="tatami flex flex-col items-center gap-4 rounded-2xl border border-line-strong/60 px-5 py-6 text-center sm:flex-row sm:text-left">
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
  return <VoiceSession mode={mode} pack={pack} langs={langs} onClose={() => setOpen(false)} />;
}

function VoiceSession({ mode, pack, langs, onClose }: { mode: Mode; pack: PackInput; langs: VoiceLanguages; onClose: () => void }) {
  const [reply, setReply] = useState<VoiceSettingsReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VoiceHistoryItem[]>([]);
  // The definition open under one line ("turn:line"), from a tap on a
  // glossed word or sentence; tapping it again closes it.
  const [picked, setPicked] = useState<{ at: string; gloss: VoiceGloss } | null>(null);
  const glosses = useMemo(() => sessionGlosses(entries), [entries]);
  const pick = (at: string, gloss: VoiceGloss) => setPicked((p) => (p?.at === at && p.gloss === gloss ? null : { at, gloss }));
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  // The composer (and the recording behind it) speaks straight to the dojo
  // master, in the native language, rather than answering the practice.
  // `direct` is the composer's toggle. It changes only when the learner flips
  // it, when a direct recording lands in the composer, and on send, so a
  // cancelled or unheard recording can't leave it on. The recording's own
  // mode is fixed when it starts (directRef, and recDirect for its label).
  const [direct, setDirect] = useState(false);
  const directRef = useRef(false);
  const [recDirect, setRecDirect] = useState(false);
  const [level, setLevel] = useState(0);
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
  const settingsRef = useRef<VoiceSettings | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // The phase as the async flows see it (state lags a render behind).
  const phaseRef = useRef<Phase>("idle");

  const settings = reply?.settings ?? null;
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const locale = reply?.locales.target ?? null;
  const nativeLocale = reply?.locales.native ?? null;
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
  function audioFor(key: string, line: VoiceLine, seg: VoiceSegment, signal: AbortSignal): Promise<string> {
    let p = urls.current.get(key);
    if (!p) {
      if (!locale) return Promise.reject(new Error("no locale for the target language"));
      setChars((c) => c + seg.text.length);
      p = speakLine(
        { speaker: line.speaker, gender: line.gender ?? null, text: seg.text, locale, lang: seg.lang, nativeLocale: nativeLocale ?? undefined, voice: castVoiceFor(castRef.current, line) },
        signal,
      ).then((b) => URL.createObjectURL(b));
      urls.current.set(key, p);
      p.catch(() => urls.current.delete(key));
    }
    return p;
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
      setSession([...history, { role: "master", lines: r.lines, ...(r.glosses?.length ? { glosses: r.glosses } : {}) }]);
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
    // Talk with the toggle on dictates to the master too, matching the toggle.
    directRef.current = toMaster || direct;
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
        setNotice("Didn't hear anything — tap Talk when you're ready.");
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
      if (settingsRef.current?.review) {
        setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text));
        if (toMaster) setDirect(true);
        setPhase("idle");
        window.setTimeout(() => composerRef.current?.focus(), 0);
        return;
      }
      setDirect(false);
      await runTurn(toMaster ? `${DIRECT} ${text}` : text, gen);
    } catch (e) {
      if (isAbort(e) || gen !== genRef.current) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  /** Skip ("[skip]": move on) or Help ("[help]": what's asked, plus a
   *  hint that grows each time). Like Send, either cuts off speech, and it
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
      if (e.code !== "Space" || e.repeat) return;
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

  return (
    <Card className="tatami flex flex-col gap-4 border-line-strong/60" data-testid="voice-panel">
      <div className="flex items-start gap-3">
        <Mochi size={56} className="shrink-0" mood={mochiMood(phase, started)} title={`Sensei Mochi, ${MOOD_LABEL[mochiMood(phase, started)]}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
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
            The dojo master speaks first. {settings?.turn === "pause" ? `Your turn ends after ${(settings.silenceMs / 1000).toFixed(1)} s of quiet.` : "Tap Talk to answer and tap again when you're done."}
            {!sttReady && " No speech-to-text provider is set up, so type your answers."}
          </p>
        </div>
      )}

      {started && (
        <ol className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto rounded-2xl border border-line bg-panel p-3" aria-label="Session transcript" data-testid="voice-transcript">
          {entries.map((m, i) =>
            m.role === "learner" ? (
              <li key={i} className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm text-fg">
                {CONTROL_LABEL[m.text] ? (
                  <span className="text-fg-3 italic">{CONTROL_LABEL[m.text]}</span>
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
                  <div key={j} className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors ${playing === `${i}:${j}` ? "bg-kiai-soft" : ""}`}>
                    <SpeakerCritter speaker={l.speaker} size={30} />
                    <span className="w-24 shrink-0 pt-1.5 font-[family-name:var(--font-display)] text-sm text-fg-3 sm:text-xs">{lineLabel(l)}</span>
                    <span className="flex-1 text-fg">
                      {(l.segments?.length ? l.segments : [{ lang: "native" as const, text: l.text }]).map((g, k) => (
                        <span key={k} className={g.lang === "target" ? "font-medium text-accent" : ""} lang={g.lang === "target" ? (locale ?? undefined) : undefined}>
                          {k > 0 && !/^[.,;:!?)\]»…]/.test(g.text) ? " " : ""}
                          {g.lang === "target" ? <Glossed text={g.text} glosses={glosses} picked={picked?.at === `${i}:${j}` ? picked.gloss : null} onPick={(gl) => pick(`${i}:${j}`, gl)} /> : g.text}
                        </span>
                      ))}
                      {picked?.at === `${i}:${j}` && (
                        <span className="mt-1.5 flex items-start gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-sm text-fg" role="status" data-testid="voice-gloss">
                          <span className="flex-1">
                            <span className="font-medium text-accent" lang={locale ?? undefined}>{picked.gloss.term}</span>
                            <span className="text-fg-3"> — </span>
                            {picked.gloss.meaning}
                          </span>
                          <button type="button" className="text-fg-3 hover:text-fg" aria-label="Close definition" onClick={() => setPicked(null)}>
                            ×
                          </button>
                        </span>
                      )}
                    </span>
                    <button type="button" className="shrink-0 text-fg-3 hover:text-fg" aria-label="Replay line" title="Replay" onClick={() => void replay(i, j, m.lines)}>
                      ▶
                    </button>
                  </div>
                ))}
              </li>
            ),
          )}
        </ol>
      )}
      {glosses.length > 0 && (
        <p className="text-xs text-fg-3">
          Tap an underlined word for its meaning, or any line in {langs.target || "the target language"} for a translation.
        </p>
      )}

      {(phase !== "idle" || notice) && (
        <p className="flex items-center gap-2 text-sm text-fg-2" role="status" data-testid="voice-status">
          {phase === "recording" && (
            <>
              <span className="inline-block h-2 w-16 overflow-hidden rounded bg-raised" aria-hidden="true">
                <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
              {recDirect ? `Listening in ${langs.native || "your language"}, to the dojo master` : "Listening"}{settings?.turn === "pause" ? ` — ends after ${(settings.silenceMs / 1000).toFixed(1)} s of quiet` : " — tap Done when you've finished"}
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
          <div className="flex flex-wrap items-center gap-2">
            {phase === "recording" ? (
              <Button variant="primary" className="px-5 py-2.5 text-base" onClick={() => void finishListening("tap")}>
                Done
              </Button>
            ) : (
              <Button variant="primary" className="px-5 py-2.5 text-base" onClick={() => void startListening()} disabled={!sttReady || busy} title={sttReady ? "Records your answer — Space also works" : "Set up a speech-to-text provider first"}>
                <VoiceWave /> Talk
              </Button>
            )}
            {phase !== "recording" && (
              <Button
                onClick={() => void startListening(true)}
                disabled={!sttReady || busy}
                title={`Talk straight to the dojo master in ${langs.native || "your language"}: change the scene, redo something, ask a question`}
                data-testid="voice-direct"
              >
                💬 {langs.native || "Native"}
              </Button>
            )}
            {(phase === "speaking" || phase === "thinking" || phase === "recording") && (
              <Button onClick={stopAll}>{phase === "recording" ? "Cancel" : "Stop"}</Button>
            )}
            <Button
              onClick={() => control(HELP)}
              disabled={phase !== "idle" && phase !== "speaking" && phase !== "recording"}
              title="What am I being asked? Get a hint — ask again for a bigger one"
              data-testid="voice-help"
            >
              Help 💡
            </Button>
            <Button
              onClick={() => control(SKIP)}
              disabled={phase !== "idle" && phase !== "speaking" && phase !== "recording"}
              title="Skip this exercise and move on"
              data-testid="voice-skip"
            >
              Skip ⏭
            </Button>
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => copy(transcriptText(entries))}>
              {copyStatus === "copied" ? "Copied" : "Copy transcript"}
            </Button>
            <Button variant="ghost" onClick={restart}>
              Restart
            </Button>
          </div>
          {/* A message from 💬 waiting in the box is tagged, not a mode button:
              Send sends it to the dojo master; × makes it a practice answer. */}
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
              className={`${inputClass} min-h-10 flex-1`}
              rows={1}
              placeholder={
                direct
                  ? `To the dojo master, in ${langs.native || "your language"}: change the scene, redo that, slower please…`
                  : settings?.review
                    ? "Your words land here to check before sending — or type"
                    : "Type an answer instead"
              }
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendComposer();
                }
              }}
            />
            <Button type="submit" disabled={!composer.trim() || (phase !== "idle" && phase !== "speaking")} data-testid="voice-send">
              Send
            </Button>
          </form>
        </div>
      )}
    </Card>
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
    .map((m) => (m.role === "learner" ? `Me: ${CONTROL_LABEL[m.text] ? `(${CONTROL_LABEL[m.text].toLowerCase()})` : directText(m.text) != null ? `(to the dojo master) ${directText(m.text)}` : m.text}` : m.lines.map((l) => `${lineLabel(l)}: ${l.text}`).join("\n") + (m.glosses?.length ? `\n${m.glosses.map((g) => `  ${g.term} = ${g.meaning}`).join("\n")}` : "")))
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
function castVoiceFor(cast: VoiceCastReply | null, line: VoiceLine): string | undefined {
  if (!cast) return undefined;
  // The narrator keeps the session's voice even when a line's tag says
  // otherwise: one narrator, one voice.
  const g = line.speaker === "narrator" ? cast.narratorGender : line.gender;
  const c = cast.cast;
  return (g ? c[`${line.speaker}:${g}`] : (c[`${line.speaker}:female`] ?? c[`${line.speaker}:male`]))?.id;
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
