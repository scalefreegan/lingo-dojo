import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type HanziWriterType from "hanzi-writer";
import { listPhrases } from "../api";
import { loadZh, useScript, useZhReader } from "../script/ruby.tsx";
import { ARPHIC_LICENSE_URL, parseRadical } from "../script/script.ts";
import { TONE_SOUNDS, syllableParts, zhuyinSound } from "../script/sounds.ts";
import type { ZhCharRow } from "../script/zh-chars.d.json.ts";
import type { PhraseSummary } from "../types";
import { CharTerm } from "./Ruby";
import { Button } from "./ui";
import { useSound, type SoundPlayer } from "./useSound.ts";

// The zhuyin and tones chart: its own chunk, fetched when first opened.
const SoundChart = lazy(() => import("./SoundChart.tsx"));

type ZhReader = typeof import("../script/zh.ts");

/* The character card: one Chinese character, large, with its stroke order
 * animated (Hanzi Writer; replay, and trace it yourself), its readings in
 * pinyin and zhuyin, its meanings, radical and stroke count, its
 * simplified or traditional counterpart, and the phrases in this
 * language's bank that use it. Opened from a character tapped in a
 * definition card or a bank phrase (Ruby.tsx CharTerm); one at a time
 * (ScriptProvider), as a modal <dialog>: focus moves in, Tab stays in,
 * Escape or Close puts it back on the character tapped.
 *
 * Everything comes from this app's own origin: Hanzi Writer's stroke data
 * from /hanzi-data/ (served from the hanzi-writer-data package by
 * server/hanzi.ts; Hanzi Writer's default would fetch from a CDN),
 * meanings, radicals and counterparts from Unihan (zh-chars.json, its own
 * chunk), readings from the pinyin reader. In kids mode the glyph is
 * bigger, the animation comes first and plays slower, and the words are
 * simpler.
 *
 * Sounds (useSound: /api/voice/sound, cached per user on the server): each
 * reading has a speaker button, and each of its parts (the pinyin initial
 * and final, each zhuyin symbol, the tone) plays on a tap. The first
 * reading is the character itself; another reading of a character with
 * several is said by an exemplar read only that way (zh.ts exemplars), as
 * a voice given 行 alone says xíng, never háng. A symbol or tone plays its
 * fixed exemplar (sounds.ts). The sound chart lists them all. */

type Chars = Record<string, ZhCharRow>;
let charsLoad: Promise<Chars> | null = null;
function loadChars(): Promise<Chars> {
  charsLoad ??= import("../script/zh-chars.json").then(
    (m) => m.default.chars,
    (e: unknown) => {
      charsLoad = null;
      throw e;
    },
  );
  return charsLoad;
}

// The bank's phrases with the character: how many the card shows, and how
// many pages of search results it reads for them (per form) at most.
const BANK_SHOWN = 12;
const BANK_PAGES = 6;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;
// The first sense: up to the first ; or a comma outside parentheses ("silver (element 47, Ag)").
const firstSense = (s: string) => s.split(/;|,(?![^(]*\))/)[0].trim();
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function CharCard({ ch, locale, onClose }: { ch: string; locale: string; onClose: () => void }) {
  const { kids, openChar } = useScript();
  const zh = useZhReader(true);
  const sound = useSound(locale);
  const [chart, setChart] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  // Each result says which character it is for, and is only set from its
  // reply: a card that moved on to another character shows "loading" for
  // it rather than the last one's data.
  const [entry, setEntry] = useState<{ ch: string; row: ZhCharRow | null; radicalMeaning: string; error?: string } | null>(null);
  const [read, setRead] = useState<{ key: string; list: string[] | null; error?: string } | null>(null);
  const [bank, setBank] = useState<{ key: string; list: PhraseSummary[] | null; error?: string } | null>(null);

  // A modal from the first frame: the rest of the page is inert behind it.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let gone = false;
    loadChars().then(
      (chars) => {
        if (gone) return;
        const r = chars[ch] ?? null;
        const rad = parseRadical(r?.[2]);
        const radicalMeaning = rad ? firstSense(chars[rad.radical]?.[0] ?? "").replace(/^Kangxi radical \d+$/, "") : "";
        setEntry({ ch, row: r, radicalMeaning });
      },
      () => !gone && setEntry({ ch, row: null, radicalMeaning: "", error: "The character data didn't load. Is the dev server still running?" }),
    );
    return () => {
      gone = true;
    };
  }, [ch]);

  const readKey = `${ch}\u0001${locale}`;
  useEffect(() => {
    let gone = false;
    loadZh().then(
      (zh) => !gone && setRead({ key: readKey, list: zh.charReadings(ch, locale) }),
      () => !gone && setRead({ key: readKey, list: null, error: "The pinyin reader didn't load." }),
    );
    return () => {
      gone = true;
    };
  }, [ch, locale, readKey]);

  const loaded = entry?.ch === ch ? entry : null;
  const row = loaded ? loaded.row : undefined;
  const readings = read?.key === readKey ? read.list : null;
  const error = loaded?.error ?? (read?.key === readKey ? read.error : undefined);
  const radicalMeaning = loaded?.radicalMeaning ?? "";

  // The bank's phrases with this character or its counterpart (a phrase
  // saved in the other script still teaches it), through the bank's own
  // search, once the counterpart is known.
  const lookFor = row === undefined ? null : [ch, ...(row ? [...row[4], ...row[5]] : [])].join("");
  useEffect(() => {
    if (lookFor == null) return;
    const ctrl = new AbortController();
    const forms = [...lookFor];
    // The search also matches meanings and notes, so a page of 50 can hold
    // none with the character in its words: read on, page by page, until
    // there are enough to show or the results end, at most BANK_PAGES pages
    // a form.
    async function search(f: string): Promise<PhraseSummary[]> {
      const found: PhraseSummary[] = [];
      let offset: number | null = 0;
      for (let page = 0; offset != null && page < BANK_PAGES && found.length < BANK_SHOWN; page++) {
        const r = await listPhrases({ q: f, limit: 50, offset }, ctrl.signal);
        found.push(...r.phrases.filter((p) => p.text?.includes(f)));
        offset = r.nextOffset;
      }
      return found;
    }
    Promise.all(forms.map(search)).then(
      (replies) => {
        const seen = new Set<string>();
        const hits: PhraseSummary[] = [];
        for (const p of replies.flat()) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          hits.push(p);
        }
        setBank({ key: lookFor, list: hits });
      },
      (e: unknown) => {
        if (!ctrl.signal.aborted) setBank({ key: lookFor, list: null, error: String((e as Error)?.message || e) });
      },
    );
    return () => ctrl.abort();
  }, [lookFor]);
  const phrases = bank && bank.key === lookFor ? bank.list : null;
  const bankError = bank && bank.key === lookFor ? (bank.error ?? null) : null;

  const radical = parseRadical(row?.[2]);
  const meaning = row?.[0] ?? "";
  const ownMeaning = phrases?.find((p) => p.text === ch)?.meaning ?? null;
  const shownReadings = readings ?? [];
  const [trad, simp] = row ? [row[4], row[5]] : ["", ""];
  const soundError = sound.error && sound.error.text !== ch && (
    <p className="text-sm text-err" role="status">
      Couldn't play it: {sound.error.message}
    </p>
  );

  return (
    <dialog
      ref={dialog}
      aria-labelledby="char-card-title"
      className={`m-auto w-[min(100vw-2rem,40rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-line bg-panel p-0 text-fg shadow-xl backdrop:bg-black/40`}
      onClose={onClose}
      onKeyDown={(e) => {
        // Escape is the card's alone: an open definition behind it stays open.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === dialog.current;
      }}
      onClick={(e) => {
        // A tap on the backdrop (the dialog element itself, outside its box)
        // closes it: pressed and released there. A drag that starts inside
        // (a traced stroke that overshoots) and lets go outside does not.
        if (e.target === dialog.current && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
      data-testid="char-card"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2">
          <h2 id="char-card-title" className="flex-1 text-sm font-medium text-fg-2">
            {kids ? "Let's learn " : "Character "}
            <span lang={locale} className="text-fg">
              {ch}
            </span>
          </h2>
          <Button variant="ghost" className="px-2 py-1 text-sm" onClick={onClose} aria-label="Close character card">
            Close
          </Button>
        </div>

        <div className={`flex gap-4 ${kids ? "flex-col items-center" : "flex-col items-center sm:flex-row sm:items-start"}`}>
          <Strokes key={ch} ch={ch} locale={locale} kids={kids} sound={sound} />
          <div className={`flex min-w-0 flex-1 flex-col gap-2 ${kids ? "items-center text-center" : ""}`}>
            {shownReadings.length > 0 && (
              <ul className={`flex flex-wrap gap-x-5 gap-y-2 ${kids ? "justify-center" : ""}`} aria-label="Readings">
                {(kids ? shownReadings.slice(0, 1) : shownReadings).map((r, k) => (
                  <Reading key={r} reading={r} primary={k === 0} ch={ch} locale={locale} kids={kids} zh={zh} sound={sound} />
                ))}
              </ul>
            )}
            {readings && readings.length > 1 && !kids && <p className="text-sm text-fg-3 sm:text-xs">First is the usual reading; the others depend on the word.</p>}
            {shownReadings.length > 0 && (
              <p className="text-sm text-fg-3 sm:text-xs">{kids ? "Tap a sound to hear it." : "Tap a letter, a zhuyin symbol or the tone mark to hear it."}</p>
            )}
            {/* A part's failure (Hear it shows its own); with the chart open, above the chart. */}
            {!chart && soundError}
            {ownMeaning && (
              <p className={kids ? "text-xl" : "text-base"}>
                <span className="text-sm text-fg-3">{kids ? "You learned: " : "In your bank: "}</span>
                {ownMeaning}
              </p>
            )}
            {meaning && (
              <p className={kids ? "text-xl" : "text-sm text-fg-2"}>
                {!kids && <span className="text-fg-3">Means: </span>}
                {kids ? firstSense(meaning) : meaning}
              </p>
            )}
            {row === null && !error && <p className="text-sm text-fg-3">No dictionary entry for this character.</p>}
            {row && (
              <dl className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm text-fg-2 ${kids ? "text-base" : ""}`}>
                {radical && (
                  <>
                    <dt className="text-fg-3">{kids ? "Hint part" : "Radical"}</dt>
                    <dd>
                      <span lang={locale} className="text-fg">
                        {radical.radical}
                      </span>
                      {radicalMeaning && ` (${radicalMeaning})`}
                      {!kids && ` · no. ${radical.number}`}
                    </dd>
                  </>
                )}
                {row[3] > 0 && (
                  <>
                    <dt className="text-fg-3">Strokes</dt>
                    <dd>{row[3]}</dd>
                  </>
                )}
                {(trad || simp) && (
                  <>
                    <dt className="text-fg-3">{trad ? "Traditional" : "Simplified"}</dt>
                    <dd className="flex flex-wrap gap-1">
                      {[...(trad || simp)].map((c) => (
                        <button key={c} type="button" className="ld-char text-base" lang={locale} aria-label={`${c}: character details`} onClick={() => openChar(c, locale)}>
                          {c}
                        </button>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {error && <p className="text-sm text-err">{error}</p>}
          </div>
        </div>

        <div className={`flex flex-col gap-2 ${kids ? "items-center" : "items-start"}`}>
          <Button
            variant="ghost"
            className={kids ? "px-3 py-1.5 text-base" : "px-2 py-1 text-sm"}
            onClick={() => setChart((c) => !c)}
            aria-expanded={chart}
            aria-controls="char-card-chart"
            data-testid="sound-chart-toggle"
          >
            {chart ? "Hide the sound chart" : kids ? "🔤 All the sounds" : "🔤 Sound chart"}
          </Button>
          {chart && soundError}
          {chart && (
            <div id="char-card-chart" className="w-full">
              <Suspense fallback={<p className="text-sm text-fg-3">Loading the chart…</p>}>
                <SoundChart locale={locale} kids={kids} sound={sound} toScript={(t) => (zh ? zh.inScript(t, locale) : t)} />
              </Suspense>
            </div>
          )}
        </div>

        <section aria-labelledby="char-card-bank" className="flex flex-col gap-1">
          <h3 id="char-card-bank" className="text-sm font-medium text-fg-2">
            {kids ? "Words you know with it" : "In your phrase bank"}
          </h3>
          {bankError && <p className="text-sm text-err">Couldn't search the bank: {bankError}</p>}
          {!phrases && !bankError && <p className="text-sm text-fg-3">Looking…</p>}
          {phrases && phrases.length === 0 && <p className="text-sm text-fg-3">{kids ? "None yet!" : "No phrases with it yet."}</p>}
          {phrases && phrases.length > 0 && (
            <ul className="flex flex-col gap-1">
              {phrases.slice(0, BANK_SHOWN).map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                  <CharTerm text={p.text!} locale={locale} className={`font-medium text-accent ${kids ? "text-xl" : "text-base"}`} />
                  {p.meaning && <span className="text-sm text-fg-2">{p.meaning}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-sm text-fg-3 sm:text-xs">
          Readings are worked out by a program, not checked by a teacher, and can occasionally be wrong. Stroke order: Make Me a Hanzi data (
          <a className="underline" href={ARPHIC_LICENSE_URL} target="_blank" rel="noreferrer">
            Arphic Public License
          </a>
          ) via Hanzi Writer. Meanings, radicals and strokes: Unicode Unihan database. Readings: pinyin-pro.
        </p>
      </div>
    </dialog>
  );
}

/** The stroke-order animation, with Replay, Trace it (draw it yourself,
 *  stroke by stroke, with hints after misses) and Say it. */
function Strokes({ ch, locale, kids, sound }: { ch: string; locale: string; kids: boolean; sound: SoundPlayer }) {
  const box = useRef<HTMLDivElement>(null);
  const writer = useRef<HanziWriterType | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "failed">("loading");
  const [count, setCount] = useState(0);
  const [tracing, setTracing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const size = kids ? 240 : 180;

  useEffect(() => {
    let gone = false;
    const el = box.current;
    import("hanzi-writer").then(
      ({ default: HanziWriter }) => {
        if (gone || !el) return;
        el.replaceChildren();
        const still = reducedMotion();
        const w = HanziWriter.create(el, ch, {
          width: size,
          height: size,
          padding: 8,
          showOutline: true,
          showCharacter: still,
          strokeAnimationSpeed: kids ? 0.7 : 1,
          delayBetweenStrokes: kids ? 450 : 250,
          strokeColor: css("--fg") ?? "#333",
          radicalColor: css("--accent"),
          outlineColor: css("--line") ?? "#ddd",
          highlightColor: css("--kiai") ?? "#aaf",
          drawingColor: css("--accent") ?? "#333",
          drawingWidth: kids ? 10 : 6,
          showHintAfterMisses: kids ? 2 : 3,
          charDataLoader: (c, onLoad, onError) => {
            fetch(`/hanzi-data/${encodeURIComponent(c)}.json`).then(
              (r) => (r.ok ? r.json().then(onLoad, onError) : onError(r.status === 404 ? "missing" : `HTTP ${r.status}`)),
              onError,
            );
          },
          onLoadCharDataSuccess: (data) => {
            if (gone) return;
            setCount(data.strokes.length);
            setState("ready");
            if (!still) void w.animateCharacter();
          },
          onLoadCharDataError: (err) => {
            if (!gone) setState(err === "missing" ? "missing" : "failed");
          },
        });
        writer.current = w;
      },
      () => !gone && setState("failed"),
    );
    return () => {
      gone = true;
      writer.current?.cancelQuiz();
      writer.current = null;
      el?.replaceChildren();
    };
  }, [ch, kids, size]);

  function replay() {
    const w = writer.current;
    if (!w) return;
    if (tracing) w.cancelQuiz();
    setTracing(false);
    setNote(null);
    void w.hideCharacter().then(() => w.animateCharacter());
  }

  function trace() {
    const w = writer.current;
    if (!w) return;
    if (tracing) {
      w.cancelQuiz();
      setTracing(false);
      setNote(null);
      void w.showCharacter();
      return;
    }
    setTracing(true);
    setNote(kids ? "Draw each line with your finger." : "Draw each stroke in order. A hint shows after a few misses.");
    void w.quiz({
      onComplete: ({ totalMistakes }) => {
        setTracing(false);
        setNote(totalMistakes === 0 ? (kids ? "Perfect! 🎉" : "Done, with no misses.") : kids ? "You did it! 🎉" : `Done, with ${totalMistakes} ${totalMistakes === 1 ? "miss" : "misses"}.`);
      },
    });
  }

  // The whole character, through the same cached sound route as the
  // readings (the narrator's voice, a default one when none is picked).
  function say() {
    setNote(null);
    void sound.play(ch);
  }
  const speaking = sound.busy === ch;
  const shown = note ?? (sound.error?.text === ch ? `Couldn't say it: ${sound.error.message}` : null);

  const big = kids ? "px-4 py-2 text-base" : "px-2.5 py-1 text-sm";
  return (
    <div className="flex shrink-0 flex-col items-center gap-2">
      <div
        ref={box}
        role="img"
        aria-label={state === "ready" ? `${ch}: stroke order, ${count} strokes` : ch}
        className="grid touch-none place-items-center rounded-xl border border-line bg-ground"
        style={{ width: size, height: size }}
      />
      {state !== "ready" && (
        <p className="text-center text-sm text-fg-3" lang={state === "loading" ? undefined : locale}>
          {state === "loading" ? "Loading strokes…" : state === "missing" ? "No stroke order for this character." : "The stroke data didn't load."}
        </p>
      )}
      {(state === "missing" || state === "failed") && (
        <span className={kids ? "text-[8rem] leading-none" : "text-7xl leading-none"} lang={locale} aria-hidden="true">
          {ch}
        </span>
      )}
      <div className="flex flex-wrap justify-center gap-1.5">
        <Button className={big} onClick={replay} disabled={state !== "ready"}>
          ▶ {kids ? "Watch" : "Replay"}
        </Button>
        <Button className={big} onClick={trace} disabled={state !== "ready"} aria-pressed={tracing}>
          ✎ {tracing ? "Stop" : kids ? "Your turn" : "Trace it"}
        </Button>
        <Button className={big} onClick={say} disabled={speaking} data-testid="char-say">
          🔊 {kids ? "Say it" : "Hear it"}
        </Button>
      </div>
      {shown && (
        <p className="max-w-[16rem] text-center text-sm text-fg-2" role="status">
          {shown}
        </p>
      )}
    </div>
  );
}

/** One reading: its pinyin split into a tappable initial and final, its
 *  zhuyin with each symbol and the tone tappable, and a speaker button for
 *  the whole syllable (the character for the first reading, an exemplar
 *  read only this way for another). `zh` is the reader once loaded: until
 *  then an exemplar is unknown and its button waits. */
function Reading({ reading, primary, ch, locale, kids, zh, sound }: { reading: string; primary: boolean; ch: string; locale: string; kids: boolean; zh: ZhReader | null; sound: SoundPlayer }) {
  const parts = syllableParts(reading);
  const inScript = (t: string) => (zh ? zh.inScript(t, locale) : t);
  // What the speaker button says: the character's own usual reading, or a
  // character whose only reading is this one (null: none among the common
  // characters; undefined: the reader is still loading).
  const said: string | null | undefined = primary ? ch : zh ? zh.exemplars(locale).exact(reading) : undefined;
  const symbolText = (s: string) => {
    const e = zhuyinSound(s);
    return e ? inScript(e.char) : null;
  };
  // A final of several symbols (ㄧㄤ) is heard in its syllable with no
  // initial (yang); one symbol plays the chart's sound.
  const finalText = (z: string): string | null | undefined => {
    if (!z) return null;
    if ([...z].length === 1) return symbolText(z);
    return zh ? zh.exemplars(locale).sound(z) : undefined;
  };
  const tone = parts ? TONE_SOUNDS[parts.tone - 1] : null;
  const toneText = tone ? inScript(tone.text) : null;
  const big = kids ? "text-3xl" : primary ? "text-xl" : "text-base";
  return (
    <li className={`flex flex-col gap-0.5 leading-tight ${kids ? "items-center" : ""}`} data-testid="char-reading">
      <span className="flex items-center gap-1.5">
        <span className={`${primary ? "text-accent" : "text-fg-2"} ${big} font-medium`}>
          {parts ? (
            <>
              {parts.initial && (
                <SoundPart sound={sound} text={symbolText(parts.initial.zhuyin)} label={`${parts.initial.pinyin}, ${parts.initial.zhuyin}`}>
                  {parts.initial.pinyin}
                </SoundPart>
              )}
              <SoundPart
                sound={sound}
                text={finalText(parts.final.zhuyin)}
                label={parts.final.zhuyin ? `${parts.final.pinyin}, ${parts.final.zhuyin}` : parts.final.pinyin}
                why={parts.final.zhuyin ? undefined : `The ${parts.final.pinyin} here is not a sound of its own: ${parts.initial?.zhuyin ?? ""} is the whole syllable.`}
              >
                {parts.final.pinyin}
              </SoundPart>
            </>
          ) : (
            reading
          )}
        </span>
        <button
          type="button"
          className={`ld-sound ${kids ? "text-2xl" : "text-base"}`}
          style={{ borderBottom: 0 }}
          disabled={!said}
          aria-busy={sound.busy === said}
          aria-label={said ? `Hear ${reading}${primary ? "" : `, as in ${said}`}` : `Can't play ${reading} on its own`}
          title={
            said === null
              ? `No common character is read only ${reading}, and ${ch} alone would be said with its usual reading, so this one can't be played on its own.`
              : said
                ? `Hear ${reading}${primary ? "" : ` (said with ${said}, read only ${reading}; ${ch} alone would be said its usual way)`}`
                : "Loading…"
          }
          onClick={() => said && void sound.play(said)}
          data-testid="char-reading-say"
        >
          🔊
        </button>
        {!primary && said && (
          <span className="text-sm text-fg-3">
            as in{" "}
            <span lang={locale} className="text-fg-2">
              {said}
            </span>
          </span>
        )}
      </span>
      {parts && (
        <span className={`${kids ? "text-2xl" : "text-sm"} text-fg-3`} lang="zh-TW">
          {parts.tone === 5 && tone && (
            <SoundPart sound={sound} text={toneText} label={tone.name}>
              ˙
            </SoundPart>
          )}
          {parts.symbols.map((s, i) => {
            const e = zhuyinSound(s);
            return (
              <SoundPart key={`${s}${i}`} sound={sound} text={symbolText(s)} label={e ? `${s}, ${e.pinyin}` : s}>
                {s}
              </SoundPart>
            );
          })}
          {parts.tone !== 5 && tone && (
            // The first tone is unmarked in print; its mark shows faint here so it can be tapped.
            <SoundPart sound={sound} text={toneText} label={tone.name} faint={parts.tone === 1}>
              {parts.tone === 1 ? "ˉ" : tone.mark}
            </SoundPart>
          )}
        </span>
      )}
    </li>
  );
}

/** A tappable part of a reading: plays `text` (an exemplar), or is shown
 *  disabled with `why` (or "not known yet" while the reader loads). */
function SoundPart({ sound, text, label, why, faint, children }: { sound: SoundPlayer; text: string | null | undefined; label: string; why?: string; faint?: boolean; children: ReactNode }) {
  const title = text ? `Hear ${label}${[...text].length === 1 ? ` (as in ${text})` : ` (${text})`}` : (why ?? (text === undefined ? "Loading…" : `No sound for ${label}`));
  return (
    <button
      type="button"
      className={`ld-sound ${faint ? "opacity-50" : ""}`}
      disabled={!text}
      data-playing={!!text && sound.busy === text ? "" : undefined}
      aria-label={title}
      title={title}
      onClick={() => text && void sound.play(text)}
    >
      {children}
    </button>
  );
}
