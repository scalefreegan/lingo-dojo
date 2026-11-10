import type { VoiceGloss } from "../shared/wire";

/* Where the dojo master's glosses fall in a line's target-language text:
 * the matching behind components/Glossed.tsx and the transcript's
 * translate buttons. Pure, no React. */

interface Hit {
  start: number;
  end: number;
  gloss: VoiceGloss;
}

// "¿A cómo?" should still match "¿a cómo es el kilo?": the term's own
// opening and closing punctuation is not part of what has to match.
const EDGE_PUNCT = /^[\s¿¡"“”'«(]+|[\s.,;:!?…"“”'»)。！？、，]+$/gu;
// A combining mark counts as part of its word, so a match can't end
// between a letter and its accent.
const LETTER = /[\p{L}\p{M}\p{N}]/u;
// Scripts written without spaces have no word boundaries to check.
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

const wordCount = (s: string) => s.trim().split(/\s+/).length;
/** A sentence-length gloss: a translation, not a word to define. */
export const isSentence = (g: VoiceGloss) => wordCount(g.term) > 3;

function findHits(text: string, glosses: VoiceGloss[], locale?: string): Hit[] {
  const lower = (s: string) => {
    try {
      return s.toLocaleLowerCase(locale);
    } catch {
      return s.toLowerCase();
    }
  };
  const hay = lower(text);
  // Lowercasing must not shift indices, or the spans would be cut wrong
  // (Turkish "İ" becomes two code units outside a Turkish locale). If the
  // text's length changes, match it case-sensitively instead.
  const folded = hay.length === text.length;
  const all: Hit[] = [];
  for (const gloss of glosses) {
    const bare = gloss.term.normalize("NFC").replace(EDGE_PUNCT, "");
    const needle = folded ? lower(bare) : bare;
    if (!needle || (folded && needle.length !== bare.length)) continue;
    const src = folded ? hay : text;
    const bounded = !NO_SPACES.test(needle);
    for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (bounded && ((at > 0 && LETTER.test(src[at - 1])) || (end < src.length && LETTER.test(src[end])))) continue;
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

export interface Node extends Hit {
  inner: Hit[];
}

export function layout(text: string, glosses: VoiceGloss[], locale?: string): Node[] {
  const outer: Node[] = [];
  for (const h of findHits(text, glosses, locale)) {
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

/** The sentence translations that match somewhere in `texts` (a line's
 *  target-language segments), in order: what the line's translate button
 *  shows. */
export function sentenceGlosses(texts: string[], glosses: VoiceGloss[], locale?: string): VoiceGloss[] {
  const sentences = glosses.filter(isSentence);
  const out: VoiceGloss[] = [];
  for (const t of texts) {
    for (const o of layout(t.normalize("NFC"), sentences, locale)) if (!out.includes(o.gloss)) out.push(o.gloss);
  }
  return out;
}
