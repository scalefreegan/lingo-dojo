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

// Words by the language's own rules, so Chinese, Japanese and Thai (written
// without spaces) count words too, not one per sentence. Falls back to
// spaces where Intl.Segmenter is missing or the locale is unknown.
const segmenters = new Map<string, Intl.Segmenter | null>();
function segmenter(locale?: string): Intl.Segmenter | null {
  const k = locale ?? "";
  if (!segmenters.has(k)) {
    let seg: Intl.Segmenter | null = null;
    try {
      if (typeof Intl.Segmenter === "function") seg = new Intl.Segmenter(locale || undefined, { granularity: "word" });
    } catch {
      seg = null;
    }
    segmenters.set(k, seg);
  }
  return segmenters.get(k) ?? null;
}
function wordCount(s: string, locale?: string): number {
  const seg = segmenter(locale);
  if (seg) {
    let n = 0;
    for (const w of seg.segment(s)) if (w.isWordLike) n++;
    return n;
  }
  return s.trim().split(/\s+/).length;
}
/** A sentence-length gloss: a translation, not a word to define. */
export const isSentence = (g: VoiceGloss, locale?: string) => wordCount(g.term, locale) > 3;

/** A matched gloss that is not a button of its own: a sentence, or a short
 *  phrase with glossed words inside it (a button can't hold buttons). Tapping
 *  it opens its meaning as a pointer convenience; the line's translate button
 *  is the keyboard and screen-reader way to it. */
export const isSpan = (n: Node, locale?: string) => isSentence(n.gloss, locale) || n.inner.length > 0;

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
    const marked = /[¿¡?!]/.test(gloss.term);
    for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (bounded && ((at > 0 && LETTER.test(src[at - 1])) || (end < src.length && LETTER.test(src[end])))) continue;
      // Take back the term's own ¿…? or ¡…! so the tap target looks whole,
      // but only for a term written with them: "jitomate" at the end of
      // "¿Tiene jitomate?" must not take the sentence's "?".
      let s = at;
      let e = end;
      if (marked) {
        while (s > 0 && /[¿¡]/.test(text[s - 1])) s--;
        while (e < text.length && /[?!]/.test(text[e])) e++;
      }
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

/** The meanings in `texts` (a line's target-language segments) that are
 *  not buttons of their own (see isSpan), in order: what the line's
 *  translate button shows. Laid out with every gloss, exactly as Glossed
 *  lays the line out, so the two agree on what is a span. */
export function sentenceGlosses(texts: string[], glosses: VoiceGloss[], locale?: string): VoiceGloss[] {
  const out: VoiceGloss[] = [];
  for (const t of texts) {
    for (const o of layout(t.normalize("NFC"), glosses, locale)) if (isSpan(o, locale) && !out.includes(o.gloss)) out.push(o.gloss);
  }
  return out;
}
