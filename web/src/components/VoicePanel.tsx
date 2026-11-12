import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import {
  ApiError, addLibraryVoice, getCast, getVoiceSettings, listVoices, saveVoiceSettings, searchLibrary, speakLine, transcribe, voiceTurn, type VoiceLanguages,
} from "../api";
import { startRecording, type Recording } from "../recorder";
import { Mochi, SpeakerCritter, type MochiMood } from "./Mascots";
import { Glossed } from "./Glossed";
import { SessionTimeline } from "./SessionTimeline";
import { haystack, isSentence, layout, mightMatch, sentenceGlosses } from "../gloss";
import type {
  LibrarySort, LibraryVoice, Mode, PackInput, TtsProvider, VoiceChoice, VoiceGender, VoiceHistoryItem, VoiceLine, VoiceSegment, VoiceSettings,
  VoiceAge, VoiceCastNote, VoiceCastReply, VoiceGloss, VoicePlanItem, VoiceSettingsReply, VoiceSlot, VoiceSpeaker,
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
/** How long a mid-session voice draw may take before it counts as failed. */
const CAST_TIMEOUT_MS = 10_000;
const HELD_NOTICE = "Your words to the dojo master are waiting above the box.";
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
  // The control that opened the definition, so closing it from the
  // keyboard (× or Escape) puts focus back there, not on the page.
  const pickOpener = useRef<HTMLElement | null>(null);
  const pick = useCallback((at: string, gloss: VoiceGloss) => {
    pickOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setPicked((p) => (p?.at === at && p.gloss.term === gloss.term ? null : { at, gloss }));
  }, []);
  const closePick = useCallback((refocus = false) => {
    setPicked(null);
    const to = pickOpener.current;
    pickOpener.current = null;
    if (refocus && to?.isConnected) to.focus();
  }, []);
  // Escape closes an open definition from the transcript (its opener, its
  // card) or with nothing focused, never from the answer box or another
  // field, where it would pull focus away mid-typing. Not while an input
  // method is composing (Escape cancels the composition), and not when
  // something else (the profile popover) already handled it.
  useEffect(() => {
    if (!picked || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const t = e.target;
      const inTranscript = t instanceof Element && !!t.closest('[data-testid="voice-transcript"]');
      if (!inTranscript && t !== document.body && t !== document.documentElement) return;
      e.preventDefault();
      closePick(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, active, closePick]);
  // Replay reads the session's latest state; the transcript gets a stable
  // handle to it so its memo holds.
  const replayRef = useRef<(i: number, j: number, lines: VoiceLine[]) => Promise<unknown>>(async () => {});
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
  // A status line, sometimes with one thing to do about it (hear a reply
  // that arrived while Go was hidden, send a request that waited).
  // Words for the dojo master that came back while Go was hidden, with a
  // practice answer already drafted in the box: kept apart (a chip above the
  // box) until sent or dismissed, never folded into the draft.
  const [heldRequest, setHeldRequest] = useState<string | null>(null);
  // The header's voices line, opened past its two lines on a phone.
  const [castOpen, setCastOpen] = useState(false);
  // Whether the cast line is cut off at two lines on a phone (only then is
  // its "more" toggle shown), measured after layout.
  const [castClamps, setCastClamps] = useState(false);
  const castLineRef = useRef<HTMLSpanElement | null>(null);
  // While a line waits for its speaker's voice to be drawn: nothing is
  // audible yet, so the status says so and Mochi isn't shown talking.
  const [findingVoice, setFindingVoice] = useState(false);
  // Which wait owns "Finding a voice…": only the owner clears it, so a late
  // wait finishing can't clear a newer one's, and Stop clears it outright.
  const findingOwner = useRef<object | null>(null);
  const [notice, setNoticeState] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const setNotice = (text: string | null, action?: { label: string; run: () => void }) => setNoticeState(text ? { text, action } : null);
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
  const toolbarRef = useRef<HTMLDivElement | null>(null);
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
    if (el) fitComposer(el);
  }, [composer, direct, hasEntries, reviewOn]);
  // …and when its width changes (Talk becomes Cancel + Done, a resize, a
  // phone turned sideways): the same text may need another line.
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitComposer(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasEntries]);
  // The phase as the async flows see it (state lags a render behind).
  const phaseRef = useRef<Phase>("idle");
  // Talk becomes Cancel + Done while recording and back after. Keyboard
  // focus on one follows to the other, rather than dropping to the page.
  const talkRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const micFocus = useRef(false);
  useLayoutEffect(() => {
    if (!micFocus.current) return;
    if (phase === "recording") doneRef.current?.focus();
    else if (phase !== "opening" && (!document.activeElement || document.activeElement === document.body)) {
      talkRef.current?.focus();
      micFocus.current = false;
    }
  }, [phase]);

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
  // meter re-renders many times a second while recording. Glosses only grow
  // during a session (the first wording of a term wins, sessionGlosses), so
  // each line remembers the glosses found in it and tests only the ones added
  // since (a substring check, mightMatch); it is laid out again only when one
  // of them is in it. A new turn then costs its own lines plus a few
  // substring checks per older line, not a layout of the whole session.
  const trCache = useRef(new Map<VoiceHistoryItem, TrCacheRow>());
  const translations = useMemo(() => {
    const loc = locale ?? undefined;
    const next = new Map<VoiceHistoryItem, TrCacheRow>();
    const out = entries.map((m) => {
      if (m.role !== "master") return [] as LineTranslation[];
      let c = trCache.current.get(m);
      if (!c || c.first !== glosses[0] || c.seen > glosses.length || c.locale !== loc) {
        c = {
          first: glosses[0],
          seen: 0,
          locale: loc,
          lines: m.lines.map((l) => {
            const texts = (l.segments ?? []).filter((g) => g.lang === "target").map((g) => g.text);
            return { texts, hays: texts.map((t) => haystack(t, loc)), hits: [] as VoiceGloss[], tr: null as LineTranslation };
          }),
        };
      }
      if (c.seen < glosses.length) {
        const fresh = glosses.slice(c.seen);
        for (const line of c.lines) {
          const found = fresh.filter((g) => line.hays.some((h) => mightMatch(h, g, loc)));
          if (!found.length) continue;
          line.hits = [...line.hits, ...found];
          // Laid out with just the glosses that might be in it: one that isn't
          // there changes nothing, so this agrees with a layout over them all.
          const tr = sentenceGlosses(line.texts, line.hits, loc);
          // "line" when a whole sentence is in it, else the phrase(s) it
          // shows, so the button says which.
          line.tr = tr.length
            ? { gloss: tr.length === 1 ? tr[0] : { term: tr.map((t) => t.term).join(" · "), meaning: tr.map((t) => t.meaning).join(" · ") }, whole: tr.some((t) => isSentence(t, loc)) }
            : null;
        }
        c = { ...c, seen: glosses.length };
      }
      next.set(m, c);
      return c.lines.map((l) => l.tr);
    });
    trCache.current = next;
    return out;
  }, [entries, glosses, locale]);
  const anyTranslation = translations.some((ls) => ls.some(Boolean));
  // Who each voice tag is now, from the dojo master's CAST lines (the latest
  // note for a slot wins), for the header.
  const castWho = useMemo(() => latestCast(entries), [entries]);
  // The slots heard this session (and the narrator's), so the header lists
  // only the voices in play.
  const usedSlots = useMemo(() => {
    const out = new Set<string>();
    for (const e of entries) {
      if (e.role !== "master") continue;
      for (const l of e.lines) if (l.speaker !== "narrator" && l.gender) out.add(`${l.speaker}:${l.gender}`);
      for (const n of e.castNotes ?? []) out.add(n.slot);
    }
    return out;
  }, [entries]);
  // Is the cast line cut off at two lines (a phone)? Then, and only then,
  // it gets its "more" toggle. Its full height (scrollHeight, whether it is
  // clamped now or open) against two lines; again when its text or width
  // changes.
  useLayoutEffect(() => {
    const el = castLineRef.current;
    if (!el) {
      setCastClamps(false);
      return;
    }
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setCastClamps(el.scrollHeight > lh * 2 + 2);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [cast, castWho, usedSlots, castOpen, reply]);
  // Who has had which voice, by slot and name ("character:female|doña
  // carmen"), with the age it was drawn for: a character who comes back
  // gets their own voice again with no /cast call, and a "child" the
  // provider can only match with a young voice isn't asked for every turn.
  // `holder` is who each slot's voice belongs to now; `drawFails` caps the
  // redraws of one person whose search keeps failing.
  const heldBy = useRef(new Map<string, HeldVoice>());
  const holder = useRef(new Map<string, string>());
  const drawFails = useRef(new Map<string, number>());
  // Draws on their way, by person, and which cast they belong to (Restart
  // or a whole new cast moves it on, and an older draw's answer is dropped).
  const drawing = useRef(new Map<string, Promise<void>>());
  // The latest draw by slot: a second person's draw for the same tag waits
  // for the first, so it can steer clear of the voice that one got.
  const slotDraws = useRef(new Map<string, Promise<void>>());
  // A retry after a failed or timed-out draw runs in the background (lines
  // play in the voice in use meanwhile); its voice waits here and is taken
  // up at the next turn (recast), so a voice never changes mid-turn.
  const retrying = useRef(new Map<string, Promise<void>>());
  const deferred = useRef(new Map<string, { slot: string; held: HeldVoice }>());
  const castEpoch = useRef(0);
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

  // Another tab opened: the session stays (Go is only hidden), the dojo
  // master stops talking and the mic closes. Work already paid for is kept:
  // a turn on its way lands in the transcript without playing (runTurn), and
  // a transcription lands in the box instead of being sent (finishListening).
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    if (active) return;
    const p = phaseRef.current;
    if (p === "recording" || p === "opening") {
      stopAll();
      setNotice("The recording stopped when you left Go — tap the wave to try again.");
    } else if (p === "speaking") stopAll();
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
    findingOwner.current = null;
    setFindingVoice(false);
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

  /** Wait for a voice draw with "Finding a voice…" showing, until the draw
   *  lands or `signal` aborts (Stop, Restart, a new turn): a draw that hangs
   *  never holds playback or the status. */
  async function waitForDraw(draw: Promise<void>, signal: AbortSignal) {
    const token = {};
    findingOwner.current = token;
    setFindingVoice(true);
    let onAbort = () => {};
    try {
      await Promise.race([
        draw,
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (findingOwner.current === token) {
        findingOwner.current = null;
        setFindingVoice(false);
      }
    }
  }

  function freshCtrl() {
    ctrlRef.current?.abort();
    const c = new AbortController();
    ctrlRef.current = c;
    return c;
  }

  /** One segment's audio, fetched once and kept for replay. Each segment is
   *  said in its own language (target or native) by `who`'s voice (the
   *  line's slot in this session's cast when not given). The cache key
   *  carries the voice, so a clip made before a voice was redrawn is never
   *  replayed in place of the new one. */
  function audioFor(base: string, line: VoiceLine, seg: VoiceSegment, signal: AbortSignal, who?: SpeakAs, retry = false): Promise<string> {
    const as = who ?? { voice: castVoiceFor(castRef.current, line), fallback: castFallbackFor(castRef.current, line) };
    const key = `${base}@${as.voice ?? ""}`;
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
        { speaker: line.speaker, gender: line.gender ?? null, text: seg.text, locale, lang: seg.lang, nativeLocale: nativeLocale ?? undefined, voice: as.voice, fallback: as.fallback, provider: castRef.current?.provider },
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
      if (isAbort(e) && !signal.aborted && !retry) return audioFor(base, line, seg, signal, as, true);
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

  /** Who says a line of entry `entryIdx`: the person its slot's latest CAST
   *  note names as of that entry (so a replay of an old line is still that
   *  person, not whoever has the tag now), or undefined when the dojo master
   *  never said. */
  function personFor(notes: Record<string, VoiceCastNote>, line: VoiceLine): string | undefined {
    const slot = castSlotFor(castRef.current, line);
    const n = slot ? notes[slot] : undefined;
    return n ? whoKey(n) : undefined;
  }

  /** The voice (and refusal fallback) a line is said in: its person's own,
   *  else its slot's in this session's cast. */
  function speakAs(person: string | undefined, line: VoiceLine): SpeakAs {
    const held = person ? heldBy.current.get(person) : undefined;
    const cur = castRef.current;
    if (held) return { voice: held.voice.id, fallback: held.fallback ?? castFallbackFor(cur, line) };
    return { voice: castVoiceFor(cur, line), fallback: castFallbackFor(cur, line) };
  }

  /** Speak lines in order, segment by segment, fetching the next segment
   *  while the current one plays. A line from before segments existed (or
   *  with none) is spoken whole as the target language. A line whose person
   *  is having a voice drawn waits for it (whichever way it was started: a
   *  turn, ▶, or "Play the reply"), and isn't fetched ahead in the old one. */
  async function playLines(entryIdx: number, lines: VoiceLine[], signal: AbortSignal, from = 0, only = false) {
    const notes = latestCast(entriesRef.current.slice(0, entryIdx + 1));
    const pending = (line: VoiceLine) => {
      const person = personFor(notes, line);
      return person ? drawing.current.get(person) : undefined;
    };
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
      // A draw never rejects (recast catches), and a new one may start
      // while waiting (a second draw for the same person): wait them out.
      for (let w = pending(cur.line); w; w = pending(cur.line)) {
        await waitForDraw(w, signal);
        if (signal.aborted) return;
      }
      const url = await audioFor(cur.key, cur.line, cur.seg, signal, speakAs(personFor(notes, cur.line), cur.line));
      const next = queue[q + 1];
      if (next && !pending(next.line)) void audioFor(next.key, next.line, next.seg, signal, speakAs(personFor(notes, next.line), next.line)).catch(() => {});
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
      // The target language changed mid-session too (Go stays mounted while
      // the learner changes it on another tab): the old voices speak the old
      // locale. A redraw keeps the ages the dojo master asked for.
      if (locale && (!castRef.current || castRef.current.provider !== settingsRef.current.tts || castRef.current.locale !== locale)) {
        const wanted = latestCast(before);
        const ages = Object.fromEntries(Object.values(wanted).map((n) => [n.slot, n.age]));
        const next = await getCast({ mode, locale, units: pack.units, ...(Object.keys(ages).length ? { ages } : {}) }, ctrl.signal);
        if (ctrl.signal.aborted || gen !== genRef.current) return;
        castEpoch.current += 1;
        drawing.current.clear();
        slotDraws.current.clear();
        retrying.current.clear();
        deferred.current.clear();
        castRef.current = next;
        setCast(next);
        // The old voices belong to another provider or locale: forget them,
        // and give the people already in the scene the new ones.
        heldBy.current.clear();
        holder.current.clear();
        drawFails.current.clear();
        for (const n of Object.values(wanted)) {
          const v = next.cast[n.slot];
          if (!v) continue;
          holder.current.set(n.slot, whoKey(n));
          heldBy.current.set(whoKey(n), { voice: v, fallback: next.fallbacks?.[n.slot], asked: n.age });
        }
      }
      const r = await voiceTurn({ mode, pack, history: before, message, narratorGender: castRef.current?.narratorGender }, ctrl.signal);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      const idx = history.length;
      const notes = r.castNotes ?? [];
      setSession([
        ...history,
        { role: "master", lines: r.lines, ...(r.glosses?.length ? { glosses: r.glosses } : {}), ...(r.choices?.length ? { choices: r.choices } : {}), ...(r.stage ? { stage: r.stage } : {}), ...(notes.length ? { castNotes: notes } : {}) },
      ]);
      if (r.plan?.length) setPlan(r.plan);
      // Someone new in the scene (or back in it): give their tag a voice of
      // the right age before they speak. Every slot's latest note across
      // the session is checked, not only this turn's, so a redraw that was
      // cut off is tried again. Lines before the first one in a slot being
      // redrawn play meanwhile.
      recast(latestCast(entriesRef.current));
      // The learner left Go while this turn was on its way: keep it, don't
      // start talking on a hidden tab.
      if (!activeRef.current) {
        setPhase("idle");
        const lines = r.lines;
        // Played to the end, it hands over as a turn does: hands-free opens
        // the mic.
        setNotice("A reply arrived while you were away.", {
          label: "▶ Play the reply",
          run: () => {
            // Never heard yet: a retry that landed meanwhile applies to it.
            applyDeferred();
            void replay(idx, 0, lines, false).then((done) => {
              if (done) listenAgain();
            });
          },
        });
        return;
      }
      await playLines(idx, r.lines, ctrl.signal, 0, false);
      if (ctrl.signal.aborted || gen !== genRef.current) return;
      setPhase("idle");
      listenAgain();
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e) || gen !== genRef.current) return;
      setPhase("idle");
      setError(errText(e));
    }
  }

  /** Give each voice tag the voice of whoever the dojo master says speaks
   *  with it now (its CAST lines, `wanted`): their own voice again when they
   *  were in the scene before, the current one when its age fits, and else a
   *  Random voice drawn for their age (only where the provider labels ages:
   *  ElevenLabs' library does; macOS and Azure mostly don't). Slots the
   *  learner set and the narrator gender not in use are left alone. A draw
   *  is kept in `drawing` by person until it's done, and every playback of
   *  that person's lines waits for it (playLines). The draw isn't cut off by
   *  Stop or by leaving Go (the call is free, and its voice is wanted next
   *  time either way); only Restart or a new cast drops its answer. When it
   *  lands, the voice is that person's (heldBy), and the slot's only if the
   *  dojo master still names them for it then. A failed draw keeps the old
   *  voice, held only tentatively, so the next turn tries again (twice at
   *  most per person). */
  /** Retries that landed since the last turn started: their voices start
   *  now. Called as a turn begins (recast), and before a reply that arrived
   *  while away is first played, which hasn't started either. */
  function applyDeferred() {
    const cur = castRef.current;
    if (!cur || !deferred.current.size) return;
    let cast = cur.cast;
    let fallbacks = cur.fallbacks;
    for (const [key, d] of deferred.current) {
      heldBy.current.set(key, d.held);
      if (holder.current.get(d.slot) === key && cast[d.slot]) {
        cast = { ...cast, [d.slot]: d.held.voice };
        if (d.held.fallback) fallbacks = { ...fallbacks, [d.slot]: d.held.fallback };
      }
    }
    deferred.current.clear();
    castRef.current = { ...cur, cast, ...(fallbacks ? { fallbacks } : {}) };
    setCast(castRef.current);
  }

  function recast(wanted: Record<string, VoiceCastNote>) {
    applyDeferred();
    const cur = castRef.current;
    if (!cur || !locale) return;
    const labelled = Object.values(cur.cast).some((v) => v.age);
    const set = settingsRef.current?.voices[cur.provider]?.[cur.locale] ?? {};
    let cast = cur.cast;
    let fallbacks = cur.fallbacks;
    const draw: Record<string, VoiceAge> = {};
    const keys: Record<string, string> = {};
    for (const n of Object.values(wanted)) {
      const slot = n.slot;
      if (!cast[slot] || set[slot as VoiceSlot]) continue;
      if (slot.startsWith("narrator:") && slot !== `narrator:${cur.narratorGender}`) continue;
      const key = whoKey(n);
      // Already being drawn for (an earlier turn's draw still on its way):
      // their lines wait for that one, and it takes the slot when it lands.
      if (drawing.current.get(key) || retrying.current.get(key)) continue;
      const held = heldBy.current.get(key);
      if (holder.current.get(slot) !== key && held) {
        // Back in the scene: their voice again.
        cast = { ...cast, [slot]: held.voice };
        if (held.fallback) fallbacks = { ...fallbacks, [slot]: held.fallback };
        holder.current.set(slot, key);
      }
      const now = cast[slot];
      const fits = !labelled || now.age === n.age || (held?.voice.id === now.id && held.asked === n.age && !held.tentative) || (drawFails.current.get(key) ?? 0) >= 2;
      if (fits) {
        holder.current.set(slot, key);
        if (held?.voice.id !== now.id || held.tentative) heldBy.current.set(key, { voice: now, fallback: fallbacks?.[slot], asked: n.age });
        continue;
      }
      // Until the draw lands (or if it fails), this person speaks with the
      // slot's voice as it is now, even if someone else takes the tag.
      if (!held) heldBy.current.set(key, { voice: now, fallback: fallbacks?.[slot], asked: n.age, tentative: true });
      holder.current.set(slot, key);
      draw[slot] = n.age;
      keys[slot] = key;
    }
    if (cast !== cur.cast || fallbacks !== cur.fallbacks) {
      castRef.current = { ...cur, cast, ...(fallbacks ? { fallbacks } : {}) };
      setCast(castRef.current);
    }
    // First draws and retries go out separately: a retry (this person's
    // draw failed before) doesn't hold their lines, but a first draw does,
    // and one person's retry must not make another's first draw a retry.
    const all = Object.keys(draw);
    const isRetry = (x: string) => (drawFails.current.get(keys[x]) ?? 0) > 0;
    const fresh = all.filter((x) => !isRetry(x));
    const again = all.filter(isRetry);
    const first = fresh.length ? startDraw(fresh, false, draw, keys) : undefined;
    // The retry goes after the first draw, so its `avoid` holds the voice
    // the first draw got (two concurrent draws could pick the same voice).
    // A retry doesn't hold playback, so waiting costs nothing.
    if (again.length) startDraw(again, true, draw, keys, first);
  }

  /** One /cast for `slotsToDraw` (see recast). */
  function startDraw(slotsToDraw: string[], retry: boolean, draw: Record<string, VoiceAge>, keys: Record<string, string>, after?: Promise<void>): Promise<void> | undefined {
    if (!locale) return undefined;
    const epoch = castEpoch.current;
    const failed = (slot: string) => drawFails.current.set(keys[slot], (drawFails.current.get(keys[slot]) ?? 0) + 1);
    // One deadline for the whole draw, the wait behind earlier draws for
    // the same tags included: lines never wait longer than CAST_TIMEOUT_MS.
    // (A retry queued after a first draw starts its clock once that lands.)
    let deadline = Date.now() + CAST_TIMEOUT_MS;
    const left = () => deadline - Date.now();
    // Draws already out for these tags (someone else's): this one goes after
    // them, one at a time per tag, so it knows the voices they got.
    const ahead = slotsToDraw.map((x) => slotDraws.current.get(x)).filter((p): p is Promise<void> => !!p);
    const run = (async () => {
      try {
        if (after) {
          await after;
          deadline = Date.now() + CAST_TIMEOUT_MS;
        }
        if (ahead.length) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<"late">((res) => (timer = setTimeout(() => res("late"), Math.max(0, left()))));
          const won = await Promise.race([Promise.all(ahead), late]);
          clearTimeout(timer);
          if (won === "late") throw new DOMException("the draw ahead took too long", "TimeoutError");
        }
        if (castEpoch.current !== epoch || !castRef.current) return;
        if (left() <= 0) throw new DOMException("no time left for the draw", "TimeoutError");
        const base = castRef.current;
        // Taken: every other slot's voice and fallback, and the voices other
        // people have had with these tags (a draw that landed for someone
        // since gone, the one just before this). The drawn voice, and the
        // fallback the server names, must differ from them.
        const others = Object.keys(base.cast).filter((x) => !slotsToDraw.includes(x));
        const mine = new Set(slotsToDraw.map((x) => keys[x]));
        // A retry that landed for someone else on these tags (waiting in
        // `deferred` for the next turn) counts too.
        const theirs = [
          ...[...heldBy.current.entries()].filter(([k]) => !mine.has(k) && slotsToDraw.some((x) => k.startsWith(`${x}|`))).map(([, h]) => h),
          ...[...deferred.current.entries()].filter(([k, d]) => !mine.has(k) && slotsToDraw.includes(d.slot)).map(([, d]) => d.held),
        ].flatMap((h) => [h.voice.id, h.fallback]);
        const avoid = [...new Set([...others.map((x) => base.cast[x].id), ...others.map((x) => base.fallbacks?.[x]), ...theirs].filter((v): v is string => !!v))].slice(0, 20);
        // A draw that hangs counts as failed after CAST_TIMEOUT_MS: the voice
        // in use stays and the next turn retries (within drawFails).
        const ages = Object.fromEntries(slotsToDraw.map((x) => [x, draw[x]]));
        const r = await getCast({ mode, locale, units: pack.units, ages, slots: slotsToDraw, avoid }, AbortSignal.timeout(Math.max(1, left())));
        if (castEpoch.current !== epoch || !castRef.current) return;
        const live = castRef.current;
        const nextCast = { ...live.cast };
        const nextFallbacks = { ...(live.fallbacks ?? {}) };
        // Who each tag is now, as the transcript says (a later turn may have
        // handed it to someone else while this draw was out).
        const latest = latestCast(entriesRef.current);
        for (const slot of slotsToDraw) {
          const v = r.cast[slot];
          // Left out: the server found nothing for that age. The person
          // keeps their tentative voice, and the next turn asks again.
          if (!v) {
            failed(slot);
            continue;
          }
          const fallback = r.fallbacks?.[slot] ?? heldBy.current.get(keys[slot])?.fallback ?? live.fallbacks?.[slot];
          if (retry) {
            // Taken up at the next turn, not in the middle of this one.
            deferred.current.set(keys[slot], { slot, held: { voice: v, fallback, asked: draw[slot] } });
            continue;
          }
          heldBy.current.set(keys[slot], { voice: v, fallback, asked: draw[slot] });
          // The tag is someone else's now: the voice waits for this
          // person's return.
          const n = latest[slot];
          if (!n || whoKey(n) !== keys[slot]) continue;
          nextCast[slot] = v;
          if (fallback) nextFallbacks[slot] = fallback;
          holder.current.set(slot, keys[slot]);
        }
        castRef.current = { ...live, cast: nextCast, ...(Object.keys(nextFallbacks).length ? { fallbacks: nextFallbacks } : {}) };
        setCast(castRef.current);
      } catch (e) {
        // A timeout (TimeoutError, not AbortError) is a failed draw.
        if (isAbort(e) || castEpoch.current !== epoch) return;
        for (const slot of slotsToDraw) failed(slot);
        // Quietly: the voice in use stays, and a notice with an action (a
        // reply to play, words to send) must not be replaced by this.
        // Hands-free, the mic opens right after the turn and would clear it
        // at once, so it isn't shown at all there.
        const st = settingsRef.current;
        if (!(st?.handsFree && st.turn === "pause")) setNoticeState((was) => was ?? { text: "Couldn't find a better-matched voice; keeping this one." });
      }
    })();
    const by = retry ? retrying.current : drawing.current;
    for (const slot of slotsToDraw) {
      by.set(keys[slot], run);
      slotDraws.current.set(slot, run);
    }
    void run.then(() => {
      for (const slot of slotsToDraw) {
        if (by.get(keys[slot]) === run) by.delete(keys[slot]);
        if (slotDraws.current.get(slot) === run) slotDraws.current.delete(slot);
      }
    });
    return run;
  }

  /** Hands-free: once the dojo master has finished, the mic opens again. */
  function listenAgain() {
    const s = settingsRef.current;
    if (s?.handsFree && s.turn === "pause" && activeRef.current) void startListening();
  }

  /** Keyboard focus after a control that is about to go (a notice's action,
   *  the held request's Send): Stop while the dojo master thinks or talks,
   *  so Space can't open the mic over the reply, else Talk. */
  function focusAfterAction() {
    const p = phaseRef.current;
    const to = p === "speaking" || p === "thinking" ? toolbarRef.current?.querySelector<HTMLElement>('[data-testid="voice-stop"]') : talkRef.current;
    to?.focus();
  }

  async function startListening(toMaster = false) {
    const s = settingsRef.current;
    // "opening" covers the await on the mic: a second Space or a double tap
    // while the permission prompt is up must not open a second recording.
    if (!s || recRef.current || phaseRef.current === "opening") return;
    // Talking over the dojo master is allowed: it stops them.
    stopAll();
    const el = document.activeElement;
    micFocus.current = !!el && (el === talkRef.current || el === doneRef.current || !!el.closest?.('[data-testid="voice-cancel"]'));
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
      // Left Go while it was transcribing: the words wait in the box rather
      // than starting a turn on a hidden tab.
      const away = !activeRef.current;
      // …but a request to the dojo master doesn't join a practice answer
      // already drafted there (the tag would cover both): it waits on its
      // own, one tap to send.
      if (away && toMaster && draft && !directTagRef.current) {
        setPhase("idle");
        setHeldRequest((was) => (was ? `${was} ${text}` : text));
        setNotice(HELD_NOTICE);
        return;
      }
      const intoBox = away || (settingsRef.current?.review && !(toMaster && draft && !directTagRef.current));
      if (intoBox) {
        setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text));
        if (toMaster) setDirect(true);
        setPhase("idle");
        if (away) setNotice("Your words are in the box — send them when you're ready.");
        else window.setTimeout(() => composerRef.current?.focus(), 0);
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
  function choose(label: string, byKeyboard: boolean) {
    if (!canAct) return;
    if (phase !== "idle") stopAll();
    // The choices disappear with this turn. A keyboard user's focus goes
    // somewhere that stays (Help) rather than falling to the page; a tap
    // moves no focus, since focusing the text box would pop up a phone's
    // keyboard just as the dojo master starts talking.
    if (byKeyboard) toolbarRef.current?.querySelector<HTMLElement>('[data-testid="voice-help"]')?.focus();
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
        // In the narrator's voice as it is now. Unlike a turn's lines it
        // doesn't wait for a draw still on its way: "yes?" has to be
        // instant, and a slow draw must not hold the mic. The clip is cached
        // per voice (audioFor), so a new narrator voice gets its own.
        const person = personFor(latestCast(entriesRef.current), line);
        const url = await audioFor(`ack:${castRef.current.provider}:${castRef.current.narratorGender}`, line, line.segments[0], ctrl.signal, speakAs(person, line));
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

  /** Play an entry's lines again; true when they played to the end (not
   *  stopped, failed or overtaken by something else). */
  async function replay(entryIdx: number, lineIdx: number, lines: VoiceLine[], only = true): Promise<boolean> {
    stopAll();
    setNotice(null);
    const gen = genRef.current;
    const ctrl = freshCtrl();
    let done = false;
    try {
      await playLines(entryIdx, lines, ctrl.signal, lineIdx, only);
      done = !ctrl.signal.aborted && gen === genRef.current;
    } catch (e) {
      if (!ctrl.signal.aborted && !isAbort(e) && gen === genRef.current) setError(errText(e));
    } finally {
      if (!ctrl.signal.aborted && gen === genRef.current) setPhase("idle");
    }
    return done;
  }

  function restart() {
    stopAll();
    for (const p of urls.current.values()) void p.then(URL.revokeObjectURL, () => {});
    urls.current.clear();
    // "Characters spoken" is per session; keys start from 0 again.
    counted.current.clear();
    setChars(0);
    heldBy.current.clear();
    holder.current.clear();
    drawFails.current.clear();
    drawing.current.clear();
    slotDraws.current.clear();
    retrying.current.clear();
    deferred.current.clear();
    castEpoch.current += 1;
    setDirect(false);
    // A new session draws a new cast.
    castRef.current = null;
    setCast(null);
    setSession([]);
    setPicked(null);
    setPlan([]);
    setComposer("");
    setHeldRequest(null);
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
      // Sticky only works within the session's row. The column is kept
      // short enough that, scrolled to the page's end (save and export sit
      // below the session), it still clears the top bars rather than being
      // pushed up under them; its list scrolls on its own.
      <aside className={`shrink-0 lg:sticky lg:top-(--below-bars) lg:flex lg:max-h-[calc(100dvh-var(--below-bars)-var(--below-session))] lg:flex-col ${timelineOpen ? "lg:w-60" : "lg:w-8"}`}>
        <SessionTimeline plan={plan} stage={stage} open={timelineOpen} onToggle={toggleTimeline} onJump={jump} disabled={!canAct} />
      </aside>
    )}
    <Card className="tatami flex min-w-0 flex-1 flex-col gap-4 border-line-strong/60" data-testid="voice-panel">
      {/* The buttons drop below the title on a phone rather than squeezing it. */}
      <div className="flex flex-wrap items-start gap-3">
        <Mochi size={56} className="shrink-0" mood={mochiMood(findingVoice ? "idle" : phase, started)} title={`Sensei Mochi, ${MOOD_LABEL[mochiMood(findingVoice ? "idle" : phase, started)]}`} />
        <div className="flex min-w-40 flex-1 flex-col gap-0.5 pt-1">
        <h2 className="text-xl font-semibold text-fg">Practice by voice</h2>
        {reply && (
          <span className="text-sm text-fg-3 sm:text-xs">
            {PROVIDER_LABEL[provider]}
            {locale ? ` · ${locale}` : ""}
            {chars > 0 && ` · ${chars.toLocaleString()} characters spoken`}
            {cast && Object.keys(cast.cast).length > 0 && (
              // On a phone it keeps to two lines until tapped open (a touch
              // screen has no tooltip).
              <span className="flex items-start gap-1">
                <span ref={castLineRef} id="voice-cast" className={`${castOpen ? "" : "line-clamp-2"} sm:line-clamp-none`} data-testid="voice-cast" title={`Voices this session: ${castSummary(cast, castWho, usedSlots)}. Random slots draw new voices each session; Restart draws again.`}>
                  Voices this session: {castSummary(cast, castWho, usedSlots)}
                </span>
                {castClamps && (
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1 text-fg-3 underline decoration-dotted underline-offset-2 hover:text-fg sm:hidden"
                  aria-expanded={castOpen}
                  aria-controls="voice-cast"
                  onClick={() => setCastOpen((o) => !o)}
                  data-testid="voice-cast-more"
                >
                  {castOpen ? "less" : "more"}
                </button>
                )}
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
          showTr={anyTranslation}
          onPick={pick}
          onClosePick={closePick}
          onReplay={onReplay}
        />
      )}
      {lastChoices.length > 0 && canAct && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick answers" data-testid="voice-choices">
          {lastChoices.map((c, k) => (
            <QuickButton key={`${k}:${c}`} variant="choice" onClick={(e) => choose(c, e.detail === 0)}>
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
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2" role="status" data-testid="voice-status">
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
          {phase === "speaking" && (findingVoice ? "Finding a voice…" : "Speaking…")}
          {phase === "idle" && notice && (
            <>
              <span>{notice.text}</span>
              {notice.action && (
                <QuickButton
                  onClick={() => {
                    const run = notice.action?.run;
                    setNotice(null);
                    run?.();
                    // This button is about to go: keep keyboard focus on a
                    // control that stays.
                    focusAfterAction();
                  }}
                  testid="voice-notice-action"
                >
                  {notice.action.label}
                </QuickButton>
              )}
            </>
          )}
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
          <div ref={toolbarRef} className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Quick requests">
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
            {/* Always there (aria-disabled when there's nothing to stop): a
                button that vanished once used would drop keyboard focus. */}
            <QuickButton onClick={stopAll} disabled={phase !== "speaking" && phase !== "thinking"} title="Stop the dojo master" testid="voice-stop">
              ■ Stop
            </QuickButton>
            <span className="flex-1" />
            {/* "Copy" on a phone, so Restart shares its row with Stop rather
                taking a third one. */}
            <Button variant="ghost" className="px-2 py-1" onClick={() => copy(transcriptText(entries))} aria-label={copyStatus === "copied" ? "Copied" : "Copy transcript"}>
              {copyStatus === "copied" ? "Copied" : (
                // One child, so the button's gap never lands inside the label.
                <span>
                  Copy<span className="hidden sm:inline"> transcript</span>
                </span>
              )}
            </Button>
            <Button variant="ghost" className="px-2 py-1" onClick={restart}>
              Restart
            </Button>
          </div>
          {heldRequest && (
            <div className="flex flex-wrap items-center gap-1.5 self-start rounded-2xl bg-accent-soft py-1 pr-1 pl-3 text-sm text-fg" data-testid="voice-held-request">
              <span className="min-w-0 [overflow-wrap:anywhere]">💬 To the dojo master: “{heldRequest}”</span>
              <QuickButton
                onClick={() => {
                  const text = heldRequest;
                  if (!text || !canAct) return;
                  if (phase !== "idle") stopAll();
                  setHeldRequest(null);
                  void runTurn(`${DIRECT} ${text}`);
                  // The chip goes: focus to Stop while the turn runs.
                  focusAfterAction();
                }}
                disabled={!canAct}
                testid="voice-held-send"
              >
                Send them
              </QuickButton>
              <button
                type="button"
                className="rounded-full px-1.5 text-fg-3 hover:bg-raised hover:text-fg"
                onClick={(e) => {
                  setHeldRequest(null);
                  setNoticeState((was) => (was?.text === HELD_NOTICE ? null : was));
                  // A keyboard user's focus goes to the box (the chip is
                  // gone); a tap moves none, so a phone's keyboard doesn't
                  // pop up (as choose() does). detail is 0 for Enter/Space.
                  if (e.detail === 0) composerRef.current?.focus();
                }}
                aria-label="Drop these words to the dojo master"
                title="Drop them"
              >
                ×
              </button>
            </div>
          )}
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
                <RoundButton ref={doneRef} onClick={() => void finishListening("tap")} label={settings?.review ? "Done — put my words in the box" : "Done — send what I said"} testid="voice-done">
                  <StopIcon />
                </RoundButton>
              </>
            ) : (
              <RoundButton ref={talkRef} onClick={() => void startListening()} disabled={!sttReady || busy} label={sttReady ? "Talk — Space also works" : "Set up a speech-to-text provider first"} testid="voice-talk">
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

/** A voice someone in the scene has had: the cast entry, its fallback, and
 *  the age it was drawn (or kept) for. */
/** A person's voice. `tentative`: the slot's voice when their draw began,
 *  used until it lands (or after it fails), but not yet theirs for good. */
type HeldVoice = { voice: VoiceCastReply["cast"][string]; fallback?: string; asked: VoiceAge; tentative?: true };

/** The voice a clip is made in, and the account voice for a refusal. */
type SpeakAs = { voice?: string; fallback?: string };

/** Each slot's latest CAST note across the session: who speaks with that
 *  voice tag now. */
function latestCast(entries: VoiceHistoryItem[]): Record<string, VoiceCastNote> {
  const out: Record<string, VoiceCastNote> = {};
  for (const e of entries) if (e.role === "master") for (const n of e.castNotes ?? []) out[n.slot] = n;
  return out;
}

/** A person's name from a CAST note ("Doña Carmen, the fruit vendor" →
 *  "Doña Carmen"). */
const whoName = (who: string) => who.split(",")[0].trim();

/** One person in one slot: "character:female|doña carmen". */
const whoKey = (n: VoiceCastNote) => `${n.slot}|${whoName(n.who).toLocaleLowerCase()}`;

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

const AGE_LABEL: Record<VoiceAge, string> = { child: "a child", young: "young", middle: "middle-aged", old: "old" };

/** "Narrator Marlene · Character (woman) Doña Carmen, old: voice Rosa ·
 *  Character (man) Alejandro": the narrator for the gender this session
 *  uses, then the scene's voices heard so far (`used`), with who the dojo
 *  master says each one is (its CAST lines) when it has said. */
function castSummary(cast: VoiceCastReply, who: Record<string, VoiceCastNote> = {}, used?: Set<string>): string {
  const parts: string[] = [];
  const narrator = cast.cast[`narrator:${cast.narratorGender}`];
  if (narrator) parts.push(`Narrator ${narrator.name}`);
  for (const [slot, v] of Object.entries(cast.cast)) {
    const [speaker, gender] = slot.split(":");
    // Only the voices heard so far: kids mode has six slots, most unused.
    if (speaker === "narrator" || (used && !used.has(slot))) continue;
    const role = `${speaker[0].toUpperCase()}${speaker.slice(1)} (${gender === "female" ? "woman" : "man"})`;
    const n = who[slot];
    // The name only ("Doña Carmen, old"), not the whole description.
    parts.push(n ? `${role} ${[whoName(n.who), AGE_LABEL[n.age]].filter(Boolean).join(", ")}: voice ${v.name}` : `${role} ${v.name}`);
  }
  return parts.join(" · ");
}

/** Size the composer to its text (up to its max height, then it scrolls). */
function fitComposer(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
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
type TrCacheRow = {
  first: VoiceGloss | undefined;
  seen: number;
  locale: string | undefined;
  lines: { texts: string[]; hays: { text: string; low: string }[]; hits: VoiceGloss[]; tr: LineTranslation }[];
};

/** The session's transcript. Memoised: the session re-renders for things
 *  that don't touch it (the thinking counter, the composer). Each entry is
 *  a memoised row too, given only what concerns it (its own playing line
 *  and open definition, the glosses found in its text, its translations,
 *  each kept the same object while unchanged), so a new turn re-renders
 *  the new row, not every glossed line of the session again. (The
 *  translations are kept per line in VoicePanel too, and only a line that
 *  a new gloss lands in is laid out again.) It follows the
 *  session while the learner lets it: a new turn and the line being spoken
 *  are scrolled into view, until the learner scrolls away to reread.
 *  Scrolling back to the bottom, sending something or tapping ▶ follows
 *  again. Only the list's own scroll moves, never the page. */
const Transcript = memo(function Transcript({
  entries,
  plan,
  playing,
  picked,
  translations,
  glosses,
  locale,
  trLabel,
  showTr,
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
  /** Whether any line has a translation: only then is there a column for
   *  the translate buttons. */
  showTr: boolean;
  onPick: (at: string, gloss: VoiceGloss) => void;
  onClosePick: (refocus?: boolean) => void;
  onReplay: (i: number, j: number, lines: VoiceLine[]) => void;
}) {
  const olRef = useRef<HTMLOListElement | null>(null);
  const following = useRef(true);
  // Where our own last scroll left the list: a scroll event landing there is
  // ours, not the learner's, and must not stop the following.
  const ownTop = useRef<number | null>(null);
  const scrollTo = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    ownTop.current = el.scrollTop;
  };
  const onScroll = () => {
    const el = olRef.current;
    if (!el) return;
    if (ownTop.current != null && Math.abs(el.scrollTop - ownTop.current) < 2) return;
    ownTop.current = null;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const count = entries.length;
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el) return;
    // The learner's own message always comes into view: they just sent it.
    if (entries[count - 1]?.role === "learner") following.current = true;
    if (following.current) scrollTo(el, el.scrollHeight);
    // Only a new entry moves the list, not a re-render of the same ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  // A turn that landed while Go was hidden couldn't scroll a list with no
  // size: when the list is shown again, catch up if following.
  useEffect(() => {
    const el = olRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const was = height;
      height = el.clientHeight;
      if (was === 0 && height > 0 && following.current) {
        el.scrollTop = el.scrollHeight;
        ownTop.current = el.scrollTop;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el || !playing || !following.current) return;
    const row = el.querySelector<HTMLElement>(`[data-line="${playing}"]`);
    if (!row) return;
    const box = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const pad = 8;
    if (r.top < box.top + pad || r.height > box.height) scrollTo(el, el.scrollTop + r.top - box.top - pad);
    else if (r.bottom > box.bottom - pad) scrollTo(el, el.scrollTop + r.bottom - box.bottom + pad);
  }, [playing]);

  // Asking to hear a line is asking to follow it. Stable, for the rows' memo.
  const replayRef = useRef(onReplay);
  useEffect(() => {
    replayRef.current = onReplay;
  });
  const replayLine = useCallback((i: number, j: number, lines: VoiceLine[]) => {
    following.current = true;
    replayRef.current(i, j, lines);
  }, []);

  // Per row, the glosses found in its target-language text. Glosses only
  // grow during a session (the first wording of a term wins), so a row
  // tests just the ones added since it last looked, and keeps its list (the
  // same array) when none of them is in it. A new target locale starts over
  // (case folding is locale-specific), as the translations cache does.
  const glossCache = useRef(new Map<number, { m: VoiceHistoryItem; first: VoiceGloss | undefined; seen: number; list: VoiceGloss[]; locale: string | null }>());
  const rowGlosses = (m: VoiceHistoryItem, i: number): VoiceGloss[] => {
    if (m.role !== "master") return NO_GLOSSES;
    let c = glossCache.current.get(i);
    if (!c || c.m !== m || c.first !== glosses[0] || c.seen > glosses.length || c.locale !== locale) c = { m, first: glosses[0], seen: 0, list: NO_GLOSSES, locale };
    if (c.seen < glosses.length) {
      const texts = m.lines.flatMap((l) => (l.segments ?? []).filter((g) => g.lang === "target").map((g) => g.text.normalize("NFC")));
      const hays = texts.map((t) => haystack(t, locale ?? undefined));
      const found = glosses.slice(c.seen).filter((g) => texts.some((t, k) => mightMatch(hays[k], g, locale ?? undefined) && layout(t, [g], locale ?? undefined).length > 0));
      c = { ...c, seen: glosses.length, list: found.length ? [...c.list, ...found] : c.list };
    }
    glossCache.current.set(i, c);
    return c.list;
  };
  // Per row, its lines' translations, kept the same array while every
  // line's translation reads the same.
  const trCache = useRef(new Map<number, { key: string; row: LineTranslation[] }>());
  const rowTranslations = (i: number): LineTranslation[] => {
    const row = translations[i] ?? NO_TRANSLATIONS;
    const key = row.map((t) => (t ? `${t.whole ? 1 : 0}\u0001${t.gloss.term}\u0001${t.gloss.meaning}` : "")).join("\u0002");
    const c = trCache.current.get(i);
    if (c && c.key === key) return c.row;
    trCache.current.set(i, { key, row });
    return row;
  };

  return (
<ol ref={olRef} onScroll={onScroll} className="flex max-h-[min(28rem,calc(100dvh-22rem))] min-h-48 min-w-0 flex-1 lg:max-h-[max(28rem,calc(100dvh-26rem))] flex-col gap-2 overflow-y-auto rounded-2xl border border-line bg-panel p-3" aria-label="Session transcript" data-testid="voice-transcript">
  {entries.map((m, i) => {
    const mine = (at: string | null | undefined) => !!at && at.startsWith(`${i}:`);
    const jumpTo = m.role === "learner" ? jumpTarget(m.text) : null;
    return (
      <TranscriptRow
        key={i}
        m={m}
        i={i}
        jumpTitle={jumpTo != null ? planTitle(plan, jumpTo) : null}
        playing={mine(playing) ? playing : null}
        picked={mine(picked?.at) ? picked : null}
        translations={rowTranslations(i)}
        glosses={rowGlosses(m, i)}
        locale={locale}
        trLabel={trLabel}
        showTr={showTr}
        onPick={onPick}
        onClosePick={onClosePick}
        onReplay={replayLine}
      />
    );
  })}
</ol>
  );
});

const NO_GLOSSES: VoiceGloss[] = [];
const NO_TRANSLATIONS: LineTranslation[] = [];

/** One entry of the transcript: the learner's message, or a turn of the
 *  dojo master's lines. */
const TranscriptRow = memo(function TranscriptRow({
  m,
  i,
  jumpTitle,
  playing,
  picked,
  translations,
  glosses,
  locale,
  trLabel,
  showTr,
  onPick,
  onClosePick,
  onReplay,
}: {
  m: VoiceHistoryItem;
  i: number;
  /** The part a "[jump]" message went to, by its title. */
  jumpTitle: string | null;
  /** The line playing, when it's one of this entry's. */
  playing: string | null;
  /** The definition open, when it's under one of this entry's lines. */
  picked: { at: string; gloss: VoiceGloss } | null;
  translations: LineTranslation[];
  glosses: VoiceGloss[];
  locale: string | null;
  trLabel: string;
  showTr: boolean;
  onPick: (at: string, gloss: VoiceGloss) => void;
  onClosePick: (refocus?: boolean) => void;
  onReplay: (i: number, j: number, lines: VoiceLine[]) => void;
}) {
  if (m.role === "learner") {
    return (
      <li className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm text-fg">
        {CONTROL_LABEL[m.text] ? (
          <span className="text-fg-3 italic">{CONTROL_LABEL[m.text]}</span>
        ) : jumpTitle != null ? (
          <span className="text-fg-3 italic">Jumped to {jumpTitle}</span>
        ) : directText(m.text) != null ? (
          <>
            <span className="text-fg-3 italic">To the dojo master: </span>
            {directText(m.text)}
          </>
        ) : (
          m.text
        )}
      </li>
    );
  }
  return (
      <li className="flex flex-col gap-1">
        {m.lines.map((l, j) => (
          <Fragment key={j}>
          <div data-line={`${i}:${j}`} className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors ${playing === `${i}:${j}` ? "bg-kiai-soft" : ""}`}>
            <SpeakerCritter speaker={l.speaker} size={30} />
            <span className="w-16 shrink-0 pt-1.5 font-[family-name:var(--font-display)] text-xs break-words text-fg-3 sm:w-24">{lineLabel(l)}</span>
            <span className="min-w-0 max-w-[72ch] flex-1 text-fg break-words">
              {(l.segments?.length ? l.segments : [{ lang: "native" as const, text: l.text }]).map((g, k) => (
                <span key={k} className={g.lang === "target" ? "font-medium text-accent" : ""} lang={g.lang === "target" ? (locale ?? undefined) : undefined}>
                  {k > 0 && !/^[.,;:!?)\]»…]/.test(g.text) ? " " : ""}
                  {g.lang === "target" ? <Glossed text={g.text} glosses={glosses} locale={locale ?? undefined} picked={picked?.at === `${i}:${j}` ? picked.gloss : null} onPick={(gl) => onPick(`${i}:${j}`, gl)} /> : g.text}
                </span>
              ))}
            </span>
            {/* A fixed slot for the translate button, so every line's ▶
                sits in the same column whether it has one or not; none at
                all while no line has a translation. */}
            {showTr && (
            <span className="flex w-7 shrink-0 justify-center">
            {(() => {
              // The line's translation: every glossed sentence (or
              // phrase that isn't a button) in it, one tap, and the
              // keyboard's way to them.
              const tr = translations[j];
              if (!tr) return null;
              const { gloss, whole } = tr;
              const what = whole ? "this line" : "this phrase";
              return (
                <button type="button" className="-my-0.5 grid min-h-6 min-w-6 place-items-center rounded px-0.5 text-xs text-fg-3 hover:text-fg" aria-label={`${trLabel}: translate ${what}`} title={`Translate ${what}`} aria-pressed={picked?.at === `${i}:${j}` && picked.gloss.term === gloss.term} onClick={() => onPick(`${i}:${j}`, gloss)}>
                  {trLabel}
                </button>
              );
            })()}
            </span>
            )}
            {/* A 24px target (WCAG 2.5.8) around the small ▶. */}
            <button type="button" className="-my-0.5 grid size-6 min-h-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-raised hover:text-fg" aria-label="Replay line" title="Replay" onClick={() => onReplay(i, j, m.lines)}>
              ▶
            </button>
          </div>
          {/* The definition under the line, the row's full width on a phone
              (under the text column from sm up), and after the line's
              controls in the DOM, so Tab goes opener → card. Escape or ×
              from the keyboard closes it and puts focus back on its opener. */}
          {picked?.at === `${i}:${j}` && (
            <div
              className="mx-2 flex items-start gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-sm text-fg sm:ml-[8.5rem] sm:max-w-[72ch]"
              role="status"
              data-testid="voice-gloss"
            >
              <span className="min-w-0 flex-1 break-words">
                <span className="font-medium text-accent" lang={locale ?? undefined}>{picked.gloss.term}</span>
                <span className="text-fg-3"> — </span>
                {picked.gloss.meaning}
              </span>
              <button type="button" className="-my-0.5 grid size-6 min-h-6 shrink-0 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Close definition" onClick={(e) => onClosePick(e.detail === 0)}>
                ×
              </button>
            </div>
          )}
          </Fragment>
        ))}
      </li>
  );
});

/** A quick-request chip above the composer, or a check-in answer. */
function QuickButton({ onClick, disabled, title, testid, variant = "quick", children }: { onClick: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; title?: string; testid?: string; variant?: "quick" | "choice"; children: ReactNode }) {
  const look = variant === "choice"
    ? "border-accent bg-accent-soft text-fg hover:bg-accent hover:text-accent-ink"
    : "border-line bg-panel text-fg-2 hover:bg-raised hover:text-fg";
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-[family-name:var(--font-display)] text-sm transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${look}`}
      // aria-disabled, not disabled: a disabled button drops keyboard focus
      // to the page while a turn runs, and the next Space would open the mic.
      onClick={(e) => {
        if (!disabled) onClick(e);
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
function RoundButton({ ref, onClick, disabled, label, testid, type = "button", variant = "primary", children }: { ref?: Ref<HTMLButtonElement>; onClick?: () => void; disabled?: boolean; label: string; testid?: string; type?: "button" | "submit"; variant?: "primary" | "secondary" | "ghost"; children: ReactNode }) {
  const look = {
    primary: "border-accent-edge bg-accent text-accent-ink shadow-[0_3px_0_var(--accent-edge)]",
    secondary: "border-line bg-panel text-fg shadow-[0_3px_0_var(--line)]",
    ghost: "border-transparent text-fg-3 text-xl",
  }[variant];
  // A disabled button doesn't light up or press down.
  const live = disabled
    ? ""
    : {
        primary: "hover:bg-accent-hover active:translate-y-[2px] active:shadow-[0_1px_0_var(--accent-edge)]",
        secondary: "hover:bg-raised active:translate-y-[2px] active:shadow-[0_1px_0_var(--line)]",
        ghost: "hover:bg-raised hover:text-fg",
      }[variant];
  return (
    <button
      ref={ref}
      type={type}
      className={`mb-[3px] inline-flex size-11 shrink-0 items-center justify-center rounded-full border transition-[background-color,transform,box-shadow] duration-75 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${look} ${live}`}
      // aria-disabled, not disabled: a disabled button drops keyboard focus
      // to the page (after Send, say), and the next Space would open the mic
      // over the dojo master. A submit that is "disabled" doesn't submit.
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.();
      }}
      aria-disabled={disabled || undefined}
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
