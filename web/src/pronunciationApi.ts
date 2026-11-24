// The pronunciation check (web/server/pronunciation.ts), through the same
// req() as every other call: the page's learner and language headers, the
// 401 and the stale-learner 409 behave as everywhere.

import { ApiError, req, reqBlob, soundAudio } from "./api";
import { phraseAudio, utcOffset } from "./practiceApi";
import type { PronunciationModelReply, PronunciationScoreReply, PronunciationWordsReply, SessionTonesReply, ToneTrendReply } from "./types";

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
export async function scorePronunciation(
  wav: Blob,
  text: string,
  signal?: AbortSignal,
  { allReadings = false, reading = null, hold = null }: { allReadings?: boolean; reading?: string | null; hold?: { phraseId: string; submitId: string } | null } = {},
): Promise<PronunciationScoreReply | null> {
  // allReadings: the character card only (one character, judged against
  // every reading it lists); Practice never sends it.
  // reading: a bank phrase's stored reading (the server checks it again).
  // hold: Practice speak-it scoring before its answer (stage 3): the
  // server keeps this check's flags for that submit.
  const q = new URLSearchParams({
    text,
    ...(allReadings ? { readings: "all" } : {}),
    ...(reading ? { reading } : {}),
    ...(hold ? { phrase: hold.phraseId, submit: hold.submitId } : {}),
  });
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

// Which locales and phrases the word check takes (ld-ne0.16): pure, shared
// with the server.
export { checksWordsHere } from "../shared/word-check.ts";

/** POST /api/pronunciation/score for a language other than Mandarin: the
 *  recording against `text`, one mark per word (docs/VOICE.md §Words and
 *  sounds beyond Mandarin), or null when this server doesn't check this
 *  language (no Azure keys, or a locale not measured): nothing is shown. */
export async function scoreWords(wav: Blob, text: string, signal?: AbortSignal): Promise<PronunciationWordsReply | null> {
  const q = new URLSearchParams({ text });
  try {
    const reply = await req<PronunciationWordsReply | PronunciationScoreReply>(`/api/pronunciation/score?${q}`, {
      method: "POST",
      headers: { "Content-Type": wav.type || "audio/wav" },
      body: wav,
      signal,
    });
    return "kind" in reply && reply.kind === "words" ? reply : null;
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_available") return null;
    throw e;
  }
}

/** GET /api/pronunciation/sessions/:id: a session's Tones section (stage
 *  3), from its stored checks; `tones` null when there is nothing. */
export function sessionTones(conversationId: string, signal?: AbortSignal): Promise<SessionTonesReply> {
  return req<SessionTonesReply>(`/api/pronunciation/sessions/${encodeURIComponent(conversationId)}`, { signal });
}

/** GET /api/pronunciation/trend: share right per tone per day, in the
 *  learner's days. */
export function toneTrend(days: number, signal?: AbortSignal): Promise<ToneTrendReply> {
  const q = new URLSearchParams({ days: String(days), tz: String(utcOffset()) });
  return req<ToneTrendReply>(`/api/pronunciation/trend?${q}`, { signal });
}

/** GET /api/pronunciation/clips/:id: a flagged turn's kept recording. */
export async function checkClip(checkId: string, signal?: AbortSignal): Promise<Blob> {
  return (await reqBlob(`/api/pronunciation/clips/${encodeURIComponent(checkId)}`, { signal })).blob;
}
