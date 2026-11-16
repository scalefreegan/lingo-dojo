// The Practice tab's calls (web/server/practice.ts), beside api.ts rather
// than in it: they go through the same req(), so the page's learner and
// language headers, the 401 and the stale-learner 409 behave as everywhere.

import { json, req, reqBlob } from "./api";
import type {
  PracticeAnswerReply, PracticeAnswerRequest, PracticeDirection, PracticeFlagReply, PracticeMode, PracticeQueueReply, PracticeRating, PracticeStatsReply, PracticeTranscribeReply,
} from "./types";

/** The browser's UTC offset in minutes (local minus UTC): the server counts
 *  the learner's day, and its 4 a.m. rollover, in it. */
export const utcOffset = () => -new Date().getTimezoneOffset();

/** GET /api/practice: what is due and new in this mode, and today's progress. */
export function practiceStats(mode: PracticeMode, direction: PracticeDirection, signal?: AbortSignal): Promise<PracticeStatsReply> {
  const q = new URLSearchParams({ mode, direction, tz: String(utcOffset()) });
  return req<PracticeStatsReply>(`/api/practice?${q}`, { signal });
}

/** GET /api/practice/queue: one session's cards. */
export function practiceQueue(length: number, mode: PracticeMode, direction: PracticeDirection, signal?: AbortSignal): Promise<PracticeQueueReply> {
  const q = new URLSearchParams({ length: String(length), mode, direction, tz: String(utcOffset()) });
  return req<PracticeQueueReply>(`/api/practice/queue?${q}`, { signal });
}

/** POST /api/practice/answer: grade and record one answer. */
export function answerCard(body: Omit<PracticeAnswerRequest, "tz">): Promise<PracticeAnswerReply> {
  return req<PracticeAnswerReply>("/api/practice/answer", json({ ...body, tz: utcOffset() }));
}

/** POST /api/practice/reviews/:id/override: the learner's own grade instead. */
export function overrideAnswer(reviewId: number, rating: PracticeRating): Promise<PracticeAnswerReply> {
  return req<PracticeAnswerReply>(`/api/practice/reviews/${reviewId}/override`, json({ rating, tz: utcOffset() }));
}

/** POST /api/practice/cloze/:id/flag: a bad sentence, never shown again. */
export function flagCloze(clozeId: string): Promise<PracticeFlagReply> {
  return req<PracticeFlagReply>(`/api/practice/cloze/${encodeURIComponent(clozeId)}/flag`, json({}));
}

/** GET /api/practice/audio/:phraseId: the phrase said aloud (the server
 *  caches it, so a replay costs nothing; `cached` says it came from there). */
export async function phraseAudio(phraseId: string, signal?: AbortSignal): Promise<{ blob: Blob; cached: boolean }> {
  const { blob, headers } = await reqBlob(`/api/practice/audio/${encodeURIComponent(phraseId)}`, { signal });
  return { blob, cached: headers.get("X-Audio-Cache") === "hit" };
}

/** POST /api/practice/transcribe: a speak-it recording → what was heard
 *  ("" for nothing). Records nothing. */
export function transcribeAnswer(audio: Blob, signal?: AbortSignal): Promise<PracticeTranscribeReply> {
  return req<PracticeTranscribeReply>("/api/practice/transcribe", { method: "POST", headers: { "Content-Type": audio.type || "audio/wav" }, body: audio, signal });
}
