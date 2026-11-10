import type { ReactNode } from "react";
import type { VoiceGloss } from "../../shared/wire";
import { isSpan, layout } from "../gloss";

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
 * guessed at. */

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
export function Glossed({ text: raw, glosses, picked, onPick, locale }: { text: string; glosses: VoiceGloss[]; picked: VoiceGloss | null; onPick: (g: VoiceGloss) => void; locale?: string }) {
  const text = raw.normalize("NFC");
  if (!glosses.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const o of layout(text, glosses, locale)) {
    if (o.start > at) out.push(text.slice(at, o.start));
    if (!isSpan(o, locale)) {
      out.push(
        <Word key={o.start} gloss={o.gloss} active={picked === o.gloss} onPick={onPick}>
          {text.slice(o.start, o.end)}
        </Word>,
      );
      at = o.end;
      continue;
    }
    const parts: ReactNode[] = [];
    let i = o.start;
    for (const h of o.inner) {
      if (h.start > i) parts.push(text.slice(i, h.start));
      parts.push(
        <Word key={h.start} gloss={h.gloss} active={picked === h.gloss} onPick={onPick}>
          {text.slice(h.start, h.end)}
        </Word>,
      );
      i = h.end;
    }
    if (o.end > i) parts.push(text.slice(i, o.end));
    out.push(
      <span key={o.start} className={`cursor-pointer rounded-sm hover:bg-accent-soft/60 ${picked === o.gloss ? "bg-accent-soft/60" : ""}`} onClick={() => onPick(o.gloss)}>
        {parts}
      </span>,
    );
    at = o.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
