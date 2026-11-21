import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
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
}

/** Where a character on the card was tapped: its text and offset. */
export interface CharContext {
  text: string;
  at: number;
}

const NONE: ScriptState = { stored: null, setMode: () => undefined, kids: false, openChar: () => undefined };
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
      for (const fn of listeners) fn();
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
}

/** The readings to draw over `text` (target-language text in `locale`). */
export function useRuby(text: string, locale: string | null | undefined): Ruby {
  const mode = useRubyMode(locale);
  const reader = useZhReader(mode !== "off" && scriptFor(locale)?.id === "zh");
  const readings = useMemo(() => (reader && locale ? reader.readOffsets(text, locale) : null), [reader, text, locale]);
  return { mode, readings: mode === "off" ? null : readings };
}

/** text[start, end) with each read character in a <ruby>; plain text where
 *  there are no readings. Keys are offsets, unique within one text. */
export function rubyPieces(text: string, start: number, end: number, ruby: Ruby): ReactNode[] {
  const { readings, mode } = ruby;
  if (!readings) return [text.slice(start, end)];
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
      out.push(
        <ruby key={i} className="ld-ruby">
          {ch}
          <rt aria-hidden="true" data-rt={readingIn(mode, r)} />
        </ruby>,
      );
    } else plain += ch;
    i += ch.length;
  }
  if (plain) out.push(plain);
  return out;
}
