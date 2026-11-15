// Accounts in the database (docs/DATA.md §Accounts, §Auth): users, login
// sessions, learners, per-user settings and the content agent's chat. The
// one data layer for them, shared by the dev server (web/server/auth.ts,
// store.ts) and the user CLI (scripts/user.mjs), and tested on PGlite.
//
// Everything a user owns goes through forUser() (owned.ts), so it cannot be
// read or changed without the owner id. The raw handle appears only where
// there is no owner yet: a user by username, a session by token hash, the
// zero-users check and the CLI's user admin.
//
// Erasable TypeScript only, like schema.ts: the CLI and the tests import it
// as is.

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { forUser, type Db } from "./owned.ts";
import { agentMessages, authSessions, learners, userSettings, users } from "./schema.ts";

export type User = typeof users.$inferSelect;
export type Learner = typeof learners.$inferSelect;
export type Session = typeof authSessions.$inferSelect;
/** A learner's values on insert: the owner comes from the scope. */
export type NewLearner = Omit<typeof learners.$inferInsert, "userId" | "id" | "createdAt" | "archivedAt">;
/** What an edit may change: the profile keys, not the mode or the owner. */
export type LearnerPatch = Partial<Pick<Learner, "name" | "nativeLanguage" | "targetLanguage" | "targetVariant" | "level" | "goals" | "notes">>;
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
  learners: NewLearner[];
  voice: Record<string, unknown> | null;
  model: string | null;
  messages: AgentMessage[];
}

/**
 * Create the first account, an admin, with its seed, only while there are no
 * users at all. Race-safe: the users table is locked (SHARE ROW EXCLUSIVE,
 * which conflicts with itself and with any insert) for the check and the
 * insert, so of two concurrent first runs one creates the admin and the
 * other sees a user and gets null. All or nothing: a seed that fails to
 * write leaves no half-made admin behind.
 */
export async function createFirstAdmin(db: Db, account: { username: string; passwordHash: string }, seed: FirstRunSeed): Promise<User | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${users} in share row exclusive mode`);
    if (await hasUsers(tx)) return null;
    const [user] = await tx.insert(users).values({ username: account.username, passwordHash: account.passwordHash, isAdmin: true }).returning();
    const mine = forUser(tx, user.id);
    if (seed.learners.length) await mine.insert(learners, seed.learners);
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

/** The session's active learner. The caller has checked the learner is this
 *  user's; the composite foreign key (learner_id, user_id) refuses it anyway
 *  if not. */
export async function setSessionLearner(db: Db, userId: string, id: string, learnerId: string | null): Promise<void> {
  await forUser(db, userId).update(authSessions, { learnerId }, eq(authSessions.id, id));
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

export async function createLearner(db: Db, userId: string, values: NewLearner): Promise<Learner> {
  const [row] = await forUser(db, userId).insert(learners, values);
  return row;
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
    if (row) await mine.update(authSessions, { learnerId: null }, eq(authSessions.learnerId, id));
    return row;
  });
}

/* --------------------------------- settings ------------------------------- */

/** The user's settings row, or undefined before anything was saved. */
export async function getSettings(db: Db, userId: string): Promise<{ model: string | null; voice: Record<string, unknown> } | undefined> {
  const [row] = await forUser(db, userId).list(userSettings, undefined, { limit: 1 });
  return row ? { model: row.model, voice: row.voice } : undefined;
}

export async function saveVoiceSettings(db: Db, userId: string, voice: Record<string, unknown>): Promise<void> {
  await forUser(db, userId).upsert(userSettings, { voice }, { target: [], set: { voice } });
}

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
