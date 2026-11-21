import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { getMyReadings, getSharedReadings } from "../api.ts";
import type { MyReading, SharedReadingEntry } from "../../shared/readings.ts";
import { readingIn, resolveMode, scriptFor, type RubyMode } from "./script.ts";

/* Reading aids in React: the language profile's choice (Off / Pinyin /
 * Zhuyin, ScriptProvider), the lazily loaded reader that gives the
 * readings, and the <ruby> markup they are drawn with.
 *
 * Readings sit in <rt aria-hidden data-rt="nǐ">, drawn by CSS from the
 * attribute (index.css .ld-ruby), so copying a line copies its characters
 * only, and a screen reader reads the characters once rather than each one
 * followed by its romanisation. */

export interface ScriptState {
  /** The profile's stored choice (null: never chose). */
  stored: string | null;
  setMode: (mode: RubyMode) => void;
  /** Kids mode: the character card is sized and worded for a child. */
  kids: boolean;
  /** Open the character card for `ch`, read for `locale`; `from` is the
   *  text it was tapped in and its UTF-16 offset there, so the card leads
   *  with the reading it has in that word (蘋 in 蘋果: píng). */
  openChar: (ch: string, locale: string, from?: CharContext) => void;
  /** The language profile shown (whose own readings are laid over the
   *  reader's); null outside a learner's page. */
  languageId: string | null;
}

/** Where a character on the card was tapped: its text and offset. */
export interface CharContext {
  text: string;
  at: number;
  /** The dojo master's readings for phrases of `text` (zh.ts ReadingHint),
   *  so the card leads with what the learner saw over the character. */
  hints?: readonly { term: string; reading: string }[];
}

const NONE: ScriptState = { stored: null, setMode: () => undefined, kids: false, openChar: () => undefined, languageId: null };
export const ScriptContext = createContext<ScriptState>(NONE);
export const useScript = () => useContext(ScriptContext);

/** The aid shown over `locale`'s text: "off" where it has none. */
export function useRubyMode(locale: string | null | undefined): RubyMode {
  return resolveMode(useContext(ScriptContext).stored, locale);
}

/* --------------------------------- reader --------------------------------- */

type ZhReader = typeof import("./zh.ts");
let zh: ZhReader | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Fetch the Mandarin reader once (pinyin-pro and its tables, a separate
 *  chunk). A failed fetch is logged and retried by the next caller; until
 *  then the text shows without readings. */
export function loadZh(): Promise<ZhReader> {
  if (zh) return Promise.resolve(zh);
  loading ??= import("./zh.ts").then(
    (m) => {
      zh = m;
      applyCorrections();
    },
    (e: unknown) => {
      loading = null;
      console.error("Could not load the pinyin reader", e);
    },
  );
  return loading.then(() => {
    if (!zh) throw new Error("the pinyin reader didn't load");
    return zh;
  });
}

/* ------------------------------ corrections ------------------------------ */

// Readings settled by people (ld-4i2): the shared list's active entries
// (anyone's, fetched once a page and revalidated by ETag) and the shown
// language's own (corrections, confirmations, the recap's suggestions),
// laid over the reader for every text on the page (zh.ts setCorrections).
// `correctionsVersion` moves whenever they change, so every useRuby reads
// again: a correction shows everywhere at once.
let shared: SharedReadingEntry[] = [];
let mine: MyReading[] = [];
let mineFor: string | null = null;
let correctionsVersion = 0;
let sharedLoad: Promise<void> | null = null;
let mineLoad: { id: string; p: Promise<void> } | null = null;

function applyCorrections(): void {
  correctionsVersion++;
  if (zh) {
    const own = mineFor ? mine : [];
    zh.setCorrections(
      zh.makeCorrections(
        { shared, mine: own.filter((r) => r.kind !== "suggested"), suggested: own.filter((r) => r.kind === "suggested") },
        String(correctionsVersion),
      ),
    );
  }
  for (const fn of listeners) fn();
}

/** Fetch the shared list (once a page) and `languageId`'s own readings
 *  (again when it changes). A failure leaves the reader's own readings. */
export function loadReadings(languageId: string | null): void {
  sharedLoad ??= getSharedReadings().then(
    (r) => {
      shared = r.entries;
      applyCorrections();
    },
    (e: unknown) => {
      sharedLoad = null;
      console.warn("Could not load the shared readings", e);
    },
  );
  if (!languageId || mineLoad?.id === languageId) return;
  const load: { id: string; p: Promise<void> } = { id: languageId, p: Promise.resolve() };
  mineLoad = load;
  if (mineFor !== languageId) {
    mine = [];
    mineFor = null;
    applyCorrections();
  }
  load.p = getMyReadings().then(
    (r) => {
      if (mineLoad !== load) return;
      mine = r.readings;
      mineFor = languageId;
      applyCorrections();
    },
    (e: unknown) => {
      if (mineLoad === load) mineLoad = null;
      console.warn("Could not load this language's readings", e);
    },
  );
}

/** A reading the learner just saved: laid over the reader at once. */
export function noteMyReading(languageId: string, r: MyReading): void {
  if (mineFor !== languageId) return;
  const key = (w: string) => (zh ? zh.correctionKey(w) : w);
  mine = [...mine.filter((x) => key(x.word) !== key(r.word)), r];
  applyCorrections();
}

/** The version of the corrections (a dependency for reads). */
export const useCorrectionsVersion = () => useSyncExternalStore(subscribe, () => correctionsVersion);

/** The reader once it's loaded, when `wanted`; null before that. */
export function useZhReader(wanted: boolean): ZhReader | null {
  const mod = useSyncExternalStore(subscribe, () => zh);
  useEffect(() => {
    if (wanted && !zh) void loadZh().catch(() => undefined);
  }, [wanted]);
  return wanted ? mod : null;
}

export interface Ruby {
  mode: RubyMode;
  /** Pinyin at each character's UTF-16 offset in the text, null elsewhere;
   *  null as a whole when no reading is shown (off, not Chinese, loading). */
  readings: (string | null)[] | null;
  /** The uncertain words (zh.ts unsureOffsets): UTF-16 [start, end) in the
   *  text. Null for a kids learner (a child sees no marks) and wherever no
   *  reading is shown. */
  unsure?: { start: number; end: number; word: string }[] | null;
  /** The text and locale the offsets are in, for the character card a
   *  marked character opens (rubyPieces' `check`). */
  text?: string;
  locale?: string;
}

/** The readings to draw over `text` (target-language text in `locale`).
 *  `hints`: readings the dojo master gave for phrases of it, or a bank
 *  phrase's stored one (zh.ts ReadingHint); entries without a reading (a
 *  turn's plain glosses) are skipped. */
export function useRuby(text: string, locale: string | null | undefined, hints?: readonly { term: string; reading?: string }[] | null): Ruby {
  const mode = useRubyMode(locale);
  const { kids, languageId } = useContext(ScriptContext);
  const reader = useZhReader(mode !== "off" && scriptFor(locale)?.id === "zh");
  const version = useCorrectionsVersion();
  useEffect(() => {
    if (reader) loadReadings(languageId);
  }, [reader, languageId]);
  // By value: callers build the list inline.
  const key = (hints ?? []).filter((h) => h.reading).map((h) => `${h.term}\u0001${h.reading}`).join("\u0002");
  const read = useMemo(() => {
    if (!reader || !locale) return null;
    const list = key ? key.split("\u0002").map((e) => ({ term: e.split("\u0001")[0], reading: e.split("\u0001")[1] })) : null;
    // `version`: the corrections changed (zh.ts emptied its cache), so read again.
    void version;
    return { readings: reader.readOffsets(text, locale, list), unsure: kids ? null : reader.unsureOffsets(text, locale) };
  }, [reader, text, locale, key, kids, version]);
  if (mode === "off" || !read) return { mode, readings: null };
  return { mode, readings: read.readings, unsure: read.unsure, text, locale: locale ?? undefined };
}

/** The callback rubyPieces' `check` takes: the character card on a marked
 *  character, read in the whole text (so it leads with the word's reading
 *  and offers "This reading is wrong" for the word). */
export function useCheck(ruby: Ruby, hints?: readonly { term: string; reading: string }[] | null): ((ch: string, at: number) => void) | undefined {
  const { openChar } = useScript();
  const { text, locale } = ruby;
  if (!ruby.unsure?.length || text == null || !locale) return undefined;
  return (ch, at) => openChar(ch, locale, { text, at, ...(hints ? { hints } : {}) });
}

/** The words an uncertain reading marks are said to be (the mark itself
 *  is a dotted underline under the reading, never colour alone). */
export const UNSURE_LABEL = "reading uncertain";

/** text[start, end) with each read character in a <ruby>; plain text where
 *  there are no readings. Keys are offsets, unique within one text.
 *  A character of an uncertain word (ruby.unsure) gets the mark; with
 *  `check` it is also a button that opens the character card on it (where
 *  the pieces are not already inside a button), and without, the word is
 *  followed by a screen-reader note. */
export function rubyPieces(text: string, start: number, end: number, ruby: Ruby, check?: (ch: string, at: number) => void): ReactNode[] {
  const { readings, mode } = ruby;
  if (!readings) return [text.slice(start, end)];
  const spans = ruby.unsure ?? [];
  const spanAt = (i: number) => spans.find((u) => u.start <= i && i < u.end);
  const out: ReactNode[] = [];
  let plain = "";
  for (let i = start; i < end; ) {
    let ch = String.fromCodePoint(text.codePointAt(i)!);
    const r = readings[i];
    if (r) {
      // A variation selector after the character (U+FE00–FE0F, an IVS at
      // U+E0100–E01EF) picks its glyph: it stays with it, inside the ruby.
      for (let j = i + ch.length; j < end; ) {
        const cp = text.codePointAt(j)!;
        if (!((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef))) break;
        const vs = String.fromCodePoint(cp);
        ch += vs;
        j += vs.length;
      }
      if (plain) out.push(plain);
      plain = "";
      const span = spanAt(i);
      const piece = (
        <ruby key={i} className={span ? "ld-ruby ld-ruby-unsure" : "ld-ruby"}>
          {ch}
          <rt aria-hidden="true" data-rt={readingIn(mode, r)} />
        </ruby>
      );
      if (span && check) {
        const at = i;
        const c = ch;
        out.push(
          <button
            key={i}
            type="button"
            className="ld-unsure"
            aria-label={`${c}: ${UNSURE_LABEL} in ${span.word}, check it`}
            title="Reading uncertain: check it"
            onClick={(e) => {
              e.stopPropagation();
              check(c, at);
            }}
          >
            {piece}
          </button>,
        );
      } else out.push(piece);
      if (span && !check && i + ch.length >= Math.min(span.end, end)) {
        out.push(
          <span key={`u${i}`} className="sr-only select-none">
            {` (${UNSURE_LABEL})`}
          </span>,
        );
      }
    } else plain += ch;
    i += ch.length;
  }
  if (plain) out.push(plain);
  return out;
}
