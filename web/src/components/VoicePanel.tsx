import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getVoiceSettings, listVoices, saveVoiceSettings, speakLine, transcribe, voiceTurn, type VoiceLanguages } from "../api";
import { startRecording, type Recording } from "../recorder";
import type { Mode, PackInput, TtsProvider, VoiceChoice, VoiceHistoryItem, VoiceLine, VoiceSettings, VoiceSettingsReply, VoiceSpeaker } from "../types";
import { useCopyStatus } from "../useCopyStatus";
import { Button, Card, Chevron, inputClass } from "./ui";

/* Voice practice on the Go tab: run the pack as a spoken session right here.
 * Each turn is record → transcribe → one dojo-master reply → speak each line
 * in its speaker's voice (web/server/voice.ts). The learner decides when a
 * turn ends — a tap, or a pause as long as they chose — so thinking and
 * backtracking never get talked over. The session lives in this component;
 * nothing is saved. */

type Phase = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

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
  const [phase, setPhase] = useState<Phase>("idle");
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

  const settings = reply?.settings ?? null;
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const locale = reply?.locales.target ?? null;
  const nativeLocale = reply?.locales.native ?? null;
  const speakers = reply?.speakers[mode] ?? ["narrator", "character"];

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

  // Leaving the panel stops everything: no mic left open, no audio playing on.
  useEffect(() => {
    const cache = urls.current;
    return () => {
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

  /** Stop whatever is happening: the request in flight, the audio, the mic. */
  function stopAll() {
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

  /** A line's audio, fetched once and kept for replay. */
  function audioFor(key: string, line: VoiceLine, signal: AbortSignal): Promise<string> {
    let p = urls.current.get(key);
    if (!p) {
      if (!locale) return Promise.reject(new Error("no locale for the target language"));
      setChars((c) => c + line.text.length);
      p = speakLine({ speaker: line.speaker, text: line.text, locale }, signal).then((b) => URL.createObjectURL(b));
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

  /** Speak lines in order, fetching the next while the current one plays. */
  async function playLines(entryIdx: number, lines: VoiceLine[], signal: AbortSignal, from = 0, only = false) {
    setPhase("speaking");
    const last = only ? from : lines.length - 1;
    for (let i = from; i <= last; i++) {
      if (signal.aborted) return;
      const key = `${entryIdx}:${i}`;
      const url = await audioFor(key, lines[i], signal);
      if (i < last) void audioFor(`${entryIdx}:${i + 1}`, lines[i + 1], signal).catch(() => {});
      if (signal.aborted) return;
      setPlaying(key);
      await playUrl(url, signal);
    }
    setPlaying(null);
  }

  async function runTurn(message: string) {
    if (!settingsRef.current) return;
    setError(null);
    setNotice(null);
    const before = entriesRef.current;
    const history = message ? [...before, { role: "learner" as const, text: message }] : before;
    setSession(history);
    const ctrl = freshCtrl();
    setPhase("thinking");
    try {
      const r = await voiceTurn({ mode, pack, history: before, message }, ctrl.signal);
      const idx = history.length;
      setSession([...history, { role: "master", lines: r.lines }]);
      await playLines(idx, r.lines, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setPhase("idle");
      const s = settingsRef.current;
      if (s?.handsFree && s.turn === "pause") void startListening();
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e)) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  async function startListening() {
    const s = settingsRef.current;
    if (!s || recRef.current) return;
    // Talking over the dojo master is allowed: it stops them.
    ctrlRef.current?.abort();
    audioRef.current?.pause();
    setPlaying(null);
    setError(null);
    setNotice(null);
    try {
      recRef.current = await startRecording({
        silenceMs: s.turn === "pause" ? s.silenceMs : null,
        onLevel: setLevel,
        onAutoStop: (why) => void finishListening(why),
      });
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      setError(`Could not open the microphone: ${errText(e)}`);
    }
  }

  async function finishListening(why: "tap" | "pause" | "max" | "idle") {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setLevel(0);
    setPhase("transcribing");
    try {
      const { wav, spoke } = await rec.stop();
      if (why === "idle" || (!spoke && why !== "tap")) {
        setPhase("idle");
        setNotice("Didn't hear anything — tap Talk when you're ready.");
        return;
      }
      const ctrl = freshCtrl();
      const { text } = await transcribe(wav, [locale, nativeLocale].filter((l): l is string => !!l), ctrl.signal);
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
      await runTurn(text);
    } catch (e) {
      if (isAbort(e)) return;
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
    const ctrl = freshCtrl();
    try {
      await playLines(entryIdx, lines, ctrl.signal, lineIdx, true);
    } catch (e) {
      if (!ctrl.signal.aborted && !isAbort(e)) setError(errText(e));
    } finally {
      if (!ctrl.signal.aborted) setPhase("idle");
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

  // Space toggles the mic (outside text fields and buttons, where it types or
  // clicks). Re-bound each render so it sees the current phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable]") || t.isContentEditable)) return;
      if (!entriesRef.current.length) return;
      e.preventDefault();
      if (phase === "recording") void finishListening("tap");
      else if (phase === "idle" || phase === "speaking") void startListening();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const provider = settings?.tts ?? "elevenlabs";
  const ttsReady = !!reply?.configured[provider];
  const sttReady = !!settings && !!reply?.configured[settings.stt];
  const voiceSet = (settings && locale ? settings.voices[provider]?.[locale] : undefined) ?? {};
  // A narrator voice is required even for macOS: the system default voice is
  // the Mac's own language, which would read Spanish with an English accent.
  // Until one is set the settings stay open, and the pickers fill it in.
  const voicesReady = !!voiceSet.narrator;
  const canStart = !!settings && !!locale && ttsReady && voicesReady;
  const started = entries.length > 0;
  const busy = phase === "thinking" || phase === "transcribing";

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
        <SettingsBlock reply={reply} settings={settings} locale={locale} speakers={speakers} onChange={update} />
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
                    <span className="w-20 shrink-0 pt-0.5 text-sm text-fg-3 sm:text-xs">{SPEAKER_LABEL[l.speaker]}</span>
                    <span className="flex-1 text-fg">{l.text}</span>
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
              <Button variant="primary" className="px-5 py-2.5 text-base" onClick={() => void startListening()} disabled={!sttReady || busy} title={sttReady ? "Space also works" : "Set up a speech-to-text provider first"}>
                Talk
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

function transcriptText(entries: VoiceHistoryItem[]): string {
  return entries
    .map((m) => (m.role === "learner" ? `Me: ${m.text}` : m.lines.map((l) => `${SPEAKER_LABEL[l.speaker]}: ${l.text}`).join("\n")))
    .join("\n\n");
}

/* ------------------------------- settings ------------------------------- */

function SettingsBlock({
  reply,
  settings,
  locale,
  speakers,
  onChange,
}: {
  reply: VoiceSettingsReply;
  settings: VoiceSettings;
  locale: string | null;
  speakers: VoiceSpeaker[];
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
        <VoicePickers provider={settings.tts} locale={locale} speakers={speakers} settings={settings} onChange={onChange} />
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

/** One voice select per speaker, from the provider's list for the target
 *  locale. Speakers without a voice get distinct defaults the first time the
 *  list loads, natives first, so a fresh setup can start right away. */
function VoicePickers({
  provider,
  locale,
  speakers,
  settings,
  onChange,
}: {
  provider: TtsProvider;
  locale: string;
  speakers: VoiceSpeaker[];
  settings: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
}) {
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = settings.voices[provider]?.[locale] ?? {};

  useEffect(() => {
    const ctrl = new AbortController();
    setVoices(null);
    setError(null);
    listVoices(provider, locale, ctrl.signal).then(
      (r) => setVoices(r.voices),
      (e) => !ctrl.signal.aborted && setError(errText(e)),
    );
    return () => ctrl.abort();
  }, [provider, locale]);

  const setVoice = useCallback(
    (patch: Partial<Record<VoiceSpeaker, string>>) => {
      const byLocale = { ...(settings.voices[provider] ?? {}) };
      byLocale[locale] = { ...(byLocale[locale] ?? {}), ...patch };
      onChange({ voices: { ...settings.voices, [provider]: byLocale } });
    },
    [settings.voices, provider, locale, onChange],
  );

  // First load with gaps: fill them with distinct voices, natives first.
  useEffect(() => {
    if (!voices?.length) return;
    const unset = speakers.filter((s) => !current[s]);
    if (!unset.length) return;
    const taken = new Set(Object.values(current));
    const pool = voices.filter((v) => !taken.has(v.id));
    const patch: Partial<Record<VoiceSpeaker, string>> = {};
    unset.forEach((s, i) => {
      const v = pool[i] ?? voices[0];
      if (v) patch[s] = v.id;
    });
    setVoice(patch);
    // Only when the list arrives: a later manual change is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices]);

  if (error) return <p className="text-sm text-err">Could not list voices: {error}</p>;
  if (!voices) return <p className="text-sm text-fg-3">Loading voices…</p>;
  if (!voices.length) {
    return (
      <p className="text-sm text-warn">
        {provider === "system"
          ? `No macOS voice for ${locale} is installed. Add one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.`
          : provider === "elevenlabs"
            ? "Your ElevenLabs account has no voices yet. Add some from the Voice Library at elevenlabs.io (search by language and accent), then reopen these settings."
            : `Azure has no voices for ${locale}.`}
      </p>
    );
  }
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
    <div className="grid gap-3 sm:grid-cols-3" data-testid="voice-pickers">
      {speakers.map((s) => (
        <label key={s} className="flex flex-col gap-1 text-sm text-fg-2">
          {SPEAKER_LABEL[s]} voice
          <select className={inputClass} value={current[s] ?? ""} onChange={(e) => setVoice({ [s]: e.target.value })}>
            {!current[s] && <option value="">Choose…</option>}
            {natives.length > 0 && <optgroup label={`Speaks ${locale}`}>{natives.map(option)}</optgroup>}
            {others.length > 0 && <optgroup label={natives.length ? "Other voices" : "Voices"}>{others.map(option)}</optgroup>}
            {current[s] && !voices.some((v) => v.id === current[s]) && <option value={current[s]}>{current[s]} (saved)</option>}
          </select>
        </label>
      ))}
      {provider === "elevenlabs" && natives.length === 0 && (
        <p className="text-sm text-fg-3 sm:col-span-3 sm:text-xs">
          None of your ElevenLabs voices is tagged as a native {locale} speaker. Add native voices from the Voice Library for the best accent.
        </p>
      )}
    </div>
  );
}
