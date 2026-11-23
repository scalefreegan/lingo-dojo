// Pronunciation in sessions (docs/DATA.md §Pronunciation in sessions,
// migration 0022, bead ld-ne0.3): one pronunciation_checks row per scored
// learner turn of an adult Go-tab session, and the flagged turns' clips.
// Written inside the turn's own transaction (web/server/conversations.ts
// saveTurn), so a check exists only for a stored turn; read back by the clip
// route (web/server/pronunciation.ts).
//
// Owner scoping lives here: every query goes through forLanguageProfile
// (scripts/db/owned.ts). Erasable TypeScript only, like schema.ts.

import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { pronunciationChecks } from "./schema.ts";

/** Clips kept per conversation: each is one turn's WAV, at most the
 *  scorer's SCORE_MAX_BYTES (30 seconds of 16 kHz 16-bit mono plus 4 KiB of
 *  header room: under 1 MB; livePronunciation.ts holds and writes nothing
 *  larger), so a session keeps under 20 MB. Past it a flagged turn still
 *  gets its row, without audio. */
export const MAX_CLIPS_PER_CONVERSATION = 20;

/** What a scored turn keeps. `clip`: a file already written under the
 *  check's id (scripts/pronunciation-clips.mjs writeClip), offered for
 *  keeping; null when the turn has no flag. */
export interface CheckDraft {
  id: string;
  engine: "azure" | "local";
  coaching: "light" | "strict";
  syllables: Record<string, unknown>[];
  flagged: number;
  clip: { file: string; bytes: number; ms: number } | null;
}

/**
 * Store a turn's check (inside the turn's transaction, which holds the
 * conversation row FOR UPDATE, so two turns can't both take the last clip
 * place). → whether the offered clip was kept: false past the per-session
 * cap, when the caller removes the file.
 */
export async function recordCheck(db: Db, profile: LanguageProfileRef, conversationId: string, turnId: string, draft: CheckDraft): Promise<{ clipKept: boolean }> {
  const mine = forLanguageProfile(db, profile);
  let keep = false;
  if (draft.clip && draft.flagged > 0) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pronunciationChecks)
      .where(mine.where(pronunciationChecks, and(eq(pronunciationChecks.conversationId, conversationId), isNotNull(pronunciationChecks.clipFile)) as SQL));
    keep = (Number(row?.n) || 0) < MAX_CLIPS_PER_CONVERSATION;
  }
  await mine.insert(pronunciationChecks, {
    id: draft.id,
    conversationId,
    turnId,
    engine: draft.engine,
    coaching: draft.coaching,
    syllables: draft.syllables,
    flagged: draft.flagged,
    ...(keep && draft.clip ? { clipFile: draft.clip.file, clipBytes: draft.clip.bytes, clipMs: draft.clip.ms } : {}),
  });
  return { clipKept: keep };
}

/** A kept clip of this language's, by its check's id: null when there is
 *  no such check, it isn't this language's, or it kept no audio. */
export async function clipOf(db: Db, profile: LanguageProfileRef, id: string): Promise<{ conversationId: string; file: string; bytes: number } | null> {
  const row = await forLanguageProfile(db, profile).get(pronunciationChecks, eq(pronunciationChecks.id, id));
  if (!row?.clipFile) return null;
  return { conversationId: row.conversationId, file: row.clipFile, bytes: row.clipBytes ?? 0 };
}

/** This language's checks of one conversation, oldest first (stage 3 and
 *  the tests). */
export async function checksOf(db: Db, profile: LanguageProfileRef, conversationId: string) {
  return forLanguageProfile(db, profile).list(pronunciationChecks, eq(pronunciationChecks.conversationId, conversationId), { orderBy: pronunciationChecks.createdAt });
}
