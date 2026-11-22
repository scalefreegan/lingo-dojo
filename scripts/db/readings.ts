// A learner's own Mandarin readings (docs/DATA.md §Reading corrections,
// migration 0015, bead ld-4i2): the words this language profile corrected
// or confirmed by hand, and the readings its recaps settled. The one data
// layer for them (the routes in web/server/readings.ts, the recap in
// web/server/extraction.ts, the tests).
//
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile (scripts/db/owned.ts), so one learner's corrections
// never reach another learner, or another of this learner's languages.
// Every reading written here was checked first (zh.ts validateCorrection,
// or validateHint for the recap's); this file stores, it doesn't judge.
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { asc, eq, sql } from "drizzle-orm";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { phrases, readingCorrections } from "./schema.ts";

export type CorrectionKind = "corrected" | "confirmed" | "suggested";

export interface CorrectionRow {
  key: string;
  word: string;
  reading: string;
  kind: CorrectionKind;
  source: "user" | "recap";
  /** Which model call settled a recap row: "session" (a kids session's
   *  background check) or "recap"; null for a hand choice or an older row. */
  checkedBy: "session" | "recap" | null;
  updatedAt: Date;
}

/** The most corrections one language keeps: a bound on a runaway page,
 *  far past what a learner corrects by hand. */
export const MAX_CORRECTIONS = 5000;

const row = (r: typeof readingCorrections.$inferSelect): CorrectionRow => ({ key: r.key, word: r.word, reading: r.reading, kind: r.kind, source: r.source, checkedBy: r.checkedBy ?? null, updatedAt: r.updatedAt });

/** This language's corrections, by key. */
export async function listCorrections(db: Db, profile: LanguageProfileRef): Promise<CorrectionRow[]> {
  const rows = await forLanguageProfile(db, profile).list(readingCorrections, undefined, { orderBy: asc(readingCorrections.key), limit: MAX_CORRECTIONS });
  return rows.map(row);
}

/** The learner's choice by hand: a correction or a confirmation, replacing
 *  whatever this language had for the word (a recap's included). */
export async function saveCorrection(db: Db, profile: LanguageProfileRef, c: { key: string; word: string; reading: string; kind: "corrected" | "confirmed" }): Promise<CorrectionRow> {
  const [r] = await forLanguageProfile(db, profile).upsert(
    readingCorrections,
    { key: c.key, word: c.word, reading: c.reading, kind: c.kind, source: "user" },
    { target: [readingCorrections.key], set: { word: c.word, reading: c.reading, kind: c.kind, source: "user", checkedBy: null, updatedAt: sql`now()` } },
  );
  return row(r);
}

/**
 * What a recap settled for this learner: `suggested` (the model's reading,
 * which differs from the reader's) or `confirmed` (it agreed). Never over a
 * choice the learner made by hand: that row stays as it is, and false says
 * so. A recap made again replaces its own earlier rows.
 */
export async function saveRecapReading(db: Db, profile: LanguageProfileRef, c: { key: string; word: string; reading: string; kind: "suggested" | "confirmed"; checkedBy?: "session" | "recap" }): Promise<boolean> {
  const mine = forLanguageProfile(db, profile);
  const checkedBy = c.checkedBy ?? "recap";
  const made = await mine.insertOrIgnore(readingCorrections, { key: c.key, word: c.word, reading: c.reading, kind: c.kind, source: "recap", checkedBy }, { target: [readingCorrections.key] });
  if (made.length) return true;
  const updated = await mine.update(readingCorrections, { word: c.word, reading: c.reading, kind: c.kind, checkedBy, updatedAt: sql`now()` }, sql`${readingCorrections.key} = ${c.key} and ${readingCorrections.source} = 'recap'`);
  return updated.length > 0;
}

/** Undo what a model settled for this learner (ld-0mn: the grown-up's
 *  "Back to waiting"): the word's `recap` row is removed, so the word is
 *  uncertain again. A hand choice is never removed here. True when a row
 *  went. */
export async function removeRecapReading(db: Db, profile: LanguageProfileRef, key: string): Promise<boolean> {
  const gone = await forLanguageProfile(db, profile).remove(readingCorrections, sql`${readingCorrections.key} = ${key} and ${readingCorrections.source} = 'recap'`);
  return gone.length > 0;
}

/** The bank's phrases of this language whose words hold `word` (either
 *  spelling: `forms`), at most `limit`: the ones a correction rereads. */
export async function phrasesWith(db: Db, profile: LanguageProfileRef, forms: string[], limit = 200): Promise<{ id: string; text: string; reading: string | null }[]> {
  const uniq = [...new Set(forms.filter(Boolean))];
  if (!uniq.length) return [];
  const any = sql.join(
    uniq.map((f) => sql`strpos(${phrases.text}, ${f}) > 0`),
    sql` or `,
  );
  const rows = await forLanguageProfile(db, profile).list(phrases, sql`${phrases.text} is not null and (${any})`, { limit });
  return rows.map((p) => ({ id: p.id, text: p.text!, reading: p.reading }));
}

/** Store a bank phrase's reading (one checked syllable per character of
 *  its text, or null: the reader's own), unless its words changed since
 *  they were read (`text`). */
export async function setPhraseReading(db: Db, profile: LanguageProfileRef, id: string, text: string, reading: string | null): Promise<boolean> {
  const done = await forLanguageProfile(db, profile).update(phrases, { reading }, sql`${phrases.id} = ${id} and ${phrases.text} = ${text}`);
  return done.length > 0;
}

/** One word's row, if this language has one. */
export async function correctionFor(db: Db, profile: LanguageProfileRef, key: string): Promise<CorrectionRow | null> {
  const r = await forLanguageProfile(db, profile).get(readingCorrections, eq(readingCorrections.key, key));
  return r ? row(r) : null;
}
