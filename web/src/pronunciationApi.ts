// The pronunciation check (web/server/pronunciation.ts), through the same
// req() as every other call: the page's learner and language headers, the
// 401 and the stale-learner 409 behave as everywhere.

import { ApiError, req } from "./api";
import type { PronunciationScoreReply } from "./types";

/** Locales the server scores (Mandarin, either script; scripts/
 *  pronunciation.mjs scoresTones is the rule, this only saves a request
 *  the server would refuse). Cantonese is another language with other
 *  tones. */
export function scoresTonesHere(locale: string | null | undefined): boolean {
  return /^(zh|cmn)(-(hans|hant))?(-(cn|tw|sg|my))?$/i.test(String(locale ?? ""));
}

const HAN = /\p{Script=Han}/u;
/** Text the route takes (pronunciation-app.mjs readScoreText): 1 to 24 Han
 *  characters with punctuation and spaces, nothing else. */
export function scorableText(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  const han = [...t].filter((c) => HAN.test(c)).length;
  return han > 0 && han <= 24 && [...t].length <= 64 && /^[\p{Script=Han}\p{P}\s]+$/u.test(t);
}

/** POST /api/pronunciation/score: the recording against `text`, or null
 *  when the language isn't scored (the page then shows nothing). */
export async function scorePronunciation(wav: Blob, text: string, signal?: AbortSignal): Promise<PronunciationScoreReply | null> {
  try {
    return await req<PronunciationScoreReply>(`/api/pronunciation/score?${new URLSearchParams({ text })}`, {
      method: "POST",
      headers: { "Content-Type": wav.type || "audio/wav" },
      body: wav,
      signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_available") return null;
    throw e;
  }
}
