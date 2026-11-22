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

import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
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
/** Which agent messages a read returns: all (the panel's transcript), or
 *  those a run with this bank scope may be shown (`bank`: the language
 *  profile it reads, or null for a run without the bank): the runs
 *  without the bank, and the runs that read that same language profile. */
export type AgentMessageScope = { bank: string | null };

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

/**
 * Point the session at a learner and one of its live languages (always set
 * together), or at no learner (`learnerId` null). `languageProfileId` null
 * lands on the learner's default language (the last used; a blank one is
 * made for a learner with none). The language becomes the learner's last
 * used, which the next pick of the learner (on any device) lands on.
 *
 * Lock order, the one every learner/profile/session write keeps (see
 * lockLearner): the learners first (the session's current one and the new
 * one, in id order), then the profile (the lastUsedAt update), then the
 * session row. So an archive of the destination language, which holds the
 * learner and its profiles and then moves sessions, runs wholly before or
 * after this instead of deadlocking with it; and since the learner and
 * language are read under the learner's lock, one archived meanwhile is a
 * refusal ("learner" or "language"), never a session left on it.
 */
export async function setSessionLearner(
  db: Db,
  userId: string,
  id: string,
  learnerId: string | null,
  languageProfileId: string | null = null,
): Promise<{ learner: Learner | null; language: LanguageProfile | null } | { refused: "learner" | "language" }> {
  if (learnerId !== null && !isUuid(learnerId)) return { refused: "learner" };
  if (languageProfileId !== null && !isUuid(languageProfileId)) return { refused: "language" };
  return db.transaction(async (tx) => {
    const mine = forUser(tx, userId);
    const [current] = await tx.select({ learnerId: authSessions.learnerId }).from(authSessions).where(mine.where(authSessions, eq(authSessions.id, id)));
    // Both learners, in id order, so two switches between the same two
    // learners in opposite directions can't each hold the one the other wants.
    const ids = [...new Set([current?.learnerId, learnerId].filter((v): v is string => !!v))].sort();
    for (const l of ids) await lockLearner(tx, l);
    if (learnerId === null) {
      await mine.update(authSessions, { learnerId: null, languageProfileId: null }, eq(authSessions.id, id));
      return { learner: null, language: null };
    }
    const learner = await getLearner(tx, userId, learnerId);
    if (!learner) return { refused: "learner" as const };
    const language = languageProfileId
      ? await getLanguageProfile(tx, learnerId, languageProfileId)
      : ((await defaultLanguageProfile(tx, learnerId)) ?? (await createLanguageProfile(tx, learnerId, {})));
    if (!language) return { refused: "language" as const };
    const [used] = await forLearner(tx, learnerId).update(languageProfiles, { lastUsedAt: sql`now()` }, eq(languageProfiles.id, language.id));
    await mine.update(authSessions, { learnerId, languageProfileId: language.id }, eq(authSessions.id, id));
    return { learner, language: used ?? language };
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

/**
 * Every learner name on the install, archived ones too (the shared picture
 * pool, ld-ec9): a learner's drawing or word joins the pool every account
 * sees only when no word of it names any learner anywhere, so this reads
 * across users on purpose. Names only, never who they belong to; they go
 * nowhere but the name check (pictures.mjs nameWords).
 */
export async function allLearnerNames(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ name: learners.name }).from(learners);
  return rows.map((r) => r.name);
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

/** Where picking the learner lands: its most recently used live language,
 *  else its oldest. Undefined only for a
 *  learner with no live language, which the keep-one rule never leaves. */
export async function defaultLanguageProfile(db: Db, learnerId: string): Promise<LanguageProfile | undefined> {
  const [row] = await forLearner(db, learnerId).list(languageProfiles, isNull(languageProfiles.archivedAt), {
    orderBy: [sql`${languageProfiles.lastUsedAt} desc nulls last`, asc(languageProfiles.createdAt), asc(languageProfiles.id)],
    limit: 1,
  });
  return row;
}

/** The learner's oldest live language: where seed packs go (`db:import`,
 *  the first run). For a learner from before 0002 it is the profile the
 *  migration made from its columns, and it doesn't move when the learner
 *  practises another language, so a re-run of the import finds the packs
 *  where it put them. */
export async function oldestLanguageProfile(db: Db, learnerId: string): Promise<LanguageProfile | undefined> {
  const [row] = await listLanguageProfiles(db, learnerId);
  return row;
}

/** Every language profile of every learner of a user, archived ones too, as
 *  scope refs (the idle end of conversations walks them all). */
export async function languageProfileRefsOfUser(db: Db, userId: string): Promise<{ id: string; learnerId: string }[]> {
  return db
    .select({ id: languageProfiles.id, learnerId: languageProfiles.learnerId })
    .from(languageProfiles)
    .innerJoin(learners, eq(learners.id, languageProfiles.learnerId))
    .where(forUser(db, userId).where(learners));
}

/** Whose a language profile is, archived or not: its learner's account,
 *  native language and mode, and its own target language. For work that
 *  starts from a stored row rather than a request (the post-session
 *  extraction of a conversation that ended idle, perhaps in an archived
 *  language); undefined when the profile isn't that learner's. */
export async function languageProfileOwner(
  db: Db,
  ref: { id: string; learnerId: string },
): Promise<{ userId: string; nativeLanguage: string; mode: Learner["mode"]; targetLanguage: string; targetVariant: string } | undefined> {
  const [row] = await db
    .select({ userId: learners.userId, nativeLanguage: learners.nativeLanguage, mode: learners.mode, targetLanguage: languageProfiles.targetLanguage, targetVariant: languageProfiles.targetVariant })
    .from(languageProfiles)
    .innerJoin(learners, eq(learners.id, languageProfiles.learnerId))
    .where(forLearner(db, ref.learnerId).where(languageProfiles, eq(languageProfiles.id, ref.id)));
  return row;
}

/** Two target languages are the same language when they match ignoring
 *  case and surrounding space ("german" is "German"). */
export const sameLanguage = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Refused by createLanguageProfile: the learner already practises that
 *  language (one live profile per target language; its variant is a detail
 *  inside it). `existing` is that profile. */
export class LanguageTakenError extends Error {
  readonly existing: LanguageProfile;
  constructor(existing: LanguageProfile) {
    super(`already practising ${existing.targetLanguage}`);
    this.name = "LanguageTakenError";
    this.existing = existing;
  }
}

/**
 * Lock the learner's row (FOR UPDATE), in the caller's transaction. The one
 * lock order for learners, language profiles and sessions is: learners (in
 * id order when there are two), then language profiles, then session rows.
 * Every write that can give a live profile a target language (an add, the
 * naming of a blank profile), every language archive and every session
 * switch (setSessionLearner) takes this first: the one-per-language rule
 * has no unique index behind it (that would need a migration), so this lock
 * is what serialises the check-then-write, and the one order keeps any two
 * of them from deadlocking. archiveLearner and updateLearner write the
 * learner row itself first, which is the same order.
 */
async function lockLearner(tx: Db, learnerId: string): Promise<void> {
  await tx.select({ id: learners.id }).from(learners).where(eq(learners.id, learnerId)).for("update");
}

/** Refuse `target` when another live profile of the learner already has it
 *  (LanguageTakenError). Call it holding lockLearner. A blank target never
 *  clashes. */
async function assertLanguageFree(tx: Db, learnerId: string, target: string, exceptId?: string): Promise<void> {
  if (!target.trim()) return;
  const clash = (await listLanguageProfiles(tx, learnerId)).find((p) => p.id !== exceptId && sameLanguage(p.targetLanguage, target));
  if (clash) throw new LanguageTakenError(clash);
}

/**
 * Add a language to a learner. One live profile per target language: a
 * second one for a language the learner already practises is refused with
 * LanguageTakenError (a variant, say Mexican or Castilian Spanish, is a
 * setting of the one profile, not another profile). The learner's row is
 * locked first (lockLearner), so two adds of one language at once, or an
 * add and the naming of a blank profile, can't both pass the check. A blank
 * target language is allowed (a library with no languages.yaml) and never
 * clashes.
 */
export async function createLanguageProfile(db: Db, learnerId: string, values: NewLanguageProfile): Promise<LanguageProfile> {
  return db.transaction(async (tx) => {
    await lockLearner(tx, learnerId);
    await assertLanguageFree(tx, learnerId, values.targetLanguage ?? "");
    const [row] = await forLearner(tx, learnerId).insert(languageProfiles, values);
    return row;
  });
}

/** Refused by updateLanguageProfile: a patch that would change a profile's
 *  target language. That is the profile's identity (its packs and History
 *  are in that language), so another language is another profile. */
export class LanguageIdentityError extends Error {
  readonly current: string;
  constructor(current: string) {
    super(`this profile is ${current}; another language is another profile`);
    this.name = "LanguageIdentityError";
    this.current = current;
  }
}

/**
 * Change one of the learner's live languages: variant, level, goals, notes.
 * The target language can't change (LanguageIdentityError): a patch naming
 * the same language is a no-op for that key (the stored spelling stays).
 * The one exception is a profile with no target language yet (made with
 * none, as a library with no languages.yaml allows): it may be given one,
 * unless the learner already practises it (LanguageTakenError). The
 * learner's row is locked first, then the profile's (the order
 * createLanguageProfile and archiveLanguageProfile use), so a concurrent
 * add, naming or change waits instead of passing the same check.
 */
export async function updateLanguageProfile(db: Db, learnerId: string, id: string, patch: LanguageProfilePatch): Promise<LanguageProfile | undefined> {
  if (!isUuid(id)) return undefined;
  return db.transaction(async (tx) => {
    await lockLearner(tx, learnerId);
    const mine = forLearner(tx, learnerId);
    const live = and(eq(languageProfiles.id, id), isNull(languageProfiles.archivedAt))!;
    const [current] = await tx.select().from(languageProfiles).where(mine.where(languageProfiles, live)).for("update");
    if (!current) return undefined;
    const next = { ...patch };
    if (next.targetLanguage !== undefined) {
      if (sameLanguage(next.targetLanguage, current.targetLanguage)) delete next.targetLanguage;
      else if (current.targetLanguage.trim()) throw new LanguageIdentityError(current.targetLanguage);
      else await assertLanguageFree(tx, learnerId, next.targetLanguage, id);
    }
    if (!Object.keys(next).length) return current;
    const [row] = await mine.update(languageProfiles, next, live);
    return row;
  });
}

/**
 * Archive one of the learner's languages: kept, with its packs and history,
 * but out of the switcher. Refused ("last") when it is the learner's only
 * live one: a learner always keeps one. Sessions that had it active move to
 * the learner's default language in the same transaction, so no session is
 * left on an archived one (a page still showing it gets stale_learner). The
 * learner's row and then its live profiles are locked first (the
 * lockLearner order), so two archives at once of a learner's last two
 * languages can't both pass the count.
 */
export async function archiveLanguageProfile(
  db: Db,
  userId: string,
  learnerId: string,
  id: string,
): Promise<{ profile: LanguageProfile } | { refused: "missing" | "last" }> {
  if (!isUuid(id)) return { refused: "missing" };
  return db.transaction(async (tx) => {
    await lockLearner(tx, learnerId);
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
export async function listAgentMessages(db: Db, userId: string, last?: number, scope?: AgentMessageScope): Promise<AgentMessage[]> {
  const mine = forUser(db, userId);
  const cond = scope === undefined
    ? undefined
    : scope.bank === null
      ? isNull(agentMessages.bankLanguageProfileId)
      : or(isNull(agentMessages.bankLanguageProfileId), eq(agentMessages.bankLanguageProfileId, scope.bank));
  const rows = last === undefined
    ? await mine.list(agentMessages, cond, { orderBy: asc(agentMessages.seq) })
    : (await mine.list(agentMessages, cond, { orderBy: desc(agentMessages.seq), limit: last })).reverse();
  return rows.map((r) => ({ role: r.role, text: r.text, ts: r.ts.toISOString() }));
}

/** `bank`: the language profile whose phrase bank the run could read
 *  (AgentMessageScope), stored with the message. */
export async function appendAgentMessage(db: Db, userId: string, m: AgentMessage, bank: string | null = null): Promise<void> {
  await forUser(db, userId).insert(agentMessages, {
    role: m.role,
    text: m.text,
    ...(validDate(m.ts) ? { ts: new Date(m.ts) } : {}),
    ...(bank ? { bankLanguageProfileId: bank } : {}),
  });
}

export async function clearAgentMessages(db: Db, userId: string): Promise<void> {
  await forUser(db, userId).removeAllOwned(agentMessages);
}
