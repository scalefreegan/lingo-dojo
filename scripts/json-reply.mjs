// Pulling one JSON object out of a model reply. Shared by the answer grader
// (match.mjs) and the post-session extraction (extraction.mjs): both ask a
// tool-less `claude -p` for JSON and both get, now and then, a code fence or a
// sentence of preamble around it. Pure string in, value out.

/** The first parseable top-level JSON object in `text`, or null. Tolerates
 *  ```json fences and prose before or after. Scans for balanced braces while
 *  honouring strings, so a "}" inside a value does not end the object early;
 *  if the first candidate does not parse, the next "{" is tried. */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/```[a-zA-Z]*\s*/g, "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    const end = matchingBrace(s, start);
    if (end === -1) continue;
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      // Not JSON at this brace (for instance a "{" in prose); keep scanning.
    }
  }
  return null;
}

function matchingBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
