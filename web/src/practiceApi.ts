// The Practice tab's calls (web/server/practice.ts), beside api.ts rather
// than in it: they go through the same req(), so the page's learner and
// language headers, the 401 and the stale-learner 409 behave as everywhere.

import { json, req } from "./api";
import type { PracticeAnswerReply, PracticeAnswerRequest, PracticeDirection, PracticeQueueReply, PracticeRating, PracticeStatsReply } from "./types";

/** The browser's UTC offset in minutes (local minus UTC): the server counts
 *  the learner's day, and its 4 a.m. rollover, in it. */
export const utcOffset = () => -new Date().getTimezoneOffset();

/** GET /api/practice: what is due and new, and today's progress. */
export function practiceStats(signal?: AbortSignal): Promise<PracticeStatsReply> {
  return req<PracticeStatsReply>(`/api/practice?tz=${utcOffset()}`, { signal });
}

/** GET /api/practice/queue: one session's cards. */
export function practiceQueue(length: number, direction: PracticeDirection, signal?: AbortSignal): Promise<PracticeQueueReply> {
  const q = new URLSearchParams({ length: String(length), direction, tz: String(utcOffset()) });
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
