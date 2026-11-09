import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, addLibraryVoice, getVoiceSettings, listVoices, saveVoiceSettings, searchLibrary, speakLine, transcribe, voiceTurn, type VoiceLanguages,
} from "../api";
import { startRecording, type Recording } from "../recorder";
import type {
  LibrarySort, LibraryVoice, Mode, PackInput, TtsProvider, VoiceChoice, VoiceGender, VoiceHistoryItem, VoiceLine, VoiceSegment, VoiceSettings,
  VoiceSettingsReply, VoiceSlot, VoiceSpeaker,
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

export default function VoicePanel({ mode, pack, langs }: { mode: Mode; pack: PackInput; langs: VoiceLanguages }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button className="self-stretch justify-center sm:self-start" onClick={() => setOpen(true)} data-testid="voice-open">
        Practice here by voice
      </Button>
    );
  }
  return <VoiceSession mode={mode} pack={pack} langs={langs} onClose={() => setOpen(false)} />;
}

function VoiceSession({ mode, pack, langs, onClose }: { mode: Mode; pack: PackInput; langs: VoiceLanguages; onClose: () => void }) {
  const [reply, setReply] = useState<VoiceSettingsReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VoiceHistoryItem[]>([]);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [level, setLevel] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [chars, setChars] = useState(0);
  const [thinkingSecs, setThinkingSecs] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [copyStatus, copy] = useCopyStatus();

  // Mutable session plumbing the async flows read without stale closures.
  const entriesRef = useRef<VoiceHistoryItem[]>([]);
  const recRef = useRef<Recording | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
    return () => {
      gen.current += 1;
      ctrlRef.current?.abort();
      recRef.current?.cancel();
      audioRef.current?.pause();
      for (const p of cache.values()) void p.then(URL.revokeObjectURL, () => {});
    };
  }, []);

  const update = useCallback(
    (patch: Partial<VoiceSettings>) => {
      setReply((r) => (r ? { ...r, settings: { ...r.settings, ...patch } } : r));
      saveVoiceSettings(patch, langs).then(setReply, (e) => setError(`Could not save the setting: ${errText(e)}`));
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
    audioRef.current?.pause();
    audioRef.current = null;
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
        { speaker: line.speaker, gender: line.gender ?? null, text: seg.text, locale, lang: seg.lang, nativeLocale: nativeLocale ?? undefined },
        signal,
      ).then((b) => URL.createObjectURL(b));
      urls.current.set(key, p);
      p.catch(() => urls.current.delete(key));
    }
    return p;
  }

  function playUrl(url: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      audioRef.current = a;
      const done = () => {
        signal.removeEventListener("abort", done);
        a.pause();
        resolve();
      };
      a.onended = done;
      a.onerror = () => reject(new Error("the browser could not play that audio"));
      signal.addEventListener("abort", done, { once: true });
      a.play().catch(reject);
    });
  }

  /** Speak lines in order, segment by segment, fetching the next segment
   *  while the current one plays. A line from before segments existed (or
   *  with none) is spoken whole as the target language. */
  async function playLines(entryIdx: number, lines: VoiceLine[], signal: AbortSignal, from = 0, only = false) {
    setPhase("speaking");
    const last = only ? from : lines.length - 1;
    const queue: { key: string; lineKey: string; line: VoiceLine; seg: VoiceSegment }[] = [];
    for (let i = from; i <= last; i++) {
      const segs = lines[i].segments?.length ? lines[i].segments : [{ lang: "target" as const, text: lines[i].text }];
      segs.forEach((seg, k) => queue.push({ key: `${entryIdx}:${i}:${k}`, lineKey: `${entryIdx}:${i}`, line: lines[i], seg }));
    }
    for (let q = 0; q < queue.length; q++) {
      if (signal.aborted) return;
      const cur = queue[q];
      const url = await audioFor(cur.key, cur.line, cur.seg, signal);
      const next = queue[q + 1];
      if (next) void audioFor(next.key, next.line, next.seg, signal).catch(() => {});
      if (signal.aborted) return;
      setPlaying(cur.lineKey);
      await playUrl(url, signal);
    }
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
      const r = await voiceTurn({ mode, pack, history: before, message }, ctrl.signal);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      const idx = history.length;
      setSession([...history, { role: "master", lines: r.lines }]);
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

  async function startListening() {
    const s = settingsRef.current;
    // "opening" covers the await on the mic: a second Space or a double tap
    // while the permission prompt is up must not open a second recording.
    if (!s || recRef.current || phaseRef.current === "opening") return;
    // Talking over the dojo master is allowed: it stops them.
    stopAll();
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
      const { wav, spoke } = await rec.stop();
      if (gen !== genRef.current) return;
      if (why === "idle" || (!spoke && why !== "tap")) {
        setPhase("idle");
        setNotice("Didn't hear anything — tap Talk when you're ready.");
        return;
      }
      const ctrl = freshCtrl();
      const { text } = await transcribe(wav, [locale, nativeLocale].filter((l): l is string => !!l), ctrl.signal);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      if (!text) {
        setPhase("idle");
        setNotice("Couldn't make out any words — try again.");
        return;
      }
      if (settingsRef.current?.review) {
        setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text));
        setPhase("idle");
        window.setTimeout(() => composerRef.current?.focus(), 0);
        return;
      }
      await runTurn(text, gen);
    } catch (e) {
      if (isAbort(e) || gen !== genRef.current) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  /** Sending while the dojo master is still talking cuts them off, the
   *  same as Talk does: the learner never has to wait out a long line. */
  function sendComposer() {
    const text = composer.trim();
    if (!text || (phase !== "idle" && phase !== "speaking")) return;
    if (phase === "speaking") stopAll();
    setComposer("");
    void runTurn(text);
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
    setSession([]);
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

  const voiceSet: Record<string, string | undefined> = (settings && locale ? settings.voices[provider]?.[locale] : undefined) ?? {};
  // A narrator voice is required even for macOS: the system default voice is
  // the Mac's own language, which would read Spanish with an English accent.
  // Until one is set the settings stay open, and the pickers fill it in.
  const voicesReady = !!(voiceSet["narrator:female"] || voiceSet["narrator:male"] || voiceSet.narrator);
  const canStart = !!settings && !!locale && ttsReady && voicesReady;
  const started = entries.length > 0;
  const busy = phase === "thinking" || phase === "transcribing" || phase === "opening";

  return (
    <Card className="flex flex-col gap-4" data-testid="voice-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium text-fg">Practice by voice</h2>
        {reply && (
          <span className="text-sm text-fg-3 sm:text-xs">
            {PROVIDER_LABEL[provider]}
            {locale ? ` · ${locale}` : ""}
            {chars > 0 && ` · ${chars.toLocaleString()} characters spoken`}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm text-fg-2 hover:text-fg"
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
        <ol className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto" aria-label="Session transcript" data-testid="voice-transcript">
          {entries.map((m, i) =>
            m.role === "learner" ? (
              <li key={i} className="self-end rounded-lg bg-accent-soft px-3 py-2 text-sm text-fg">
                {m.text}
              </li>
            ) : (
              <li key={i} className="flex flex-col gap-1">
                {m.lines.map((l, j) => (
                  <div key={j} className={`flex items-start gap-2 rounded-md px-2 py-1 text-sm ${playing === `${i}:${j}` ? "bg-raised" : ""}`}>
                    <span className="w-24 shrink-0 pt-0.5 text-sm text-fg-3 sm:text-xs">{lineLabel(l)}</span>
                    <span className="flex-1 text-fg">
                      {(l.segments?.length ? l.segments : [{ lang: "native" as const, text: l.text }]).map((g, k) => (
                        <span key={k} className={g.lang === "target" ? "font-medium text-accent" : ""} lang={g.lang === "target" ? (locale ?? undefined) : undefined}>
                          {k > 0 && !/^[.,;:!?)\]»…]/.test(g.text) ? " " : ""}
                          {g.text}
                        </span>
                      ))}
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

      {(phase !== "idle" || notice) && (
        <p className="flex items-center gap-2 text-sm text-fg-2" role="status" data-testid="voice-status">
          {phase === "recording" && (
            <>
              <span className="inline-block h-2 w-16 overflow-hidden rounded bg-raised" aria-hidden="true">
                <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
              Listening{settings?.turn === "pause" ? ` — ends after ${(settings.silenceMs / 1000).toFixed(1)} s of quiet` : " — tap Done when you've finished"}
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
                🎙 Talk
              </Button>
            )}
            {(phase === "speaking" || phase === "thinking" || phase === "recording") && (
              <Button onClick={stopAll}>{phase === "recording" ? "Cancel" : "Stop"}</Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => copy(transcriptText(entries))}>
              {copyStatus === "copied" ? "Copied" : "Copy transcript"}
            </Button>
            <Button variant="ghost" onClick={restart}>
              Restart
            </Button>
          </div>
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
              placeholder={settings?.review ? "Your words land here to check before sending — or type" : "Type an answer instead"}
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
  return l.gender ? `${SPEAKER_LABEL[l.speaker]} · ${GENDER_LABEL[l.gender]}` : SPEAKER_LABEL[l.speaker];
}

function slotLabel(slot: VoiceSlot): string {
  const [speaker, gender] = slot.split(":") as [VoiceSpeaker, VoiceGender];
  return `${SPEAKER_LABEL[speaker]} · ${GENDER_LABEL[gender]}`;
}

function transcriptText(entries: VoiceHistoryItem[]): string {
  return entries
    .map((m) => (m.role === "learner" ? `Me: ${m.text}` : m.lines.map((l) => `${lineLabel(l)}: ${l.text}`).join("\n")))
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
    <div className="flex flex-col gap-4 rounded-md border border-line p-3" data-testid="voice-settings">
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

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    listVoices(provider, locale, ctrl.signal).then(
      (r) => setVoices(r.voices),
      (e) => !ctrl.signal.aborted && setError(errText(e)),
    );
    return () => ctrl.abort();
  }, [provider, locale, listVersion]);

  const setVoice = useCallback(
    (patch: Record<string, string>) => {
      const byLocale = { ...(settings.voices[provider] ?? {}) };
      byLocale[locale] = { ...(byLocale[locale] ?? {}), ...patch };
      onChange({ voices: { ...settings.voices, [provider]: byLocale } });
    },
    [settings.voices, provider, locale, onChange],
  );

  // First load with gaps: fill them, natives first, the slot's gender when
  // the provider says, and distinct where the list allows.
  useEffect(() => {
    if (!voices?.length) return;
    const unset = slots.filter((s) => !current[s]);
    if (!unset.length) return;
    const taken = new Set(Object.values(current));
    const patch: Record<string, string> = {};
    for (const slot of unset) {
      const gender = slot.split(":")[1];
      const fits = (v: VoiceChoice) => !v.gender || v.gender.toLowerCase() === gender;
      const pick =
        voices.find((v) => v.match && fits(v) && !taken.has(v.id)) ??
        voices.find((v) => fits(v) && !taken.has(v.id)) ??
        voices.find((v) => !taken.has(v.id)) ??
        voices[0];
      patch[slot] = pick.id;
      taken.add(pick.id);
    }
    setVoice(patch);
    // Only when the list arrives: a later manual change is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices]);

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
                {!current[slot] && <option value="">Choose…</option>}
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
  const [busyId, setBusyId] = useState<string | null>(null);
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
    previewRef.current?.pause();
    if (previewing === v.id || !v.previewUrl) {
      setPreviewing(null);
      return;
    }
    const a = new Audio(v.previewUrl);
    previewRef.current = a;
    a.onended = () => setPreviewing(null);
    setPreviewing(v.id);
    a.play().catch(() => setPreviewing(null));
  }

  async function use(v: LibraryVoice, slot: VoiceSlot) {
    setBusyId(v.id);
    setStatus(null);
    try {
      const id = v.added ? v.id : (await addLibraryVoice({ ownerId: v.ownerId, voiceId: v.id, name: v.name })).voiceId;
      setRows((rs) => rs.map((r) => (r.id === v.id ? { ...r, added: true } : r)));
      onUse(slot, id);
      setStatus(`${slotLabel(slot)} now speaks as ${v.name}${v.added ? "" : " (added to your ElevenLabs voices)"}.`);
    } catch (e) {
      setStatus(`Could not use ${v.name}: ${errText(e)}`);
    } finally {
      setBusyId(null);
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
                disabled={busyId === v.id}
                onChange={(e) => e.target.value && void use(v, e.target.value as VoiceSlot)}
              >
                <option value="">{busyId === v.id ? "Adding…" : "Use as…"}</option>
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
