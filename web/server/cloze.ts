import os from "node:os";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { CLOZE_BATCH, CLOZE_DAILY_CALLS, clozeKey, clozePrompt, clozeWritable, parseClozeReply } from "../../scripts/cloze.mjs";
import { clozeCallDone, clozeCallStarted, clozeCallsSince, clozeStates, storeGenerated } from "../../scripts/db/cloze.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import type { CandidatePhrase } from "../../scripts/practice.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { BackgroundBusy, backgroundSlot } from "./paid.ts";

// Cloze sentences for the Practice tab (docs/DATA.md §Practice modes, "As
// built (phase 7c: cloze)"). The queue reads what each phrase has
// (scripts/db/cloze.ts clozeStates: its own session lines first, no
// model). Only a session being started (the queue route in the cloze or
// mixed mode, never the counts or the page's poll) has sentences written,
// and only for the phrases that session would ask as a gap
// (practice.mjs clozeWanted: at most its length), by tool-less
// `claude -p` calls of up to CLOZE_BATCH phrases each, in the background:
//  - never in the queue's way: the queue answers with the sentences that
//    exist (a phrase without one waits, or is said aloud in mixed); the
//    page may poll the counts while a call runs, and that starts nothing;
//  - at most CLOZE_DAILY_CALLS calls per language profile in any 24 hours,
//    counted from a ledger written as each call starts (cloze_calls, apart
//    from the sentence cache an edit or delete clears), so a failed call
//    counts and a restart doesn't reset it;
//  - one run at a time per language profile, its calls one after another,
//    each in the user's single background slot (paid.ts), apart from the
//    interactive slots audio and transcription use; a busy slot skips the
//    run (the next session started tries again), and a failed call stops
//    the run and waits RETRY_AFTER_MS before the next try;
//  - no transaction or row lock is held while the model writes; the rows
//    are inserted after, one phrase at a time;
//  - the reply is model output: parsed strictly as the JSON asked for,
//    cleaned and capped, and every sentence checked (cloze.mjs) before it
//    is kept; a phrase the reply gave nothing usable (or a reply that
//    wasn't the JSON asked for, which was paid all the same) is marked as
//    tried, so the same words and meaning don't pay again for 30 days. A
//    failure only means no cloze for the phrase now.

/** Sentences are worth a stronger model than a yes/no grade: once per
 *  phrase, and the learner reads them over and over. */
const CLOZE_MODEL = "claude-sonnet-5-5";
const CALL_TIMEOUT_SEC = 120;
/** After a failed call (the CLI, a limit, a timeout). */
export const RETRY_AFTER_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The run going on per language profile. */
const filling = new Map<string, Promise<void>>();
/** Per language profile: when a call may be tried again after a failure. */
const retryAt = new Map<string, number>();

/** Resolves when every run started so far has finished (the tests). */
export async function settleClozeFills(): Promise<void> {
  while (filling.size) await Promise.allSettled([...filling.values()]);
}

/** Forget the in-memory backoff (the tests: a restart). */
export function resetClozeMemory(): void {
  retryAt.clear();
}

/** Whether sentences are being written for this language now. */
export const clozeWriting = (profileId: string): boolean => filling.has(profileId);

const targetLocale = (ctx: LearnerCtx) => localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
const profileOf = (ctx: LearnerCtx): LanguageProfileRef => ({ id: ctx.language.id, learnerId: ctx.language.learnerId });
const callsToday = (profile: LanguageProfileRef) => clozeCallsSince(rawDb(), profile, new Date(Date.now() - DAY_MS));

/**
 * What the page says about sentences for this language: being written
 * now, written at all (a language whose words take endings isn't:
 * cloze.mjs UNWRITTEN), and today's calls used up.
 */
export async function clozeStatus(ctx: LearnerCtx): Promise<{ writing: boolean; writable: boolean; limited: boolean }> {
  const writable = clozeWritable(targetLocale(ctx));
  let limited = false;
  if (writable) {
    try {
      limited = (await callsToday(profileOf(ctx))) >= CLOZE_DAILY_CALLS;
    } catch (e) {
      console.error("[lingo-dojo] cloze: today's calls couldn't be counted:", e);
    }
  }
  return { writing: clozeWriting(ctx.language.id), writable, limited };
}

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
 * Start writing sentences for `wanted` (a started session's phrases, in
 * its order: due first), in batches of CLOZE_BATCH, one call after
 * another, while today's calls last; unless a run is already going for
 * this language or the last call failed less than RETRY_AFTER_MS ago.
 * Resolves once the run is started (or not); the calls happen after the
 * request.
 */
export async function fillCloze(ctx: LearnerCtx, wanted: CandidatePhrase[]): Promise<void> {
  const list = wanted.filter((p) => p.text && p.meaning);
  const id = ctx.language.id;
  if (!list.length || filling.has(id) || (retryAt.get(id) ?? 0) > Date.now() || !clozeWritable(targetLocale(ctx))) return;
  const profile = profileOf(ctx);
  const opts = {
    userId: ctx.user.id,
    locale: targetLocale(ctx),
    level: ctx.language.level,
    targetVariant: ctx.language.targetVariant || ctx.language.targetLanguage || "the target language",
    nativeLanguage: ctx.learner.nativeLanguage || "English",
  };
  const run = (async () => {
    for (let i = 0; i < list.length; i += CLOZE_BATCH) {
      if ((await callsToday(profile)) >= CLOZE_DAILY_CALLS) {
        console.log("[lingo-dojo] cloze: today's calls for this language are used up");
        return;
      }
      if (!(await write(profile, list.slice(i, i + CLOZE_BATCH), opts))) return;
    }
  })()
    .catch((e) => {
      retryAt.set(id, Date.now() + RETRY_AFTER_MS);
      console.error("[lingo-dojo] cloze: writing sentences failed:", e);
    })
    .finally(() => {
      if (filling.get(id) === run) filling.delete(id);
    });
  filling.set(id, run);
}

/** One call for `batch`, then its rows; false when the background slot
 *  was busy (the run stops; nothing was paid). */
async function write(
  profile: LanguageProfileRef,
  batch: CandidatePhrase[],
  opts: { userId: string; locale: string; level: string; targetVariant: string; nativeLanguage: string },
): Promise<boolean> {
  const sent = batch.map((p) => ({ id: p.id, text: p.text ?? "", meaning: p.meaning ?? "", key: clozeKey(p) }));
  const { system, user } = clozePrompt({ phrases: sent, targetVariant: opts.targetVariant, nativeLanguage: opts.nativeLanguage, level: opts.level, locale: opts.locale });
  let text: string;
  let callId = "";
  try {
    text = await backgroundSlot(opts.userId, async () => {
      // In the ledger before the model is asked: a call that then fails
      // was (or may have been) paid all the same. No entry, no call.
      callId = await clozeCallStarted(rawDb(), profile, sent.length, new Date(Date.now() - DAY_MS));
      const { result } = startClaude({ prompt: user, systemPrompt: system, model: CLOZE_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: CALL_TIMEOUT_SEC });
      return (await result).text;
    });
  } catch (e) {
    // Another language of this user's is writing: not a failure.
    if (e instanceof BackgroundBusy) return false;
    const msg = String((e as Error)?.message || e);
    throw new Error(failureHint(msg) || msg);
  }
  const parsed = parseClozeReply(text, { phrases: sent, locale: opts.locale, level: opts.level, nativeLanguage: opts.nativeLanguage });
  // A reply that isn't the JSON asked for was paid all the same: its
  // phrases are marked as tried (and the call counts toward the cap).
  const sentences = parsed.ok ? parsed.sentences : sent.map(() => []);
  if (!parsed.ok) console.warn(`[lingo-dojo] cloze: the reply wasn't usable (${parsed.error}); its phrases are marked as tried`);
  else if (parsed.dropped) console.warn(`[lingo-dojo] cloze: ${parsed.dropped} sentence(s) from the model failed the checks and were dropped`);
  const kept = await storeGenerated(
    rawDb(),
    profile,
    sent.map((p, i) => ({ phraseId: p.id, phraseKey: p.key, sentences: sentences[i] })),
  );
  // Only for diagnosis: the call counts already.
  await clozeCallDone(rawDb(), profile, callId, kept).catch((e) => console.warn("[lingo-dojo] cloze: the call's outcome wasn't noted:", String(e?.message || e)));
  console.log(`[lingo-dojo] cloze: ${kept} sentence(s) kept for ${sent.length} phrase(s)`);
  return true;
}
