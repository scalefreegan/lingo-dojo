import type { IncomingMessage, ServerResponse } from "node:http";
import { localeFor } from "../../scripts/voice.mjs";
import { MAX_RECAP_READINGS, parseRecapReadings } from "../../scripts/extraction.mjs";
import { listCorrections, phrasesWith, saveCorrection, saveRecapReading, setPhraseReading, type CorrectionRow } from "../../scripts/db/readings.ts";
import { SharedFullError, SharedLimitError, activeList, adminList, confirm, exportActive, propose, recordUses, remove, usesSince, type SharedEntry } from "../../scripts/db/sharedReadings.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import type { MyReading, MyReadingsReply, ReadingSaveReply, SharedReadingsAdminReply, SharedReadingsReply } from "../shared/readings.ts";
import { charReadings, correctionKey, correctionScope, makeCorrections, readCodePoints, readDetail, uncertainWords, validateCorrection, validateHint, type CorrectionEntry, type Corrections } from "../src/script/zh.ts";
import { isHan } from "../src/script/script.ts";
import { learnerMode, type Ctx, type LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { readsHints } from "./hints.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// Mandarin readings settled by people (docs/VOICE.md §Uncertain readings,
// docs/DATA.md §Reading corrections and §Shared readings, bead ld-4i2).
//
//   GET  /api/readings/shared            → {version, entries}: the shared list's active entries
//                                          (any logged-in user; ETag = version, 304 when unchanged)
//   GET  /api/readings                   → {readings}: the active language's own
//   POST /api/readings {word, reading, kind}
//                                        → {reading, shared, phrases}: "This reading is wrong"
//                                          (kind corrected) or "This is right" (confirmed)
//   GET  /api/readings/admin             → {rows, changed30d}            (admin)
//   POST /api/readings/admin/:id/confirm → {rows, changed30d}            (admin)
//   DELETE /api/readings/admin/:id       → {rows, changed30d}            (admin)
//   GET  /api/readings/admin/export?format=yaml|json → a file of the active entries (admin)
//
// /api/readings is mounted with wrap's `learner: true`: the page must name
// the session's learner and language (else 409 stale_learner), and what it
// writes is that language's (forLanguageProfile in scripts/db/readings.ts).
// A kids learner gets no control (no marks are shown to a child): a write
// for one is a 403. Nothing unchecked is stored: every reading passes
// zh.ts validateCorrection (two to eight Chinese characters, each syllable
// a reading the character really has).

/** The active language's locale when it is Mandarin, else null. */
export const mandarinLocale = (lang: { targetLanguage: string; targetVariant: string }): string | null => {
  const locale = localeFor(lang.targetLanguage, lang.targetVariant) ?? null;
  return readsHints(locale) ? locale : null;
};

const wire = (r: CorrectionRow): MyReading => ({ word: r.word, reading: r.reading, kind: r.kind, source: r.source });

/**
 * The corrections a server-side read of this learner's text uses (the
 * recap's uncertain words, a bank phrase's stored reading): the learner's
 * own by hand and the recap's suggestions for them, and the shared list's
 * active entries. What the browser lays over the reader for them too.
 */
export async function correctionsFor(profile: LanguageProfileRef | null, opts: { shared?: boolean } = {}): Promise<Corrections> {
  const db = rawDb();
  const mine = profile ? await listCorrections(db, profile) : [];
  const shared = opts.shared === false ? [] : (await activeList(db)).entries;
  return makeCorrections(splitMine(mine, shared));
}

/**
 * A learner's rows as a corrections set's lists: only what they chose by
 * hand (source "user") ranks as their own; a recap's agreement with the
 * reader only clears the mark (`checked`, below the shared list), its
 * differing answer is a suggestion. The browser splits them the same way
 * (script/ruby.tsx).
 */
export function splitMine<T extends { kind: string; source: string }>(mine: readonly T[], shared: readonly CorrectionEntry[]) {
  return {
    mine: mine.filter((r) => r.source === "user" && r.kind !== "suggested"),
    suggested: mine.filter((r) => r.kind === "suggested"),
    checked: mine.filter((r) => r.source === "recap" && r.kind === "confirmed"),
    shared,
  };
}

/**
 * The bank phrases of this language that hold `word` read again with the
 * learner's corrections, and their stored reading (phrases.reading, what
 * Practice's tone check and the picture game read on the server) set where
 * it now differs from the reader's own, as a dojo master's hint is kept
 * only where it differs (hints.ts). Returns how many changed.
 */
export async function rereadPhrases(profile: LanguageProfileRef, locale: string, word: string): Promise<number> {
  const db = rawDb();
  const found = await phrasesWith(db, profile, [word, correctionKey(word)]);
  if (!found.length) return 0;
  const fixes = await correctionsFor(profile);
  let changed = 0;
  for (const p of found) {
    const base = readCodePoints(p.text, locale, { cache: false, corrections: null });
    const now = readDetail(p.text, locale, { cache: false, corrections: fixes });
    const han = [...p.text].map((c, k) => (isHan(c) ? k : -1)).filter((k) => k >= 0);
    if (han.length < 2) continue;
    // Start from what the phrase holds (a dojo master's hint, a recap's
    // reading), else the reader's; a word a person settled (theirs, or the
    // shared list's) takes their reading over it, so a stored reading never
    // outranks a person's choice. The reader's own reading again: none.
    const stored = p.reading?.split(" ") ?? [];
    const out = han.map((k, i) => (now.fixed[k] === "mine" || now.fixed[k] === "shared" ? now.readings[k] : stored.length === han.length ? stored[i] : now.readings[k]));
    if (out.some((r) => !r)) continue;
    const reading = han.every((k, i) => out[i] === base[k]) ? null : out.join(" ");
    if (reading !== (p.reading ?? null) && (await setPhraseReading(db, profile, p.id, p.text, reading))) changed++;
  }
  return changed;
}

/* ---------------------------------- recap ---------------------------------- */

/** A stored turn as the recap reads it. */
interface TurnLike {
  role: string;
  fromClient?: boolean | null;
  lines?: { text?: string; segments?: { lang?: string; text?: string }[] }[] | null;
}

/** The dojo master's target-language text in `turns`, piece by piece (a
 *  line's target segments, else its text). Never the learner's words: a
 *  kids learner's are not sent anywhere for this, and an adult's are what
 *  the speech-to-text heard, not text the reader showed them. */
function masterTexts(turns: readonly TurnLike[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    if (t.role !== "master" || t.fromClient) continue;
    for (const l of t.lines ?? []) {
      const segs = (l.segments ?? []).filter((s) => s?.lang === "target" && typeof s.text === "string" && s.text.trim());
      if (segs.length) for (const s of segs) out.push(s.text!.normalize("NFC"));
      else if (typeof l.text === "string" && l.text.trim()) out.push(l.text.normalize("NFC"));
    }
  }
  return out;
}

/** One uncertain word of a session, as the recap is asked about it. */
export interface RecapWord {
  word: string;
  key: string;
  /** The dojo master's text it is in (the first). */
  sentence: string;
  /** Where it starts there, as a UTF-16 offset. */
  at: number;
  /** What the reader shows over it there (for this learner). */
  reading: string[];
}

/**
 * The uncertain words of a session's dojo-master lines (zh.ts
 * uncertainWords, read with this learner's corrections and the shared
 * list, so a word a person settled is not asked again): each once (by its
 * key), with the first line it is in, at most `max`, in order of
 * appearance.
 */
export function uncertainInTranscript(turns: readonly TurnLike[], locale: string, corrections: Corrections | null, max = MAX_RECAP_READINGS): RecapWord[] {
  const out: RecapWord[] = [];
  const seen = new Set<string>();
  for (const text of masterTexts(turns)) {
    for (const w of uncertainWords(text, locale, { cache: false, corrections })) {
      const key = correctionKey(w.word);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ word: w.word, key, sentence: text, at: [...text].slice(0, w.start).join("").length, reading: w.reading });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** How many words of a session's dojo-master lines the shared list read
 *  otherwise than the reader would have (the admin view's count). */
export function sharedChanges(turns: readonly TurnLike[], locale: string, shared: Corrections): number {
  if (!shared.shared.size) return 0;
  let n = 0;
  for (const text of masterTexts(turns)) {
    const base = readDetail(text, locale, { cache: false, corrections: null });
    const now = readDetail(text, locale, { cache: false, corrections: shared });
    for (let k = 0; k < now.fixed.length; ) {
      if (now.fixed[k] !== "shared") {
        k++;
        continue;
      }
      let e = k;
      let differs = false;
      // A run of the list's readings (two entries side by side count once).
      while (e < now.fixed.length && now.fixed[e] === "shared") {
        if (now.readings[e] !== base.readings[e]) differs = true;
        e++;
      }
      if (differs) n++;
      k = e;
    }
  }
  return n;
}

/** What became of one word the recap was asked about. */
export interface JudgedReading {
  word: string;
  key: string;
  sentence: string;
  at: number;
  /** The reader's reading there, space separated. */
  reader: string;
  /** The model's answer once checked (validateHint), or null. */
  answer: string | null;
  /** differs: checked, and not the reader's (a suggestion); agrees:
   *  checked, the reader's (confirmed for this learner); dropped: no
   *  answer, or one that failed a check. */
  verdict: "differs" | "agrees" | "dropped";
}

/** Tone marks and numbers: a syllable with none is toneless as written. */
const TONED = /[̀́̄̌1-4]/u;

/**
 * validateHint reads a toneless syllable as the reader's own tone (a hint
 * often leaves tones out), but in a recap's answer the neutral tone is the
 * point: "wèn de" says the reader's 问得 wèn dé is wrong. So a syllable
 * written without a tone keeps the character's neutral reading when it has
 * one (得 de, 着 zhe, 了 le); otherwise validateHint's reading stands. Only
 * when the answer splits into one syllable per character.
 */
function keptNeutral(word: string, raw: string, reading: string[], locale: string): string[] {
  const sylls = raw.normalize("NFD").toLowerCase().split(/[\s'’-]+/u).filter(Boolean);
  const chars = [...word.normalize("NFC")];
  if (sylls.length !== chars.length || reading.length !== chars.length) return reading;
  return reading.map((r, k) => {
    if (TONED.test(sylls[k]) && !/[50]$/.test(sylls[k])) return r;
    const bare = sylls[k].replace(/[05]$/, "").normalize("NFC");
    return charReadings(chars[k], locale).includes(bare) ? bare : r;
  });
}

/**
 * The recap's `readings` judged (pure, before anything is written): each
 * answer for a word it was asked about passes zh.ts validateHint (one
 * syllable per character, each a reading that character has, never
 * against the library's dictionary) or is dropped; an accepted one is
 * compared with the reader's reading in the line.
 */
export function judgeRecapReadings(asked: readonly RecapWord[], raw: unknown, locale: string): { judged: JudgedReading[]; stats: { offered: number; answered: number; accepted: number; differs: number; dropped: number } } {
  const { readings } = parseRecapReadings(raw, asked.map((w) => w.word));
  const answers = new Map(readings.map((r) => [r.word, r.pinyin]));
  const stats = { offered: asked.length, answered: readings.length, accepted: 0, differs: 0, dropped: 0 };
  const judged = asked.map((w): JudgedReading => {
    const base = { word: w.word, key: w.key, sentence: w.sentence, at: w.at, reader: w.reading.join(" ") };
    const raw = answers.get(w.word);
    const v = raw == null ? null : validateHint(w.word, raw, locale);
    if (!v || !v.ok) {
      stats.dropped++;
      return { ...base, answer: null, verdict: "dropped" };
    }
    stats.accepted++;
    const answer = keptNeutral(w.word, raw!, v.reading, locale).join(" ");
    if (answer === base.reader) return { ...base, answer, verdict: "agrees" };
    stats.differs++;
    return { ...base, answer, verdict: "differs" };
  });
  return { judged, stats };
}

/**
 * What a recap's judged readings write, once the recap itself is stored:
 * for this learner, a suggestion (differs) or a confirmation (agrees),
 * never over a choice they made by hand; a suggestion to the shared list,
 * a vote of the conversation's owner (`ownerId`: their recap and their own
 * confirmation are one source; another user must agree, or an admin
 * confirm); the bank phrases with a suggested word reread. Then the
 * session's count of readings the shared list changed.
 */
export async function settleRecapReadings(profile: LanguageProfileRef, ownerId: string, conversationId: string, locale: string, judged: readonly JudgedReading[], turns: readonly TurnLike[]): Promise<void> {
  const db = rawDb();
  for (const j of judged) {
    if (j.verdict === "dropped" || !j.answer) continue;
    const kind = j.verdict === "differs" ? "suggested" : "confirmed";
    const wrote = await saveRecapReading(db, profile, { key: j.key, word: j.word, reading: j.answer, kind });
    if (j.verdict !== "differs") continue;
    const v = validateCorrection(j.word, j.answer, locale);
    if (v.ok) {
      await propose(db, { word: v.word, key: j.key, reading: j.answer, scope: correctionScope(v.word, v.reading, locale) }, "recap", ownerId).catch((e) => {
        if (!(e instanceof SharedFullError || e instanceof SharedLimitError)) throw e;
      });
    }
    if (wrote) await rereadPhrases(profile, locale, j.word);
  }
  await recordUses(db, conversationId, sharedChanges(turns, locale, makeCorrections({ shared: (await activeList(db)).entries })));
}

/** One log line per recap that was asked to read: counts only, never the words. */
export function logRecapReadings(conversationId: string, s: ReturnType<typeof judgeRecapReadings>["stats"]): void {
  if (!s.offered) return;
  console.log(`[lingo-dojo] recap of conversation ${conversationId}: readings ${s.offered} asked, ${s.answered} answered, ${s.accepted} accepted (${s.differs} differ from the reader), ${s.dropped} dropped`);
}

/** /api/readings, mounted with wrap's `learner: true`. */
export async function handleReadings(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  const locale = mandarinLocale(ctx.language);
  if (req.method === "GET") {
    const rows = locale ? await listCorrections(rawDb(), ctx.language) : [];
    return sendJson(res, 200, { readings: rows.map(wire) } satisfies MyReadingsReply);
  }
  if (req.method !== "POST") return methodNotAllowed(res, "GET, POST");
  if (learnerMode(req, ctx) === "kids") throw new HttpError(403, "a kids learner's readings are not corrected by hand");
  if (!locale) throw new HttpError(400, "readings are corrected for Mandarin only");
  const body = (await readJsonBody(req)) as { word?: unknown; reading?: unknown; kind?: unknown } | null;
  const kind = body?.kind;
  if (kind !== "corrected" && kind !== "confirmed") throw new HttpError(400, 'kind is "corrected" or "confirmed"');
  const v = validateCorrection(body?.word, body?.reading, locale);
  if (!v.ok) {
    const why = { shape: "a word is two to eight Chinese characters", count: "one syllable for each character", unknown: "each syllable must be a reading its character has" }[v.why];
    throw new HttpError(400, `that reading can't be kept: ${why}`);
  }
  const reading = v.reading.join(" ");
  const key = correctionKey(v.word);
  const row = await saveCorrection(rawDb(), ctx.language, { key, word: v.word, reading, kind });
  // A correction goes to the shared list too (words and readings only):
  // active for an admin, else this user's vote for it. So does a
  // confirmation of a reading that isn't the reader's own (a recap's
  // suggestion the learner says is right); when it was the recap of their
  // own session, it is the same user's vote, so it stays a suggestion
  // until another user agrees or an admin confirms. A confirmation of the
  // reader's own reading changes nothing for anyone else.
  const own = readCodePoints(v.word, locale, { cache: false, corrections: null }).filter(Boolean).join(" ");
  let shared: ReadingSaveReply["shared"] = null;
  if (kind === "corrected" || reading !== own) {
    const entry: SharedEntry = { word: v.word, key, reading, scope: correctionScope(v.word, v.reading, locale) };
    shared = await propose(rawDb(), entry, ctx.user.isAdmin ? "admin" : "user", ctx.user.id).catch((e) => {
      if (e instanceof SharedFullError || e instanceof SharedLimitError) return null;
      throw e;
    });
  }
  const phrases = await rereadPhrases(ctx.language, locale, v.word);
  return sendJson(res, 200, { reading: wire(row), shared, phrases } satisfies ReadingSaveReply);
}

/** /api/readings/shared (any logged-in user). */
export async function handleSharedReadings(req: IncomingMessage, res: ServerResponse, _ctx: Ctx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  const list = await activeList(rawDb());
  const etag = `"${list.version}"`;
  // Revalidated each page load, never re-sent while unchanged.
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    return void res.end();
  }
  sendJson(res, 200, list satisfies SharedReadingsReply);
}

async function adminReply(): Promise<SharedReadingsAdminReply> {
  const db = rawDb();
  const rows = await adminList(db);
  return {
    rows: rows.map((r) => ({
      id: r.id, word: r.word, key: r.key, reading: r.reading, scope: r.scope, status: r.status, source: r.source, byUser: r.byUser, byRecap: r.byRecap, votes: r.votes,
      suggestedBy: r.suggestedByName, confirmedBy: r.confirmedByName, updatedAt: r.updatedAt.toISOString(),
    })),
    changed30d: await usesSince(db, 30),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The export: the active entries as YAML (a list of word, other spelling,
 *  reading, scope) or JSON. Words and readings only. */
export function exportText(entries: SharedEntry[], format: "yaml" | "json"): string {
  const list = entries.map((e) => ({ word: e.word, ...(e.key !== e.word ? { simplified: e.key } : {}), reading: e.reading, ...(e.scope !== "all" ? { scope: e.scope } : {}) }));
  if (format === "json") return `${JSON.stringify({ readings: list }, null, 2)}\n`;
  const q = (s: string) => JSON.stringify(s);
  return [
    "# Lingo Dojo: the shared list's active Mandarin readings (whole words).",
    "# Words and readings only. Fold into READING_FIXES / the pinyin sweep's",
    "# regression list, or report to pinyin-pro.",
    "readings:",
    ...list.map((e) => `  - { word: ${q(e.word)}${"simplified" in e ? `, simplified: ${q(e.simplified!)}` : ""}, reading: ${q(e.reading)}${"scope" in e ? `, scope: ${e.scope}` : ""} }`),
    "",
  ].join("\n");
}

/** /api/readings/admin, mounted with wrap's `auth: "admin"`. */
export async function handleReadingsAdmin(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (!parts.length) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return sendJson(res, 200, await adminReply());
  }
  if (parts.length === 1 && parts[0] === "export") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const format = new URL(req.url ?? "/", "http://localhost").searchParams.get("format") === "json" ? "json" : "yaml";
    res.writeHead(200, {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/yaml; charset=utf-8",
      "Content-Disposition": `attachment; filename="shared-readings.${format === "json" ? "json" : "yaml"}"`,
      "Cache-Control": "no-store",
    });
    return void res.end(exportText(await exportActive(rawDb()), format));
  }
  const [id, verb] = parts;
  if (!UUID_RE.test(id) || parts.length > 2) throw new HttpError(404, "no such entry");
  if (verb === "confirm") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    if (!(await confirm(rawDb(), id, ctx.user.id))) throw new HttpError(404, "no such entry");
    return sendJson(res, 200, await adminReply());
  }
  if (verb !== undefined) throw new HttpError(404, "no such route");
  if (req.method !== "DELETE") return methodNotAllowed(res, "DELETE");
  if (!(await remove(rawDb(), id))) throw new HttpError(404, "no such entry");
  sendJson(res, 200, await adminReply());
}
