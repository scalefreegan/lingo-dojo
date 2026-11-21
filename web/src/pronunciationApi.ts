// The pronunciation check (web/server/pronunciation.ts), through the same
// req() as every other call: the page's learner and language headers, the
// 401 and the stale-learner 409 behave as everywhere.

import { ApiError, req, soundAudio } from "./api";
import { phraseAudio } from "./practiceApi";
import type { PronunciationModelReply, PronunciationScoreReply } from "./types";

/** Where compare mode's model comes from: the character card's sound (the
 *  same request /api/voice/sound gets) or a Practice phrase. */
export type CompareSource = { kind: "sound"; text: string; locale: string } | { kind: "phrase"; phraseId: string };

/** GET /api/pronunciation/model: the model clip's analysis (pitch,
 *  loudness, syllable timings), made on the server from its own cached
 *  audio for that source. */
export function modelAnalysis(source: CompareSource, signal?: AbortSignal): Promise<PronunciationModelReply> {
  const q = source.kind === "sound" ? new URLSearchParams({ sound: source.text, locale: source.locale }) : new URLSearchParams({ phrase: source.phraseId });
  return req<PronunciationModelReply>(`/api/pronunciation/model?${q}`, { signal });
}

/** The model clip itself, for playback: the same audio the analysis was
 *  made from (the server's cache hands both routes one file). */
export async function modelClip(source: CompareSource, signal?: AbortSignal): Promise<Blob> {
  return source.kind === "sound" ? soundAudio({ text: source.text, locale: source.locale }, signal) : (await phraseAudio(source.phraseId, signal)).blob;
}

// Which locales and texts are scored: pure, in web/shared so node tests them.
export { scorableText, scoresTonesHere } from "../shared/tone-text.ts";

/** POST /api/pronunciation/score: the recording against `text`, or null
 *  when the language isn't scored (the page then shows nothing). */
export async function scorePronunciation(wav: Blob, text: string, signal?: AbortSignal, { allReadings = false }: { allReadings?: boolean } = {}): Promise<PronunciationScoreReply | null> {
  // allReadings: the character card only (one character, judged against
  // every reading it lists); Practice never sends it.
  const q = new URLSearchParams({ text, ...(allReadings ? { readings: "all" } : {}) });
  try {
    return await req<PronunciationScoreReply>(`/api/pronunciation/score?${q}`, {
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
