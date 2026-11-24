import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { scoresTones } from "../../scripts/pronunciation.mjs";
import { readScoreAudio, SCORE_MAX_BYTES } from "../../scripts/pronunciation-app.mjs";
import { removeClip, writeClip } from "../../scripts/pronunciation-clips.mjs";
import { coachingOf, flagNote, hanOf, liveFlags, liveRecord, liveReply, liveTarget, liveWordFlags, liveWordNote, liveWordsReply, liveWordTarget, wordsKey } from "../../scripts/pronunciation-live.mjs";
import { wordsReply } from "../../scripts/pronunciation-words.mjs";
import { pronunciationBlock, wordPronunciationBlock } from "../../scripts/voice.mjs";
import type { CheckDraft } from "../../scripts/db/pronunciation.ts";
import type { Coaching, LivePronunciation, PronunciationWordsReply } from "../shared/wire.ts";
import type { LearnerCtx } from "./auth.ts";
import { liveWordsReady, scoreLive, scoreLiveWords, type LiveScore, type LiveWordScore } from "./pronunciation.ts";
import { HttpError } from "./sse.ts";

// Pronunciation in live conversation (stage 2, ld-ne0.3; docs/VOICE.md
// §Pronunciation in conversation). A Go-tab turn reaches the server as two
// requests: the recording to /api/voice/transcribe, then the words to
// /api/voice/turn. Scoring needs both halves (the audio from the first, the
// words the learner actually sent from the second), so it starts as soon as
// the transcription is known and runs while the browser shows the words and
// sends the turn; the turn then waits for it a short, bounded time
// (LIVE.waitMs from the turn's arrival, beside the turn's own reads), and
// goes on without it past that. A late score is dropped, not carried to the
// next turn: a step-in about a word from two turns back reads as a non
// sequitur, and its marks would land on a line long passed.
//
// What is held between the two requests, in this process's memory only:
// one entry per learner and language (so at most one recording, of at most
// 30 seconds, per learner: a page can't pile them up by naming made-up
// conversations), holding the conversation it was for, the latest
// transcription's score (a promise), its Han characters, and the recording
// itself (needed only if the turn flags it and keeps the clip). Held at most
// LIVE.ttlMs, taken by the first turn of that conversation, and replaced by
// any newer transcription. A turn whose words aren't what was scored
// (edited in the box, typed, another transcription) uses none of it. The
// conversation id is checked by the turn (openConversation), not here.
//
// A language beyond Mandarin that the word check measures (ld-ne0.17;
// docs/VOICE.md §Words in conversation) goes the same way with Azure's word
// check in place of the tone scorer: held under the same key, matched by the
// line's letters instead of its Han characters, told to the dojo master by
// word. Nothing of a word check is stored: no row, no clip.

/** The turn's wait and how long a score is held. Mutable for the tests,
 *  like pronunciation.ts SCORER. */
export const LIVE = {
  /** How long a turn waits for its score, counted from the turn's arrival
   *  (the turn's recall reads run meanwhile). The local scorer is done in a
   *  few hundred ms, usually before the turn arrives; Azure answers short
   *  audio in about a second. */
  waitMs: 1200,
  /** How long a score waits for its turn (the box may hold the words while
   *  the learner edits them). */
  ttlMs: 120_000,
};

type Outcome = LiveScore | LiveWordScore;
interface Pending {
  conversationId: string;
  /** What was scored: tones (Mandarin) or words (ld-ne0.17). */
  kind: "tones" | "words";
  /** What the turn's message must match: the scored text's Han characters
   *  (tones) or its letters (words: wordsKey). */
  key: string;
  /** Words only: the text Azure was given and the Azure locale, for the
   *  marks. */
  text: string;
  azureLocale: string;
  locale: string;
  kids: boolean;
  wav: Uint8Array;
  at: number;
  done: Promise<Outcome>;
  /** Aborted when the score is dropped unused: the Azure request and the
   *  worker stop and give their places back (pronunciation.ts scoreLive). */
  stop: AbortController;
}

const pending = new Map<string, Pending>();
const keyOf = (ctx: LearnerCtx) => `${ctx.learner.id}:${ctx.language.id}`;

/** Forget what is held under `key`, stopping its scoring if it still runs
 *  (a no-op once it has finished). */
function drop(key: string): void {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  p.stop.abort();
}

function sweep(now = Date.now()): void {
  for (const [k, p] of pending) if (now - p.at > LIVE.ttlMs) drop(k);
}

/** For the tests: forget everything held, stopping what still runs. */
export function clearLive(): void {
  for (const k of [...pending.keys()]) drop(k);
}

/**
 * The dial a request carries (`coaching`, a query parameter on the
 * transcription, a body field on the turn): one of the three words for an
 * adult (absent: "light"), else a 400; a kids session has no dial, and any
 * value from one is a 400 too. → the adult's word, or "kids".
 */
export function requestCoaching(ctx: LearnerCtx, raw: unknown): Coaching | "kids" {
  if (ctx.learner.mode === "kids") {
    if (raw != null && raw !== "") throw new HttpError(400, "kids sessions have no coaching dial");
    return "kids";
  }
  const c = coachingOf(raw);
  if (!c) throw new HttpError(400, "coaching must be off, light or strict");
  return c;
}

/** The transcription's `coaching` parameter, checked before anything is
 *  read or paid for (a 400 costs no transcription). */
export function transcribeCoaching(req: IncomingMessage, ctx: LearnerCtx): Coaching | "kids" {
  return requestCoaching(ctx, new URL(req.url ?? "/", "http://localhost").searchParams.get("coaching"));
}

/**
 * Start scoring a Go-tab transcription (called by the transcribe route once
 * it has the text, never awaited: the words go back to the page at once).
 * Only a listening turn of a saved conversation, in a Mandarin locale
 * (`locale`: the transcription's target, the page's first locale), with the
 * dial on, whose transcript is Mandarin alone and short (liveTarget); or,
 * in a locale the word check measures, with Azure's keys set, whose
 * transcript is a phrase the word check takes (liveWordTarget).
 * Anything else clears what was held for the conversation, so a turn never
 * picks up an older recording's score.
 */
export function startLive(ctx: LearnerCtx, { conversationId, text, wav, locale, coaching }: { conversationId: string; text: string; wav: Uint8Array; locale: string; coaching: Coaching | "kids" }): void {
  const key = keyOf(ctx);
  // A newer transcription replaces the older one's score, stopping it.
  drop(key);
  sweep();
  if (coaching === "off") return;
  const tones = scoresTones(locale);
  // Words: only where Azure can answer (there is no local word scorer), so
  // no recording is held for a check that can't run.
  const words = tones ? null : liveWordsReady() ? liveWordTarget(text, locale) : null;
  const target = tones ? liveTarget(text) : null;
  if (tones ? target!.skip !== undefined : !words || words.skip !== undefined) return;
  // Only a recording the scorer takes is held: within the scorer's byte cap
  // (a WAV whose header says 30 s but carries megabytes after it is never
  // held, sent to Azure or kept as a clip) and 16 kHz mono PCM of 0.25 to
  // 30 s; anything else would be a skip anyway.
  if (wav.length > SCORE_MAX_BYTES || readScoreAudio(wav).error !== undefined) return;
  const kids = coaching === "kids";
  const stop = new AbortController();
  if (words && words.skip === undefined) {
    const done = scoreLiveWords(ctx, { wav, text: words.text, locale: words.locale, signal: stop.signal }).catch((): Outcome => ({ skip: "failed" }));
    pending.set(key, { conversationId, kind: "words", key: wordsKey(words.text), text: words.text, azureLocale: words.locale, locale, kids, wav, at: Date.now(), done, stop });
    return;
  }
  const scored = target!.text!;
  const done = scoreLive(ctx, { wav, text: scored, locale, kids, signal: stop.signal }).catch((): Outcome => ({ skip: "failed" }));
  pending.set(key, { conversationId, kind: "tones", key: hanOf(scored), text: scored, azureLocale: "", locale, kids, wav, at: Date.now(), done, stop });
}

/** A scored turn's check, its audio written to the clips directory first
 *  when it was flagged (named by the check's id), for saveTurn to keep or
 *  refuse (the per-session cap). A write that fails costs the clip only:
 *  the check is kept without audio. */
export function offerClip(conversationId: string, check: NonNullable<LiveTurn["check"]>): CheckDraft {
  const { wav, durationMs, ...draft } = check;
  // startLive held nothing larger; checked again where the file is made.
  if (!wav || wav.length > SCORE_MAX_BYTES) return { ...draft, clip: null };
  try {
    const file = writeClip(conversationId, check.id, wav);
    return { ...draft, clip: { file, bytes: wav.length, ms: Math.max(1, durationMs) } };
  } catch (e) {
    console.error(`[lingo-dojo] pronunciation (live): a clip couldn't be written (${(e as NodeJS.ErrnoException)?.code ?? "error"}); the check is kept without it`);
    return { ...draft, clip: null };
  }
}

/** Remove a clip offered but not kept (past the cap, or the turn unsaved). */
export function dropClip(conversationId: string, file: string): void {
  try {
    removeClip(conversationId, file);
  } catch (e) {
    console.error(`[lingo-dojo] pronunciation (live): a clip that wasn't kept couldn't be removed (${(e as NodeJS.ErrnoException)?.code ?? "error"})`);
  }
}

/** What a turn takes from its score: the block for the prompt ("" with
 *  nothing to say), the marks (adults), and what the turn's row keeps. */
export interface LiveTurn {
  block: string;
  /** Tone marks (Mandarin) or word marks (`kind: "words"`, ld-ne0.17). */
  marks: LivePronunciation | PronunciationWordsReply | null;
  /** Adults only: the check to store with the turn (saveTurn). */
  check: (CheckDraft & { wav: Uint8Array | null; durationMs: number }) | null;
}

/**
 * The score of the transcription this turn's message came from, waited for
 * until `deadline` (ms since the epoch), or null: none held, another
 * session's or language's, words that aren't what was scored, the dial
 * turned off since, a skip, or late. Taken either way (a score is used by
 * one turn at most). Never throws.
 */
export async function takeLive(ctx: LearnerCtx, { conversationId, message, locale, coaching, deadline }: { conversationId: string; message: string; locale: string; coaching: Coaching | "kids"; deadline: number }): Promise<LiveTurn | null> {
  const key = keyOf(ctx);
  const p = pending.get(key);
  if (!p || p.conversationId !== conversationId) return null;
  pending.delete(key);
  const kids = coaching === "kids";
  if (Date.now() - p.at > LIVE.ttlMs || coaching === "off" || kids !== p.kids || p.locale !== locale || !p.key || (p.kind === "words" ? wordsKey(message) : hanOf(message)) !== p.key) {
    // Not this turn's: nothing will ever use it.
    p.stop.abort();
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()));
  });
  const out = await Promise.race([p.done, late]);
  clearTimeout(timer);
  if (out === "late") {
    // Stop it: the Azure request and the worker give their places back now,
    // not when they would have finished.
    p.stop.abort();
    console.log("[lingo-dojo] pronunciation (live): the score came too late for its turn; dropped");
    return null;
  }
  if ("skip" in out) return null;
  // The dial as the turn sent it (light or strict), for an adult; kids get
  // the gentle rule whatever.
  const dial: "light" | "strict" = kids ? "light" : coaching === "strict" ? "strict" : "light";
  if ("marks" in out) {
    // A word check (ld-ne0.17): the block and the marks only. Nothing is
    // stored, so no check and no clip.
    const flagged = liveWordFlags(out.marks, out.azure);
    const block = wordPronunciationBlock(flagged.map((i) => liveWordNote(out.marks, i, p.azureLocale)), { mode: kids ? "kids" : "adult", coaching: dial });
    // Azure heard none of the words the transcriber wrote: the two
    // disagree about the whole line, so there is nothing to show (the
    // explicit check's "none of the words were recognised as this phrase"
    // would be about a phrase nobody asked for).
    if (kids || out.marks.heard === "none") return { block, marks: null, check: null };
    return { block, marks: liveWordsReply(wordsReply(out.marks, { kids: false, text: p.text, locale: p.azureLocale }), flagged), check: null };
  }
  const flags = liveFlags(out.result);
  const notes = flags.map((i) => flagNote(out.result, i));
  const block = pronunciationBlock(notes, { mode: kids ? "kids" : "adult", coaching: dial });
  if (kids) return { block, marks: null, check: null };
  const id = randomUUID();
  return {
    block,
    marks: liveReply(out.reply, flags) as LivePronunciation,
    check: {
      id,
      engine: out.engine,
      coaching: dial,
      syllables: liveRecord(out.result, flags),
      flagged: flags.length,
      clip: null,
      // Only a flagged turn's audio is ever offered for keeping.
      wav: flags.length ? p.wav : null,
      durationMs: Math.round(out.durationMs),
    },
  };
}
