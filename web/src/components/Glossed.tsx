import type { ReactNode } from "react";
import type { VoiceGloss } from "../../shared/wire";
import { isSpan, layout } from "../gloss";
import { rubyPieces, useCheck, useRuby } from "../script/ruby.tsx";

/* Tap-to-see definitions on the dojo master's target-language text.
 *
 * The dojo master glosses whole sentences and the key words inside them.
 * Words and short phrases are buttons (underlined). A sentence, or a phrase
 * with glossed words inside it, is not a control of its own (see isSpan),
 * because a button inside a button is unreachable to assistive tech.
 * Tapping the rest of it still opens its meaning as a pointer convenience,
 * and the line's own translate button (VoicePanel, from `sentenceGlosses`)
 * is the keyboard and screen-reader way to it. One level of nesting is
 * enough; a match that half-overlaps another is dropped rather than
 * guessed at.
 *
 * Chinese gets its readings (pinyin or zhuyin, script/ruby.tsx) over each
 * character, read from the whole text so a word cut by a gloss boundary
 * still reads as a word; the buttons and spans wrap the ruby unchanged.
 * An uncertain reading (ld-4i2) is marked; outside a glossed word its
 * characters open the character card (with "This reading is wrong"), and
 * inside one the word's own definition card leads there. */

function Word({ gloss, active, onPick, children }: { gloss: VoiceGloss; active: boolean; onPick: (g: VoiceGloss) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={gloss.meaning}
      className={`inline min-h-0 cursor-pointer rounded-sm p-0 [overflow-wrap:anywhere] text-left font-[inherit] text-inherit underline decoration-dotted decoration-1 underline-offset-4 hover:bg-accent-soft ${active ? "bg-accent-soft" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onPick(gloss);
      }}
    >
      {children}
    </button>
  );
}

/** `text` with every glossed word or phrase a button, and every glossed
 *  sentence opening its translation on a pointer tap. */
export function Glossed({ text: raw, glosses, hints, picked, onPick, locale }: { text: string; glosses: VoiceGloss[]; hints?: VoiceGloss[]; picked: VoiceGloss | null; onPick: (g: VoiceGloss) => void; locale?: string }) {
  const text = raw.normalize("NFC");
  // `hints`: this turn's own glosses; the ones with a reading (the dojo
  // master's, checked by the server) are laid over this line's readings.
  const ruby = useRuby(text, locale, hints);
  const check = useCheck(ruby, hints?.filter((h): h is VoiceGloss & { reading: string } => !!h.reading));
  // `inButton`: inside a glossed word's button, where no button may go.
  const piece = (from: number, to: number, inButton = false) => rubyPieces(text, from, to, ruby, inButton ? undefined : check);
  if (!glosses.length) return <>{piece(0, text.length)}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const o of layout(text, glosses, locale)) {
    if (o.start > at) out.push(...piece(at, o.start));
    if (!isSpan(o, locale)) {
      out.push(
        <Word key={o.start} gloss={o.gloss} active={picked === o.gloss} onPick={onPick}>
          {piece(o.start, o.end, true)}
        </Word>,
      );
      at = o.end;
      continue;
    }
    const parts: ReactNode[] = [];
    let i = o.start;
    for (const h of o.inner) {
      if (h.start > i) parts.push(...piece(i, h.start));
      parts.push(
        <Word key={h.start} gloss={h.gloss} active={picked === h.gloss} onPick={onPick}>
          {piece(h.start, h.end, true)}
        </Word>,
      );
      i = h.end;
    }
    if (o.end > i) parts.push(...piece(i, o.end));
    out.push(
      <span key={o.start} className={`cursor-pointer rounded-sm hover:bg-accent-soft/60 ${picked === o.gloss ? "bg-accent-soft/60" : ""}`} onClick={() => onPick(o.gloss)}>
        {parts}
      </span>,
    );
    at = o.end;
  }
  if (at < text.length) out.push(...piece(at, text.length));
  return <>{out}</>;
}
