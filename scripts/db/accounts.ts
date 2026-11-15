// Accounts in the database (docs/DATA.md §Accounts, §Auth): users, login
// sessions, learners and their language profiles, per-user settings and the
// content agent's chat. The
// one data layer for them, shared by the dev server (web/server/auth.ts,
// store.ts) and the user CLI (scripts/user.mjs), and tested on PGlite.
//
// Everything a user owns goes through forUser() (owned.ts), so it cannot be
// read or changed without the owner id; a learner's language profiles go
// through forLearner(), with a learner id the caller looked up through the
// user's own scope first (getLearner). The raw handle appears only where
// there is no owner yet: a user by username, a session by token hash, the
// zero-users check and the CLI's user admin.
//
// Erasable TypeScript only, like schema.ts: the CLI and the tests import it
// as is.

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { forLearner, forUser, type Db } from "./owned.ts";
import { importPacks, type PackFiles } from "./packs.ts";
import { agentMessages, authSessions, languageProfiles, learners, userSettings, users } from "./schema.ts";

export type User = typeof users.$inferSelect;
export type Learner = typeof learners.$inferSelect;
export type LanguageProfile = typeof languageProfiles.$inferSelect;
export type Session = typeof authSessions.$inferSelect;
/** A learner's values on insert: the owner comes from the scope. */
export type NewLearner = Omit<typeof learners.$inferInsert, "userId" | "id" | "createdAt" | "archivedAt">;
/** A language profile's values on insert (the learner comes from the scope). */
export type NewLanguageProfile = Partial<Pick<LanguageProfile, "targetLanguage" | "targetVariant" | "level" | "goals" | "notes">>;
/** A new learner with its first language: both rows' values in one object. */
export type NewLearnerWithLanguage = NewLearner & NewLanguageProfile;
/** A learner with the language profile it was made with. */
export type LearnerWithLanguage = Learner & { language: LanguageProfile };
/** What an edit of the learner may change: the person, not the mode or the
 *  owner (its languages change through LanguageProfilePatch). */
export type LearnerPatch = Partial<Pick<Learner, "name" | "nativeLanguage">>;
/** What an edit of a language profile may change. */
export type LanguageProfilePatch = NewLanguageProfile;

const LANGUAGE_KEYS = ["targetLanguage", "targetVariant", "level", "goals", "notes"] as const;

/** A combined learner + first language → the two rows' values. */
export function splitLearnerValues(values: NewLearnerWithLanguage): { learner: NewLearner; language: NewLanguageProfile } {
  const learner: Record<string, unknown> = { ...values };
  const language: NewLanguageProfile = {};
  for (const k of LANGUAGE_KEYS) {
    if (values[k] !== undefined) language[k] = values[k];
    delete learner[k];
  }
  return { learner: learner as NewLearner, language };
}
export type AgentRole = "user" | "assistant" | "commit";
export interface AgentMessage { role: AgentRole; text: string; ts: string }

/* ---------------------------------- users --------------------------------- */

/** Owner-less: the login lookup. `username` is the normalized form. */
export async function findUserByUsername(db: Db, username: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return row;
}

/** Owner-less: is this the first run? */
export async function hasUsers(db: Db): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

/** The CLI's `add`. A taken username is the unique violation (23505). */
export async function createUser(db: Db, values: { username: string; passwordHash: string; isAdmin?: boolean }): Promise<User> {
  const [row] = await db.insert(users).values({ username: values.username, passwordHash: values.passwordHash, isAdmin: !!values.isAdmin }).returning();
  return row;
}

export async function listUsers(db: Db): Promise<(User & { learners: number })[]> {
  const rows = await db.select().from(users).orderBy(asc(users.createdAt), asc(users.username));
  const counts = await db
    .select({ userId: learners.userId, n: sql<number>`count(*)::int` })
    .from(learners)
    .where(isNull(learners.archivedAt))
    .groupBy(learners.userId);
  const by = new Map(counts.map((c) => [c.userId, c.n]));
  return rows.map((u) => ({ ...u, learners: by.get(u.id) ?? 0 }));
}

/** New password; every session of that user ends (a changed password should
 *  sign out a stolen cookie). False when there is no such user. */
export async function setPassword(db: Db, username: string, passwordHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(users).set({ passwordHash }).where(eq(users.username, username)).returning();
    if (!row) return false;
    await forUser(tx, row.id).removeAllOwned(authSessions);
    return true;
  });
}

/** Disable (not delete: their learners and history stay) and sign out. */
export async function disableUser(db: Db, username: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(users).set({ disabledAt: sql`now()` }).where(eq(users.username, username)).returning();
    if (!row) return false;
    await forUser(tx, row.id).removeAllOwned(authSessions);
    return true;
  });
}

/** Undo disableUser: logins work again (with the password they had). */
export async function enableUser(db: Db, username: string): Promise<boolean> {
  const [row] = await db.update(users).set({ disabledAt: null }).where(eq(users.username, username)).returning();
  return !!row;
}

/* --------------------------------- first run ------------------------------ */

/** What the first admin starts with, read from the files that predate logins
 *  (web/server/seed.ts). Every part is optional: a missing file seeds nothing. */
export interface FirstRunSeed {
  /** Each learner with its one language (profile.yaml holds both). */
  learners: NewLearnerWithLanguage[];
  voice: Record<string, unknown> | null;
  model: string | null;
  messages: AgentMessage[];
  /** Each mode's pack files (content/packs, content/kids/packs), imported
   *  into the language of that mode's learner (packs.ts importPacks). */
  packs?: Partial<Record<"adult" | "kids", PackFiles>>;
}

/**
 * Create the first account, an admin, with its seed, only while there are no
 * users at all. Race-safe: the users table is locked (SHARE ROW EXCLUSIVE,
 * which conflicts with itself and with any insert) for the check and the
 * insert, so of two concurrent first runs one creates the admin and the
 * other sees a user and gets null. All or nothing: a seed that fails to
 * write leaves no half-made admin behind. Each learner gets one language
 * profile from its profile file, and the seed packs of its mode are
 * imported into it (first run on a fresh install: the repo's packs).
 */
export async function createFirstAdmin(db: Db, account: { username: string; passwordHash: string }, seed: FirstRunSeed): Promise<User | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${users} in share row exclusive mode`);
    if (await hasUsers(tx)) return null;
    const [user] = await tx.insert(users).values({ username: account.username, passwordHash: account.passwordHash, isAdmin: true }).returning();
    const mine = forUser(tx, user.id);
    // The seed packs go to the learner of their mode, into its one
    // language, in this transaction: a fresh install starts with them, and a
    // failure leaves no admin.
    for (const values of seed.learners) {
      const learner = await insertLearner(tx, user.id, values);
      const files = seed.packs?.[learner.mode];
      if (files) await importPacks(tx, learner.language, files);
    }
    if (seed.voice || seed.model) await mine.insert(userSettings, { voice: seed.voice ?? {}, model: seed.model });
    if (seed.messages.length) {
      await mine.insert(agentMessages, seed.messages.map((m) => ({ role: m.role, text: m.text, ...(validDate(m.ts) ? { ts: new Date(m.ts) } : {}) })));
    }
    return user;
  });
}

const validDate = (s: string) => !!s && !Number.isNaN(Date.parse(s));

/* --------------------------------- sessions ------------------------------- */

/** A new login session; `id` is the token's hash (auth.mjs tokenHash). */
export async function createSession(db: Db, userId: string, id: string, expiresAt: Date, learnerId: string | null = null): Promise<Session> {
  const mine = forUser(db, userId);
  // Expired sessions of this user go on each login, so the table does not
  // collect every cookie ever issued.
  await mine.remove(authSessions, sql`${authSessions.expiresAt} <= now()`);
  const [row] = await mine.insert(authSessions, { id, expiresAt, learnerId });
  return row;
}

/** Owner-less: the session for a cookie, with its user, when it is live (not
 *  expired, user not disabled). */
export async function findSession(db: Db, id: string): Promise<{ session: Session; user: User } | null> {
  const [row] = await db
    .select({ session: authSessions, user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, id), gt(authSessions.expiresAt, sql`now()`), isNull(users.disabledAt)))
    .limit(1);
  return row ?? null;
}

/** Push the expiry out (the 30-day window slides with use). */
export async function slideSession(db: Db, userId: string, id: string, expiresAt: Date): Promise<void> {
  await forUser(db, userId).update(authSessions, { expiresAt, lastSeenAt: sql`now()` }, eq(authSessions.id, id));
}

export async function deleteSession(db: Db, userId: string, id: string): Promise<void> {
  await forUser(db, userId).remove(authSessions, eq(authSessions.id, id));
}

/** The session's active learner and language, always set together. The
 *  caller has checked the learner is this user's and the language that
 *  learner's; the composite foreign keys (learner_id, user_id) and
 *  (language_profile_id, learner_id) refuse them anyway if not. The language
 *  becomes the learner's last used, which the next pick of the learner (on
 *  any device) lands on. */
export async function setSessionLearner(
  db: Db,
  userId: string,
  id: string,
  learnerId: string | null,
  languageProfileId: string | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await forUser(tx, userId).update(authSessions, { learnerId, languageProfileId: learnerId ? languageProfileId : null }, eq(authSessions.id, id));
    if (learnerId && languageProfileId) {
      await forLearner(tx, learnerId).update(languageProfiles, { lastUsedAt: sql`now()` }, eq(languageProfiles.id, languageProfileId));
    }
  });
}

/* --------------------------------- learners ------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id from a request that could be a learner's. Anything else is a 404
 *  before it reaches Postgres (which would answer a bad uuid with an error). */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** This user's learners, oldest first; archived ones only when asked. The
 *  first run makes two in one transaction (same created_at), so ties go
 *  adult before kids, then by name. */
export async function listLearners(db: Db, userId: string, opts: { archived?: boolean } = {}): Promise<Learner[]> {
  return forUser(db, userId).list(learners, opts.archived ? undefined : isNull(learners.archivedAt), {
    orderBy: [asc(learners.createdAt), asc(learners.mode), asc(learners.name)],
  });
}

/** One of this user's live learners, or undefined (someone else's id, an
 *  archived one, or not an id at all). */
export async function getLearner(db: Db, userId: string, id: unknown): Promise<Learner | undefined> {
  if (!isUuid(id)) return undefined;
  return forUser(db, userId).get(learners, and(eq(learners.id, id), isNull(learners.archivedAt))!);
}

/** A learner and its first language, in the caller's transaction. */
async function insertLearner(tx: Db, userId: string, values: NewLearnerWithLanguage): Promise<LearnerWithLanguage> {
  const split = splitLearnerValues(values);
  const [learner] = await forUser(tx, userId).insert(learners, split.learner);
  const [language] = await forLearner(tx, learner.id).insert(languageProfiles, split.language);
  return { ...learner, language };
}

/** A new learner, which always starts with one language (the keep-one rule). */
export async function createLearner(db: Db, userId: string, values: NewLearnerWithLanguage): Promise<LearnerWithLanguage> {
  return db.transaction((tx) => insertLearner(tx, userId, values));
}

export async function updateLearner(db: Db, userId: string, id: string, patch: LearnerPatch): Promise<Learner | undefined> {
  if (!isUuid(id)) return undefined;
  if (!Object.keys(patch).length) return getLearner(db, userId, id);
  const [row] = await forUser(db, userId).update(learners, patch, and(eq(learners.id, id), isNull(learners.archivedAt))!);
  return row;
}

/** Archive (kept, out of the picker). Sessions that had it active go back to
 *  the picker. */
export async function archiveLearner(db: Db, userId: string, id: string): Promise<Learner | undefined> {
  if (!isUuid(id)) return undefined;
  return db.transaction(async (tx) => {
    const mine = forUser(tx, userId);
    const [row] = await mine.update(learners, { archivedAt: sql`now()` }, and(eq(learners.id, id), isNull(learners.archivedAt))!);
    if (row) await mine.update(authSessions, { learnerId: null, languageProfileId: null }, eq(authSessions.learnerId, id));
    return row;
  });
}

/* ---------------------------- language profiles ---------------------------- */
// A learner's languages. Every function takes a learner id the caller has
// already found through the user's own scope (getLearner), and reaches the
// profiles through forLearner, so another learner's profile id is undefined
// here, the same as a missing one.

/** The learner's languages, oldest first; archived ones only when asked. */
export async function listLanguageProfiles(db: Db, learnerId: string, opts: { archived?: boolean } = {}): Promise<LanguageProfile[]> {
  return forLearner(db, learnerId).list(languageProfiles, opts.archived ? undefined : isNull(languageProfiles.archivedAt), {
    orderBy: [asc(languageProfiles.createdAt), asc(languageProfiles.id)],
  });
}

/** The live languages of every live learner of a user, by learner id (one
 *  query, for /api/auth/me's learner list). */
export async function languagesByLearner(db: Db, userId: string): Promise<Map<string, LanguageProfile[]>> {
  const rows = await db
    .select({ p: languageProfiles })
    .from(languageProfiles)
    .innerJoin(learners, eq(learners.id, languageProfiles.learnerId))
    .where(and(forUser(db, userId).where(learners, isNull(learners.archivedAt)), isNull(languageProfiles.archivedAt)))
    .orderBy(asc(languageProfiles.createdAt), asc(languageProfiles.id));
  const out = new Map<string, LanguageProfile[]>();
  for (const { p } of rows) out.set(p.learnerId, [...(out.get(p.learnerId) ?? []), p]);
  return out;
}

/** One of the learner's live languages, or undefined (another learner's id,
 *  an archived one, or not an id at all). */
export async function getLanguageProfile(db: Db, learnerId: string, id: unknown): Promise<LanguageProfile | undefined> {
  if (!isUuid(id)) return undefined;
  return forLearner(db, learnerId).get(languageProfiles, and(eq(languageProfiles.id, id), isNull(languageProfiles.archivedAt))!);
}

/** Where picking the learner lands (and where `db:import` puts packs): its
 *  most recently used live language, else its oldest. Undefined only for a
 *  learner with no live language, which the keep-one rule never leaves. */
export async function defaultLanguageProfile(db: Db, learnerId: string): Promise<LanguageProfile | undefined> {
  const [row] = await forLearner(db, learnerId).list(languageProfiles, isNull(languageProfiles.archivedAt), {
    orderBy: [sql`${languageProfiles.lastUsedAt} desc nulls last`, asc(languageProfiles.createdAt), asc(languageProfiles.id)],
    limit: 1,
  });
  return row;
}

export async function createLanguageProfile(db: Db, learnerId: string, values: NewLanguageProfile): Promise<LanguageProfile> {
  const [row] = await forLearner(db, learnerId).insert(languageProfiles, values);
  return row;
}

export async function updateLanguageProfile(db: Db, learnerId: string, id: string, patch: LanguageProfilePatch): Promise<LanguageProfile | undefined> {
  if (!isUuid(id)) return undefined;
  if (!Object.keys(patch).length) return getLanguageProfile(db, learnerId, id);
  const [row] = await forLearner(db, learnerId).update(languageProfiles, patch, and(eq(languageProfiles.id, id), isNull(languageProfiles.archivedAt))!);
  return row;
}

/**
 * Archive one of the learner's languages: kept, with its packs and history,
 * but out of the switcher. Refused ("last") when it is the learner's only
 * live one: a learner always keeps one. Sessions that had it active move to
 * the learner's default language in the same transaction, so no session is
 * left on an archived one (a page still showing it gets stale_learner). The
 * learner's live profiles are locked first, so two archives at once of a
 * learner's last two languages can't both pass the count.
 */
export async function archiveLanguageProfile(
  db: Db,
  userId: string,
  learnerId: string,
  id: string,
): Promise<{ profile: LanguageProfile } | { refused: "missing" | "last" }> {
  if (!isUuid(id)) return { refused: "missing" };
  return db.transaction(async (tx) => {
    const mine = forLearner(tx, learnerId);
    const live = await tx.select().from(languageProfiles).where(mine.where(languageProfiles, isNull(languageProfiles.archivedAt))).for("update");
    if (!live.some((p) => p.id === id)) return { refused: "missing" as const };
    if (live.length <= 1) return { refused: "last" as const };
    const [profile] = await mine.update(languageProfiles, { archivedAt: sql`now()` }, eq(languageProfiles.id, id));
    const next = await defaultLanguageProfile(tx, learnerId);
    await forUser(tx, userId).update(
      authSessions,
      { languageProfileId: next!.id },
      and(eq(authSessions.learnerId, learnerId), eq(authSessions.languageProfileId, id))!,
    );
    return { profile };
  });
}

/* --------------------------------- settings ------------------------------- */

/** The user's settings row, or undefined before anything was saved. */
export async function getSettings(db: Db, userId: string): Promise<{ model: string | null; voice: Record<string, unknown> } | undefined> {
  const [row] = await forUser(db, userId).list(userSettings, undefined, { limit: 1 });
  return row ? { model: row.model, voice: row.voice } : undefined;
}

/**
 * Change a user's voice settings as one read-merge-write: `change` gets the
 * stored value (null when never saved) and returns the new one. Two saves at
 * once (the provider and then the listening provider, or the adult and kids
 * session lengths) would otherwise both read the same row and the second
 * write would undo the first. So it runs in one transaction that first makes
 * sure the row exists (insert, nothing on conflict: the lock below needs a
 * row to hold, even for a user who never saved), then locks it with SELECT
 * … FOR UPDATE, so a concurrent save waits and then reads this one's result.
 * Returns what was stored.
 */
export async function updateVoiceSettings(
  db: Db,
  userId: string,
  change: (stored: Record<string, unknown> | null) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    const mine = forUser(tx, userId);
    // The owner is set by hand here because the scope's upsert can't express
    // "do nothing on conflict"; it is the same user id the scope uses.
    const [made] = await tx.insert(userSettings).values({ userId }).onConflictDoNothing().returning();
    const [row] = await tx.select().from(userSettings).where(mine.where(userSettings)).for("update");
    const voice = change(made ? null : row.voice);
    await tx.update(userSettings).set({ voice }).where(mine.where(userSettings));
    return voice;
  });
}

/** One column, no read: an upsert of just the model can't undo a concurrent
 *  voice save (each sets only its own column). */
export async function saveModel(db: Db, userId: string, model: string): Promise<void> {
  await forUser(db, userId).upsert(userSettings, { model }, { target: [], set: { model } });
}

/* ------------------------------ agent messages ---------------------------- */

/** The agent chat, oldest first (by seq: ts ties within a transaction).
 *  With `last`, only the newest `last` messages. */
export async function listAgentMessages(db: Db, userId: string, last?: number): Promise<AgentMessage[]> {
  const mine = forUser(db, userId);
  const rows = last === undefined
    ? await mine.list(agentMessages, undefined, { orderBy: asc(agentMessages.seq) })
    : (await mine.list(agentMessages, undefined, { orderBy: desc(agentMessages.seq), limit: last })).reverse();
  return rows.map((r) => ({ role: r.role, text: r.text, ts: r.ts.toISOString() }));
}

export async function appendAgentMessage(db: Db, userId: string, m: AgentMessage): Promise<void> {
  await forUser(db, userId).insert(agentMessages, { role: m.role, text: m.text, ...(validDate(m.ts) ? { ts: new Date(m.ts) } : {}) });
}

export async function clearAgentMessages(db: Db, userId: string): Promise<void> {
  await forUser(db, userId).removeAllOwned(agentMessages);
}
