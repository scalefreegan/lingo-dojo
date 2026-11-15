import { rubyPieces, useRuby, useRubyMode, useScript } from "../script/ruby.tsx";
import { isHan, scriptFor } from "../script/script.ts";

/* The reading-aid pieces the transcript, History and the phrase bank use:
 * text with readings over it, the Off / Pinyin / Zhuyin switch, and a
 * term whose characters each open the character card. All of them render
 * nothing extra for a language without a reading aid. */

/** Target-language `text` with its readings over it (plain where none). */
export function RubyText({ text, locale }: { text: string; locale: string | null | undefined }) {
  const ruby = useRuby(text, locale);
  return <>{rubyPieces(text, 0, text.length, ruby)}</>;
}

/** Off / Pinyin / Zhuyin for this language profile; nothing for a locale
 *  without a reading aid (a Spanish session has no switch at all). */
export function RubyToggle({ locale, className = "" }: { locale: string | null | undefined; className?: string }) {
  const { setMode } = useScript();
  const mode = useRubyMode(locale);
  const support = scriptFor(locale);
  if (!support) return null;
  return (
    <div role="group" aria-label="Readings over characters" className={`flex items-center gap-1 ${className}`} data-testid="ruby-toggle">
      <span className="text-sm text-fg-3 sm:text-xs" aria-hidden="true">
        Readings
      </span>
      {support.modes.map(({ mode: m, label }) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          className={`rounded-full border px-2.5 py-0.5 text-sm sm:text-xs ${mode === m ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
          onClick={() => setMode(m)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** `text` (a gloss's term, a bank phrase) with every Chinese character a
 *  button that opens the character card, readings over them as chosen.
 *  These are the character taps: a transcript line's own taps stay on its
 *  glossed words, and its characters are reached through the definition
 *  card, so the two never compete for one tap. */
export function CharTerm({ text, locale, className = "" }: { text: string; locale: string | null | undefined; className?: string }) {
  const { openChar } = useScript();
  const ruby = useRuby(text, locale);
  if (!locale || !scriptFor(locale)) return <span className={className} lang={locale ?? undefined}>{text}</span>;
  const out = [];
  let plain = "";
  let at = 0;
  for (const ch of text) {
    if (isHan(ch)) {
      if (plain) out.push(plain);
      plain = "";
      out.push(
        <button
          key={at}
          type="button"
          className="ld-char"
          aria-label={`${ch}: character details`}
          title="Character details"
          onClick={(e) => {
            e.stopPropagation();
            openChar(ch, locale);
          }}
        >
          {rubyPieces(text, at, at + ch.length, ruby)}
        </button>,
      );
    } else plain += ch;
    at += ch.length;
  }
  if (plain) out.push(plain);
  return (
    <span className={className} lang={locale}>
      {out}
    </span>
  );
}
