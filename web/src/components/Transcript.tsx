import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Glossed } from "./Glossed";
import { GlossStar } from "./GlossStar";
import { CharTerm } from "./Ruby";
import { SpeakerCritter } from "./Mascots";
import { haystack, layout, mightMatch } from "../gloss";
import { CONTROL_LABEL, directText, jumpTarget, pickText, lineLabel, planTitle, type LineTranslation } from "../transcript";
import type { LivePronunciation, PronunciationWordsReply, VoiceGloss, VoiceHistoryItem, VoiceLine, VoicePlanItem } from "../types";
import { ToneCheck } from "./ToneCheck";
import { WordCheck } from "./WordCheck";

/** A learner line's tone marks (docs/VOICE.md §Pronunciation in
 *  conversation): the turn's reply, and the take it scored (the recording,
 *  held in the page's memory only). */
export interface LineTones {
  /** Tone marks (Mandarin), or word marks (`kind: "words"`) in a language
   *  the word check measures (ld-ne0.17). */
  reply: LivePronunciation | PronunciationWordsReply;
  take: Blob | null;
}

/* The transcript of a voice session: the live one on the Go tab
 * (VoicePanel), and a saved one opened read-only from History, which has no
 * audio (no ▶ replay: onReplay is left out). */

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
export const Transcript = memo(function Transcript({
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
  className,
  follow = true,
  canStar = false,
  tones,
  veiled = 0,
  onLift,
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
  /** ▶ on each line; left out for a saved conversation (no audio). */
  onReplay?: (i: number, j: number, lines: VoiceLine[]) => void;
  /** The list's height: the live session's (the default) or a page's. */
  className?: string;
  /** Keep the newest entry in view (a live session); false reads from the top. */
  follow?: boolean;
  /** ☆ Star in the definition card (the active language's phrase bank):
   *  only where the transcript is in that language. */
  canStar?: boolean;
  /** Tone or word marks under the learner's own lines, by entry index (a
   *  live adult session with the coaching dial on). */
  tones?: ReadonlyMap<number, LineTones>;
  /** How many entries from the top are veiled while the learner practises
   *  from memory (0: none): blurred, out of the keyboard's and a screen
   *  reader's way, and never text the eye can make out. */
  veiled?: number;
  /** Show the veiled entries for now. */
  onLift?: () => void;
}) {
  const olRef = useRef<HTMLOListElement | null>(null);
  const following = useRef(follow);
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
  const veiledRef = useRef(false);
  useLayoutEffect(() => {
    veiledRef.current = veiled > 0;
  });
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el) return;
    // The learner's own message always comes into view: they just sent it.
    if (follow && entries[count - 1]?.role === "learner") following.current = true;
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
      } else if (was > height && height > 0 && following.current) {
        // The controls under it grew (choices, the typing box): what was at
        // its bottom edge stays there rather than going under them.
        el.scrollTop += was - height;
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
    // Clear of the veil's button, which is pinned over the list's top.
    const top = veiledRef.current ? 52 : pad;
    if (r.top < box.top + top || r.height > box.height) scrollTo(el, el.scrollTop + r.top - box.top - top);
    else if (r.bottom > box.bottom - pad) scrollTo(el, el.scrollTop + r.bottom - box.bottom + pad);
  }, [playing]);
  // A definition card under the last line opens below the list's fold:
  // bring it into view ("nearest": no move when it already fits). The
  // list's own scroll only, like the effect above, never the page's. Not a
  // scrollIntoView: that moves every ancestor.
  const pickedKey = picked ? `${picked.at}\u0001${picked.gloss.term}` : null;
  useLayoutEffect(() => {
    const el = olRef.current;
    if (!el || !pickedKey) return;
    const card = el.querySelector<HTMLElement>('[data-testid="voice-gloss"]');
    if (!card) return;
    const box = el.getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const pad = 8;
    if (r.height > box.height || r.top < box.top + pad) scrollTo(el, el.scrollTop + r.top - box.top - pad);
    else if (r.bottom > box.bottom - pad) scrollTo(el, el.scrollTop + r.bottom - box.bottom + pad);
    // Only a different card moves the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  // Asking to hear a line is asking to follow it. Stable, for the rows' memo.
  const replayRef = useRef(onReplay);
  useEffect(() => {
    replayRef.current = onReplay;
  });
  const replayLine = useCallback((i: number, j: number, lines: VoiceLine[]) => {
    following.current = true;
    replayRef.current?.(i, j, lines);
  }, []);
  const canReplay = !!onReplay;

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
<ol ref={olRef} onScroll={onScroll} className={`flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto rounded-2xl border border-line bg-panel p-3 ${className ?? "max-h-[min(28rem,calc(100dvh-22rem))] min-h-48 lg:max-h-[max(28rem,calc(100dvh-26rem))]"}`} aria-label="Session transcript" data-testid="voice-transcript">
  {veiled > 0 && (
    // Pinned to the top of the list, so the way back is always in view.
    <li className="sticky top-0 z-10 flex justify-center">
      <button type="button" className="rounded-full border border-accent bg-accent-soft px-3 py-1 font-[family-name:var(--font-display)] text-sm text-fg shadow-sm hover:bg-accent hover:text-accent-ink" onClick={onLift} data-testid="voice-lift-veil">
        🙈 Hidden while you recall. Show
      </button>
    </li>
  )}
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
        onReplay={canReplay ? replayLine : undefined}
        canStar={canStar}
        tones={tones?.get(i)}
        veiled={i < veiled}
      />
    );
  })}
</ol>
  );
});

const NO_GLOSSES: VoiceGloss[] = [];
const NO_TRANSLATIONS: LineTranslation[] = [];
/** A veiled entry keeps its place but can't be read (inert also takes it out
 *  of find-in-page, selection and the accessibility tree). */
const VEIL = "select-none opacity-60 blur-[7px]";

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
  canStar,
  tones,
  veiled,
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
  onReplay?: (i: number, j: number, lines: VoiceLine[]) => void;
  canStar?: boolean;
  tones?: LineTones;
  veiled: boolean;
}) {
  if (m.role === "learner") {
    const bubble = (
      <div className="rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm text-fg">
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
          (pickText(m.text) ?? m.text)
        )}
      </div>
    );
    // The line's tone marks, under it (adults only: the server gives kids
    // none). The same marks as Practice's speak-it, so a tap opens the same
    // tone picture with the learner's own take.
    return (
      <li className={`flex max-w-[85%] flex-col items-end gap-1 self-end ${veiled ? VEIL : ""}`} inert={veiled} data-veiled={veiled || undefined}>
        {bubble}
        {tones && (
          <div className="w-full rounded-xl border border-line bg-raised px-2.5 py-2" data-testid="voice-learner-tones">
            {"kind" in tones.reply ? <WordCheck reply={tones.reply} take={tones.take} kids={false} live /> : <ToneCheck reply={tones.reply} take={tones.take} kids={false} />}
          </div>
        )}
      </li>
    );
  }
  return (
      <li className={`flex flex-col gap-1 ${veiled ? VEIL : ""}`} inert={veiled} data-veiled={veiled || undefined}>
        {m.lines.map((l, j) => (
          <Fragment key={j}>
          <div data-line={`${i}:${j}`} className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors ${playing === `${i}:${j}` ? "bg-kiai-soft" : ""}`}>
            <SpeakerCritter speaker={l.speaker} size={30} />
            <span className="hidden w-24 shrink-0 pt-1.5 font-[family-name:var(--font-display)] text-xs break-words text-fg-3 sm:block">{lineLabel(l)}</span>
            <span className="min-w-0 max-w-[72ch] flex-1 text-fg break-words">
              {/* On a phone who is speaking sits over the words: a column of
                  its own left the words a third of the screen. */}
              <span className="block font-[family-name:var(--font-display)] text-xs text-fg-3 sm:hidden">{lineLabel(l)}</span>
              {(l.segments?.length ? l.segments : [{ lang: "native" as const, text: l.text }]).map((g, k) => (
                <span key={k} className={g.lang === "target" ? "font-medium text-accent" : ""} lang={g.lang === "target" ? (locale ?? undefined) : undefined} data-pace={g.slow ? "slow" : undefined} title={g.slow ? "Spoken slowly" : undefined}>
                  {k > 0 && !/^[.,;:!?)\]»…]/.test(g.text) ? " " : ""}
                  {g.lang === "target" ? <Glossed text={g.text} glosses={glosses} hints={m.role === "master" ? m.glosses : undefined} locale={locale ?? undefined} picked={picked?.at === `${i}:${j}` ? picked.gloss : null} onPick={(gl) => onPick(`${i}:${j}`, gl)} /> : g.text}
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
            {onReplay && (
            <button type="button" className="-my-0.5 grid size-6 min-h-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-raised hover:text-fg" aria-label="Replay line" title="Replay" onClick={() => onReplay(i, j, m.lines)}>
              ▶
            </button>
            )}
          </div>
          {/* The definition under the line, the row's full width on a phone
              (under the text column from sm up), and after the line's
              controls in the DOM, so Tab goes opener → card. Escape or ×
              from the keyboard closes it and puts focus back on its opener. */}
          {picked?.at === `${i}:${j}` && (
            <div
              className="mx-2 flex items-start gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-sm text-fg sm:ml-36 sm:max-w-[72ch]"
              role="status"
              data-testid="voice-gloss"
            >
              <span className="min-w-0 flex-1 break-words">
                {/* Its characters each open the character card (Chinese). */}
                {/* accent-hover, not accent: accent on accent-soft is 4.34:1 in
                    the adult dark theme; hover is 5.47:1 there and no lower
                    in the others. */}
                <CharTerm text={picked.gloss.term} locale={locale} reading={picked.gloss.reading} className="font-medium text-accent-hover" />
                <span className="text-fg-3"> — </span>
                {picked.gloss.meaning}
              </span>
              {canStar && <GlossStar key={picked.gloss.term} gloss={picked.gloss} />}
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

