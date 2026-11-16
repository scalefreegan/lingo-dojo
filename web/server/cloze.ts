import os from "node:os";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { CLOZE_BATCH, clozeKey, clozePrompt, parseClozeReply } from "../../scripts/cloze.mjs";
import { clozeStates, storeGenerated } from "../../scripts/db/cloze.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import type { CandidatePhrase } from "../../scripts/practice.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { paidSlot } from "./paid.ts";
import { HttpError } from "./sse.ts";

// Cloze sentences for the Practice tab (docs/DATA.md §Practice modes, "As
// built (phase 7c: cloze)"). The queue reads what each phrase has
// (scripts/db/cloze.ts clozeStates: its own session lines first); for the
// phrases it would ask with none, one tool-less `claude -p` call writes
// sentences for a batch of up to CLOZE_BATCH, in the background:
//  - never in the queue's way: the queue answers with the sentences that
//    exist (a phrase without one waits, or is said aloud in mixed), and
//    the page asks again for the rest;
//  - no transaction or row lock is held while the model writes; the rows
//    are inserted after, one phrase at a time;
//  - one call at a time per language profile, inside one of the user's
//    paid slots (paid.ts, shared with phrase audio and transcription); a
//    busy slot skips the call (the next queue tries again), and a failed
//    one waits RETRY_AFTER_MS before the next try;
//  - the reply is model output: parsed strictly as the JSON asked for,
//    cleaned and capped, and every sentence checked (cloze.mjs
//    checkSentence) before it is kept; a phrase the reply gave nothing
//    usable is marked as tried, so it never pays twice for the same words
//    and meaning. A failure only means no cloze for the phrase now.

/** Sentences are worth a stronger model than a yes/no grade: once per
 *  phrase, and the learner reads them over and over. */
const CLOZE_MODEL = "claude-sonnet-5-5";
const CALL_TIMEOUT_SEC = 120;
/** After a failed call (the CLI, a limit, an unreadable reply). */
export const RETRY_AFTER_MS = 10 * 60_000;

/** The call going on per language profile. */
const filling = new Map<string, Promise<void>>();
/** Per language profile: when a call may be tried again after a failure. */
const retryAt = new Map<string, number>();

/** Resolves when every call started so far has finished (the tests). */
export async function settleClozeFills(): Promise<void> {
  while (filling.size) await Promise.allSettled([...filling.values()]);
}

/** Whether sentences are being written for this language now. */
export const clozeWriting = (profileId: string): boolean => filling.has(profileId);

const targetLocale = (ctx: LearnerCtx) => localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";

/**
 * `phrases` with their cloze state (`cloze`: usable items; `clozeNeeded`:
 * worth a model call), for the cloze and mixed modes. A failure to read or
 * update the items is logged and leaves every phrase without cloze: the
 * session goes on with the other drills.
 */
export async function withCloze(ctx: LearnerCtx, phrases: CandidatePhrase[]): Promise<CandidatePhrase[]> {
  try {
    const states = await clozeStates(rawDb(), ctx.language, phrases, { locale: targetLocale(ctx), level: ctx.language.level });
    return phrases.map((p) => {
      const s = states.get(p.id);
      return s ? { ...p, cloze: s.items, clozeNeeded: s.needed } : p;
    });
  } catch (e) {
    console.error("[lingo-dojo] cloze: the sentences couldn't be read; no cloze this time:", e);
    return phrases;
  }
}

/**
 * Start writing sentences for the first CLOZE_BATCH of `wanted` (the
 * queue's order: due first), unless a call is already going for this
 * language or the last one failed less than RETRY_AFTER_MS ago. Returns at
 * once; the call happens after the request.
 */
export function fillCloze(ctx: LearnerCtx, wanted: CandidatePhrase[]): void {
  const batch = wanted.filter((p) => p.text && p.meaning).slice(0, CLOZE_BATCH);
  const id = ctx.language.id;
  if (!batch.length || filling.has(id) || (retryAt.get(id) ?? 0) > Date.now()) return;
  const profile: LanguageProfileRef = { id, learnerId: ctx.language.learnerId };
  const opts = {
    userId: ctx.user.id,
    locale: targetLocale(ctx),
    level: ctx.language.level,
    targetVariant: ctx.language.targetVariant || ctx.language.targetLanguage || "the target language",
    nativeLanguage: ctx.learner.nativeLanguage || "English",
  };
  const run = write(profile, batch, opts)
    .catch((e) => {
      retryAt.set(id, Date.now() + RETRY_AFTER_MS);
      console.error("[lingo-dojo] cloze: writing sentences failed:", e);
    })
    .finally(() => {
      if (filling.get(id) === run) filling.delete(id);
    });
  filling.set(id, run);
}

/** One call for `batch`, then its rows. */
async function write(
  profile: LanguageProfileRef,
  batch: CandidatePhrase[],
  opts: { userId: string; locale: string; level: string; targetVariant: string; nativeLanguage: string },
): Promise<void> {
  const sent = batch.map((p) => ({ id: p.id, text: p.text ?? "", meaning: p.meaning ?? "", key: clozeKey(p) }));
  const { system, user } = clozePrompt({ phrases: sent, targetVariant: opts.targetVariant, nativeLanguage: opts.nativeLanguage, level: opts.level, locale: opts.locale });
  let text: string;
  try {
    text = await paidSlot(opts.userId, async () => {
      const { result } = startClaude({ prompt: user, systemPrompt: system, model: CLOZE_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: CALL_TIMEOUT_SEC });
      return (await result).text;
    });
  } catch (e) {
    // Both paid slots busy (audio, a transcription): not a failure, the
    // next queue tries again.
    if (e instanceof HttpError && e.status === 429) return;
    const msg = String((e as Error)?.message || e);
    throw new Error(failureHint(msg) || msg);
  }
  const parsed = parseClozeReply(text, { phrases: sent, locale: opts.locale, level: opts.level });
  if (!parsed.ok) throw new Error(`the reply wasn't usable (${parsed.error})`);
  if (parsed.dropped) console.warn(`[lingo-dojo] cloze: ${parsed.dropped} sentence(s) from the model failed the checks and were dropped`);
  const kept = await storeGenerated(
    rawDb(),
    profile,
    sent.map((p, i) => ({ phraseId: p.id, phraseKey: p.key, sentences: parsed.sentences[i] })),
  );
  console.log(`[lingo-dojo] cloze: ${kept} sentence(s) kept for ${sent.length} phrase(s)`);
}
