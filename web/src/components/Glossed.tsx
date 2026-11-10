import type { ReactNode } from "react";
import type { VoiceGloss } from "../../shared/wire";

/* Tap-to-see definitions on the dojo master's target-language text.
 *
 * The dojo master glosses whole sentences and the key words inside them, so
 * matches nest: a sentence is one tappable span and its key words are
 * tappable spans inside it (tapping a word shows the word, tapping the rest
 * of the sentence shows the translation). One level of nesting is enough;
 * a match that half-overlaps another is dropped rather than guessed at. */

interface Hit {
  start: number;
  end: number;
  gloss: VoiceGloss;
}

// "¿A cómo?" should still match "¿a cómo es el kilo?": the term's own
// opening and closing punctuation is not part of what has to match.
const EDGE_PUNCT = /^[\s¿¡"“”'«(]+|[\s.,;:!?…"“”'»)。！？、，]+$/gu;
const LETTER = /[\p{L}\p{N}]/u;
// Scripts written without spaces have no word boundaries to check.
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

const wordCount = (s: string) => s.trim().split(/\s+/).length;

function findHits(text: string, glosses: VoiceGloss[]): Hit[] {
  const hay = text.toLocaleLowerCase();
  const all: Hit[] = [];
  for (const gloss of glosses) {
    const needle = gloss.term.replace(EDGE_PUNCT, "").toLocaleLowerCase();
    // Lowercasing must not shift indices, or the spans would be cut wrong.
    if (!needle || needle.length !== gloss.term.replace(EDGE_PUNCT, "").length || hay.length !== text.length) continue;
    const bounded = !NO_SPACES.test(needle);
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (bounded && ((at > 0 && LETTER.test(hay[at - 1])) || (end < hay.length && LETTER.test(hay[end])))) continue;
      // Take back the term's own ¿…? or ¡…! so the tap target looks whole.
      let s = at;
      let e = end;
      while (s > 0 && /[¿¡]/.test(text[s - 1])) s--;
      while (e < text.length && /[?!]/.test(text[e])) e++;
      all.push({ start: s, end: e, gloss });
    }
  }
  // Longest first, so an outer sentence claims its span before its words.
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  return all;
}

interface Node extends Hit {
  inner: Hit[];
}

function layout(text: string, glosses: VoiceGloss[]): Node[] {
  const outer: Node[] = [];
  for (const h of findHits(text, glosses)) {
    const parent = outer.find((o) => h.start >= o.start && h.end <= o.end);
    if (parent) {
      if (parent.start === h.start && parent.end === h.end) continue;
      if (parent.inner.some((i) => h.start < i.end && i.start < h.end)) continue;
      parent.inner.push(h);
    } else if (!outer.some((o) => h.start < o.end && o.start < h.end)) {
      outer.push({ ...h, inner: [] });
    }
  }
  outer.sort((a, b) => a.start - b.start);
  for (const o of outer) o.inner.sort((a, b) => a.start - b.start);
  return outer;
}

function Term({ gloss, active, onPick, underline, children }: { gloss: VoiceGloss; active: boolean; onPick: (g: VoiceGloss) => void; underline: boolean; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={active}
      title={gloss.meaning}
      className={`cursor-pointer rounded-sm hover:bg-accent-soft focus-visible:outline-2 ${underline ? "underline decoration-dotted decoration-1 underline-offset-4" : ""} ${active ? "bg-accent-soft" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onPick(gloss);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onPick(gloss);
      }}
    >
      {children}
    </span>
  );
}

/** `text` with every glossed word, phrase, or sentence tappable. */
export function Glossed({ text, glosses, picked, onPick }: { text: string; glosses: VoiceGloss[]; picked: VoiceGloss | null; onPick: (g: VoiceGloss) => void }) {
  if (!glosses.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const o of layout(text, glosses)) {
    if (o.start > at) out.push(text.slice(at, o.start));
    const parts: ReactNode[] = [];
    let i = o.start;
    for (const h of o.inner) {
      if (h.start > i) parts.push(text.slice(i, h.start));
      parts.push(
        <Term key={h.start} gloss={h.gloss} active={picked === h.gloss} onPick={onPick} underline>
          {text.slice(h.start, h.end)}
        </Term>,
      );
      i = h.end;
    }
    if (o.end > i) parts.push(text.slice(i, o.end));
    // Words and short phrases are underlined; a whole sentence is tappable
    // (for its translation) but not underlined, or every line of Spanish
    // would be.
    out.push(
      <Term key={o.start} gloss={o.gloss} active={picked === o.gloss} onPick={onPick} underline={!o.inner.length && wordCount(o.gloss.term) <= 3}>
        {parts}
      </Term>,
    );
    at = o.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
