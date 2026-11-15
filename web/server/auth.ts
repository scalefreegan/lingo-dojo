import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SESSION_COOKIE, SESSION_MS, SLIDE_EVERY_MS, clearSessionCookie, clientAddress, createLoginThrottle, hashPassword, isDirectLocalRequest, isSecureRequest,
  newSessionToken, normalizeUsername, parseCookies, passwordProblem, profileFromLearner, sessionCookie, throttleKey, tokenHash,
  usernameProblem, verifyPassword,
} from "../../scripts/auth.mjs";
import { MODES, isMode, LEVELS_BY_MODE } from "../../scripts/content.mjs";
import {
  archiveLanguageProfile, archiveLearner, createFirstAdmin, createLanguageProfile, createLearner, createSession, defaultLanguageProfile,
  deleteSession, findSession, findUserByUsername, getLanguageProfile, getLearner, hasUsers, languagesByLearner, listLanguageProfiles,
  listLearners, setSessionLearner, slideSession, updateLanguageProfile, updateLearner, type LanguageProfile, type LanguageProfilePatch,
  type Learner, type LearnerPatch, type NewLearnerWithLanguage,
} from "../../scripts/db/accounts.ts";
import type { Db } from "../../scripts/db/owned.ts";
import type {
  AuthUser, ErrorCode, LanguageHeader, LanguageInfo, LanguageReply, LanguageRequest, LanguagesReply, LearnerHeader, LearnerInfo, LearnerReply,
  LearnersReply, LoginRequest, MeReply, Mode, PickLanguageRequest, PickLearnerRequest, Profile,
} from "../shared/wire.ts";
import { rawDb } from "./db.ts";
import { readFirstRunSeed } from "./seed.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// Logins, sessions and learners (docs/DATA.md §Auth).
//
//   POST   /api/auth/login        public  {username, password} → MeReply + cookie; 401, 429
//   GET    /api/auth/me           public  MeReply (firstRun when there are no accounts; firstRunHere when this request may create it)
//   POST   /api/auth/first-run    public  {username, password} → the first admin, seeded; 403 unless a direct local request; 409 once anyone exists
//   POST   /api/auth/logout       user    deletes the session row, clears the cookie
//   PUT    /api/auth/learner      user    {learnerId} → the session's active learner, on its last-used language → MeReply
//   PUT    /api/auth/language     user    {languageId} → the session's active language (one of the active learner's) → MeReply
//   GET    /api/learners          user    {learners} (this user's, not archived, each with its languages)
//   POST   /api/learners          user    {name, mode, native_language, target_language, …} → {learner}, with that first language
//   PATCH  /api/learners/:id      user    {name, native_language} → {learner}
//   POST   /api/learners/:id/archive user → {learner}; sessions that had it go back to the picker
//   GET    /api/learners/:id/languages                     user → {languages} (?archived=1: archived ones too)
//   POST   /api/learners/:id/languages                     user {target_language, …} → {language}
//   PATCH  /api/learners/:id/languages/:languageId         user language keys → {language}
//   POST   /api/learners/:id/languages/:languageId/archive user → {language}; 409 for the learner's last one
//
// Routes that act for the learner (profile, packs, folders, assemble,
// export, voice turn and cast, conversations) are mounted with wrap's
// `learner: true`: the request must name the learner and the language its
// page shows (X-Learner-Id, X-Language-Profile-Id), and those must be the
// session's active ones, else 409 `stale_learner` (pageLearner).
//
// The session: a random token in the `ld_session` cookie, its SHA-256 the
// auth_sessions row id. wrap() (api.ts) resolves it on every request into the
// handler's context: the user, the active learner and its active language,
// re-read each time, so an archived learner or language or a disabled user
// takes effect on the next request. Every learner id from a request is
// looked up through the user's own scope (accounts.ts getLearner), and every
// language id through that learner's (getLanguageProfile), so another
// account's or another learner's id is a 404, the same as one that doesn't
// exist.

/** What every handler receives. `user` is null only on public routes. */
export interface PublicCtx {
  user: AuthUser | null;
  /** The session's active learner (one of `user`'s, not archived), or null. */
  learner: Learner | null;
  /** The session's active language (one of `learner`'s, not archived); null
   *  exactly when `learner` is. */
  language: LanguageProfile | null;
  /** The auth_sessions id (token hash), null without a session. */
  sessionId: string | null;
}

/** The context of a "user" or "admin" route: the user is known. */
export interface Ctx extends PublicCtx {
  user: AuthUser;
  sessionId: string;
}

/** The context of a learner-scoped route (wrap's `learner: true`): the
 *  learner and its language are the session's active ones and the ones the
 *  page shows. */
export interface LearnerCtx extends Ctx {
  learner: Learner;
  language: LanguageProfile;
}

const NO_SESSION: PublicCtx = { user: null, learner: null, language: null, sessionId: null };

const secure = (req: IncomingMessage) => isSecureRequest(req.headers);

/** Add a Set-Cookie without dropping one set earlier in the request. */
function setCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  const list = prev == null ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

/**
 * The request's session, or NO_SESSION. A live session's expiry slides 30
 * days forward (at most once a minute, SLIDE_EVERY_MS) and the cookie is
 * re-sent with it, so a learner who keeps practising never gets logged out.
 * A cookie whose session is gone (expired, logged out, user disabled) is
 * cleared, so the browser stops sending it.
 */
export async function sessionFor(req: IncomingMessage, res: ServerResponse): Promise<PublicCtx> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return NO_SESSION;
  const db = rawDb();
  const id = tokenHash(token);
  const found = await findSession(db, id);
  if (!found) {
    setCookie(res, clearSessionCookie({ secure: secure(req) }));
    return NO_SESSION;
  }
  const { session, user } = found;
  if (Date.now() - session.lastSeenAt.getTime() >= SLIDE_EVERY_MS) {
    await slideSession(db, user.id, id, new Date(Date.now() + SESSION_MS));
    setCookie(res, sessionCookie(token, { secure: secure(req) }));
  }
  const learner = session.learnerId ? ((await getLearner(db, user.id, session.learnerId)) ?? null) : null;
  const language = learner ? await sessionLanguage(db, user.id, id, learner, session.languageProfileId) : null;
  return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin }, learner, language, sessionId: id };
}

/**
 * The session's language for its learner: the one it names when that is
 * still one of the learner's live languages; otherwise (archived from
 * elsewhere, or a session from before languages) the learner's default,
 * written back to the session so every request after agrees. A page still
 * showing the old one is then a stale_learner, as after a learner switch.
 * A learner with no live language (the keep-one rule never leaves one, but
 * a hand-edited database could) gets a blank one rather than a dead end.
 */
async function sessionLanguage(db: Db, userId: string, sessionId: string, learner: Learner, wanted: string | null): Promise<LanguageProfile> {
  const named = wanted ? await getLanguageProfile(db, learner.id, wanted) : undefined;
  if (named) return named;
  const language = (await defaultLanguageProfile(db, learner.id)) ?? (await createLanguageProfile(db, learner.id, {}));
  await setSessionLearner(db, userId, sessionId, learner.id, language.id);
  return language;
}

/* ------------------------------- the learner ------------------------------ */

export const STALE_LEARNER: ErrorCode = "stale_learner";
/** LearnerHeader and LanguageHeader, as node lower-cases them. */
const LEARNER_HEADER = "x-learner-id" satisfies Lowercase<LearnerHeader>;
const LANGUAGE_HEADER = "x-language-profile-id" satisfies Lowercase<LanguageHeader>;

/** The active learner, or a 409 that sends the UI to the picker. */
export function activeLearner(ctx: PublicCtx): Learner {
  if (!ctx.learner) throw new HttpError(409, "choose who's practicing first", STALE_LEARNER);
  return ctx.learner;
}

/**
 * A learner-scoped route's check (wrap's `learner: true`): the learner the
 * page is rendering, sent as X-Learner-Id, must be the session's active one.
 * The session cookie is shared by every tab of the browser, so the mode
 * alone can't tell a stale tab from a current one: tab 1 shows Sam, tab 2
 * picks Ana (same mode, or another account logs in), and tab 1's "Save as
 * my defaults" would write Sam's values into Ana's row, or its voice turn
 * run with Ana's profile. The same holds one level down: tab 1 shows Sam's
 * German, tab 2 switches Sam to Chinese, and tab 1's save would put a German
 * pack into the Chinese library. So the page also names its language
 * (X-Language-Profile-Id), which must be the session's active one. A missing
 * header counts as a mismatch, so a client that forgets it fails loudly
 * rather than writing blind. The 409 carries `stale_learner` either way, and
 * the client re-reads /api/auth/me on it.
 */
export function pageLearner(req: IncomingMessage, ctx: PublicCtx): Learner {
  const learner = activeLearner(ctx);
  if (req.headers[LEARNER_HEADER] !== learner.id) {
    throw new HttpError(409, "this page is out of date: who's practicing changed in another tab or login", STALE_LEARNER);
  }
  if (!ctx.language || req.headers[LANGUAGE_HEADER] !== ctx.language.id) {
    throw new HttpError(409, "this page is out of date: the language changed in another tab or login", STALE_LEARNER);
  }
  return learner;
}

/**
 * The mode a route works in: the active learner's. A `?mode=` (or a body's
 * `mode`, passed as `sent`) that names a different one is a 400 rather than
 * quietly switched: the client is out of step with its session (another tab
 * switched learner), and acting on either mode could write the wrong tree.
 */
export function learnerMode(req: IncomingMessage, ctx: PublicCtx, sent?: unknown): Mode {
  const learner = activeLearner(ctx);
  const raw = sent !== undefined ? sent : new URL(req.url ?? "/", "http://localhost").searchParams.get("mode");
  if (raw == null || raw === "") return learner.mode;
  if (!isMode(raw)) throw new HttpError(400, `unknown mode ${JSON.stringify(raw)} (one of ${MODES.join(", ")})`);
  if (raw !== learner.mode) {
    throw new HttpError(400, `${learner.name} practises in ${learner.mode} mode, not ${raw}; reload the page to pick up the current learner`);
  }
  return learner.mode;
}

/** The learner and its active language as the assembler's profile
 *  (content.profile's old place). */
export function learnerProfile(learner: Learner | null, language: LanguageProfile | null): Profile {
  return profileFromLearner(learner, language);
}

export function languageInfo(p: LanguageProfile): LanguageInfo {
  return {
    id: p.id, learner_id: p.learnerId, target_language: p.targetLanguage, target_variant: p.targetVariant, level: p.level, goals: p.goals, notes: p.notes,
  };
}

export function learnerInfo(l: Learner, languages: LanguageProfile[]): LearnerInfo {
  return { id: l.id, name: l.name, mode: l.mode, native_language: l.nativeLanguage, languages: languages.map(languageInfo) };
}

/** learnerInfo with the learner's live languages read. */
async function learnerInfoOf(l: Learner): Promise<LearnerInfo> {
  return learnerInfo(l, await listLanguageProfiles(rawDb(), l.id));
}

const isLocal = (req: IncomingMessage) => isDirectLocalRequest(req.headers, req.socket.remoteAddress);

async function meReply(ctx: PublicCtx, req?: IncomingMessage): Promise<MeReply> {
  if (!ctx.user) {
    const firstRun = !(await hasUsers(rawDb()));
    // firstRunHere lets the page show "do this on the Mac" instead of a form
    // the server would refuse (handleFirstRun).
    return { firstRun, ...(firstRun ? { firstRunHere: !!req && isLocal(req) } : {}), user: null, learner: null, language: null, learners: [] };
  }
  const learners = await listLearners(rawDb(), ctx.user.id);
  const languages = await languagesByLearner(rawDb(), ctx.user.id);
  const info = (l: Learner) => learnerInfo(l, languages.get(l.id) ?? []);
  return {
    firstRun: false,
    user: ctx.user,
    learner: ctx.learner ? info(ctx.learner) : null,
    language: ctx.learner && ctx.language ? languageInfo(ctx.language) : null,
    learners: learners.map(info),
  };
}

/* ---------------------------------- login --------------------------------- */

/** One process, one Mac: in memory is enough (DATA.md). */
const throttle = createLoginThrottle();

/** For tests: forget every failure. */
export function resetLoginThrottle(): void {
  throttle.clear();
}

// A wrong username costs the same scrypt as a wrong password, so the reply
// time doesn't tell an attacker which usernames exist.
let dummyHash: Promise<string> | null = null;

function credentials(body: unknown): { username: string; password: string } {
  const b = (body && typeof body === "object" ? body : {}) as Partial<LoginRequest>;
  return { username: normalizeUsername(b.username), password: typeof b.password === "string" ? b.password : "" };
}

/** A new session for the user: the row, then the cookie. */
async function startSession(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<PublicCtx> {
  const token = newSessionToken();
  const id = tokenHash(token);
  await createSession(rawDb(), user.id, id, new Date(Date.now() + SESSION_MS));
  setCookie(res, sessionCookie(token, { secure: secure(req) }));
  return { user, learner: null, language: null, sessionId: id };
}

/** A login or first-run body is a username and a password (MAX_PASSWORD
 *  1024 characters, each up to 6 bytes as a JSON escape): 8 KB is room
 *  enough, and all a caller with no session can make the server read. */
const MAX_CREDENTIALS_BODY = 8 << 10;

const WRONG = "wrong username or password";

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const { username, password } = credentials(await readJsonBody<unknown>(req, MAX_CREDENTIALS_BODY));
  if (!username || !password) throw new HttpError(400, "username and password are required");
  // A name no account can have is the same 401 as a wrong password, and
  // never reaches the throttle: its map holds only short, well-formed keys.
  if (usernameProblem(username)) throw new HttpError(401, WRONG);
  // Counted before the first await (createLoginThrottle), so parallel
  // guesses can't all slip in ahead of the first failure. Keyed by client
  // too: someone else's guesses at your username don't lock you out.
  const key = throttleKey(username, clientAddress(req.headers, req.socket.remoteAddress));
  const wait = throttle.attempt(key);
  if (wait > 0) {
    const s = Math.ceil(wait / 1000);
    res.setHeader("Retry-After", String(s));
    throw new HttpError(429, `too many failed logins for ${username}; try again in ${s} s`);
  }
  const user = await findUserByUsername(rawDb(), username);
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await (dummyHash ??= hashPassword("not a password"))), false);
  if (!user || !ok || user.disabledAt) throw new HttpError(401, WRONG);
  throttle.succeed(key);
  const ctx = await startSession(req, res, { id: user.id, username: user.username, isAdmin: user.isAdmin });
  sendJson(res, 200, await meReply(ctx));
}

export async function handleMe(req: IncomingMessage, res: ServerResponse, ctx: PublicCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  sendJson(res, 200, await meReply(ctx, req));
}

/**
 * The first account: only while there are none (createFirstAdmin locks the
 * table for the check and the insert, so two at once make one admin). It is
 * the only sign-up there is; later accounts come from `npm run user -- add`.
 * The new admin starts with the learners, voice settings, model and agent
 * chat the files held (seed.ts) and is logged in.
 */
export async function handleFirstRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  // Whoever creates the first account becomes the admin, and this route has
  // no login in front of it. Served over a tailnet, any device on it could
  // claim a fresh install, so only the Mac itself may (isDirectLocalRequest).
  if (!isLocal(req)) throw new HttpError(403, "create the first account on the Mac that runs Lingo Dojo (open http://localhost:38400 there), not over the network");
  const { username, password } = credentials(await readJsonBody<unknown>(req, MAX_CREDENTIALS_BODY));
  const problem = usernameProblem(username) ?? passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  // A cheap refusal before the scrypt; the locked check below is the real one.
  if (await hasUsers(rawDb())) throw new HttpError(409, "an account already exists; log in instead");
  const user = await createFirstAdmin(rawDb(), { username, passwordHash: await hashPassword(password) }, readFirstRunSeed());
  if (!user) throw new HttpError(409, "an account already exists; log in instead");
  const ctx = await startSession(req, res, { id: user.id, username: user.username, isAdmin: user.isAdmin });
  sendJson(res, 200, await meReply(ctx));
}

/** /api/auth/logout and /api/auth/learner, both behind a session. */
export async function handleAuth(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const seg = subPath(req);
  if (seg === "logout") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    await deleteSession(rawDb(), ctx.user.id, ctx.sessionId);
    setCookie(res, clearSessionCookie({ secure: secure(req) }));
    return sendJson(res, 200, { ok: true });
  }
  if (seg === "learner") {
    if (req.method !== "PUT") return methodNotAllowed(res, "PUT");
    const body = await readJsonBody<Partial<PickLearnerRequest>>(req);
    const id = body && typeof body === "object" ? body.learnerId : undefined;
    let learner: Learner | null = null;
    let language: LanguageProfile | null = null;
    if (id !== null) {
      // Someone else's learner reads the same as no learner at all.
      learner = (await getLearner(rawDb(), ctx.user.id, id)) ?? null;
      if (!learner) throw new HttpError(404, "no such learner");
      // It lands on the language it was last practised in (on any device).
      language = (await defaultLanguageProfile(rawDb(), learner.id)) ?? (await createLanguageProfile(rawDb(), learner.id, {}));
    }
    await setSessionLearner(rawDb(), ctx.user.id, ctx.sessionId, learner?.id ?? null, language?.id ?? null);
    return sendJson(res, 200, await meReply({ ...ctx, learner, language }));
  }
  if (seg === "language") {
    if (req.method !== "PUT") return methodNotAllowed(res, "PUT");
    const body = await readJsonBody<Partial<PickLanguageRequest>>(req);
    const id = body && typeof body === "object" ? body.languageId : undefined;
    // One of the active learner's languages: another learner's (or another
    // account's) id is the same 404 as a missing one.
    const learner = activeLearner(ctx);
    const language = (await getLanguageProfile(rawDb(), learner.id, id)) ?? null;
    if (!language) throw new HttpError(404, "no such language");
    await setSessionLearner(rawDb(), ctx.user.id, ctx.sessionId, learner.id, language.id);
    return sendJson(res, 200, await meReply({ ...ctx, learner, language }));
  }
  sendJson(res, 404, { error: "no such route" });
}

/* --------------------------------- learners ------------------------------- */

const MAX_SHORT = 80;
const MAX_LONG = 2000;
/** The learner's own fields (the person). */
const LEARNER_KEYS: Record<"name" | "native_language", { col: keyof LearnerPatch; max: number }> = {
  name: { col: "name", max: MAX_SHORT },
  native_language: { col: "nativeLanguage", max: MAX_SHORT },
};
/** A language profile's fields. */
const LANGUAGE_KEYS: Record<keyof LanguageRequest, { col: keyof LanguageProfilePatch; max: number }> = {
  target_language: { col: "targetLanguage", max: MAX_SHORT },
  target_variant: { col: "targetVariant", max: MAX_SHORT },
  level: { col: "level", max: MAX_SHORT },
  goals: { col: "goals", max: MAX_LONG },
  notes: { col: "notes", max: MAX_LONG },
};

function bodyObject(body: unknown, what: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, `body must be an object of ${what} fields`);
  return body as Record<string, unknown>;
}

/** One text field → its trimmed value, or a 400. */
function textField(key: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  if (value.length > max) throw new HttpError(400, `${key} is too long (at most ${max} characters)`);
  return value.trim();
}

/** A language body → column values, or a 400 naming what is wrong. */
export function languagePatch(body: unknown): LanguageProfilePatch {
  const patch: LanguageProfilePatch = {};
  for (const [key, value] of Object.entries(bodyObject(body, "language"))) {
    if (key === "id" || key === "learner_id") continue; // echoed ids are harmless; the path names the language
    // Own keys only: "constructor" or "__proto__" would otherwise find
    // Object.prototype's and reach the query as a column.
    const spec = Object.hasOwn(LANGUAGE_KEYS, key) ? LANGUAGE_KEYS[key as keyof LanguageRequest] : undefined;
    if (!spec) throw new HttpError(400, `unknown language field "${key}"`);
    patch[spec.col] = textField(key, value, spec.max);
  }
  return patch;
}

/**
 * A learner body → column values, or a 400 naming what is wrong. A new
 * learner (`creating`) takes its mode and its first language's fields too;
 * an edit takes only the learner's own (name, native language): its
 * languages change through their own route, and its mode never does.
 */
export function learnerPatch(body: unknown, creating: boolean): { patch: LearnerPatch; language: LanguageProfilePatch; mode?: Mode } {
  const patch: LearnerPatch = {};
  const languageBody: Record<string, unknown> = {};
  let mode: Mode | undefined;
  for (const [key, value] of Object.entries(bodyObject(body, "learner"))) {
    if (key === "id") continue; // an echoed id is harmless; the path names the learner
    if (key === "mode") {
      if (!creating) throw new HttpError(400, "a learner's mode can't change; add a new learner instead");
      if (!isMode(value)) throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
      mode = value;
      continue;
    }
    if (Object.hasOwn(LANGUAGE_KEYS, key)) {
      if (!creating) throw new HttpError(400, `${key} belongs to a language: edit it with PATCH /api/learners/:id/languages/:languageId`);
      languageBody[key] = value;
      continue;
    }
    const spec = Object.hasOwn(LEARNER_KEYS, key) ? LEARNER_KEYS[key as keyof typeof LEARNER_KEYS] : undefined;
    if (!spec) throw new HttpError(400, `unknown learner field "${key}"`);
    patch[spec.col] = textField(key, value, spec.max);
  }
  if (patch.name !== undefined && !patch.name) throw new HttpError(400, "a learner needs a name");
  return { patch, language: languagePatch(languageBody), mode };
}

export async function handleLearners(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const db = rawDb();
  const seg = subPath(req);
  if (!seg) {
    if (req.method === "GET") {
      const learners = await listLearners(db, ctx.user.id);
      const languages = await languagesByLearner(db, ctx.user.id);
      return sendJson(res, 200, { learners: learners.map((l) => learnerInfo(l, languages.get(l.id) ?? [])) } satisfies LearnersReply);
    }
    if (req.method === "POST") {
      const { patch, language, mode } = learnerPatch(await readJsonBody<unknown>(req), true);
      if (!patch.name) throw new HttpError(400, "a learner needs a name");
      if (!mode) throw new HttpError(400, `a learner needs a mode (one of ${MODES.join(", ")})`);
      // A new learner comes with its first language, which starts at the
      // mode's first level unless one is given.
      const values: NewLearnerWithLanguage = { ...patch, ...language, name: patch.name, mode, level: language.level || LEVELS_BY_MODE[mode][0] || "" };
      const learner = await createLearner(db, ctx.user.id, values);
      return sendJson(res, 200, { learner: learnerInfo(learner, [learner.language]) } satisfies LearnerReply);
    }
    return methodNotAllowed(res, "GET, POST");
  }
  const [id, action, ...rest] = seg.split("/");
  if (action === "languages") return handleLanguages(req, res, ctx, id, rest);
  if (rest.length) return sendJson(res, 404, { error: "no such route" });
  if (action === "archive") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const learner = await archiveLearner(db, ctx.user.id, id);
    if (!learner) throw new HttpError(404, "no such learner");
    return sendJson(res, 200, { learner: await learnerInfoOf(learner) } satisfies LearnerReply);
  }
  if (action !== undefined) return sendJson(res, 404, { error: "no such route" });
  if (req.method === "GET") {
    const learner = await getLearner(db, ctx.user.id, id);
    if (!learner) throw new HttpError(404, "no such learner");
    return sendJson(res, 200, { learner: await learnerInfoOf(learner) } satisfies LearnerReply);
  }
  if (req.method === "PATCH") {
    const { patch } = learnerPatch(await readJsonBody<unknown>(req), false);
    const learner = await updateLearner(db, ctx.user.id, id, patch);
    if (!learner) throw new HttpError(404, "no such learner");
    return sendJson(res, 200, { learner: await learnerInfoOf(learner) } satisfies LearnerReply);
  }
  methodNotAllowed(res, "GET, PATCH");
}

/** /api/learners/:id/languages[/:languageId[/archive]]: a learner's
 *  languages. The learner is looked up through the user's scope and the
 *  language through the learner's, so another account's learner or another
 *  learner's language is a 404 like a missing one. Any of the user's
 *  learners, not only the active one (as for the learner routes): these
 *  don't act for the page, so they carry no stale check. */
async function handleLanguages(req: IncomingMessage, res: ServerResponse, ctx: Ctx, learnerId: string, rest: string[]): Promise<void> {
  const db = rawDb();
  const learner = await getLearner(db, ctx.user.id, learnerId);
  if (!learner) throw new HttpError(404, "no such learner");
  const [languageId, action, ...more] = rest;
  if (more.length) return sendJson(res, 404, { error: "no such route" });
  if (languageId === undefined) {
    if (req.method === "GET") {
      const archived = new URL(req.url ?? "/", "http://localhost").searchParams.get("archived") === "1";
      const languages = await listLanguageProfiles(db, learner.id, { archived });
      return sendJson(res, 200, { languages: languages.map(languageInfo) } satisfies LanguagesReply);
    }
    if (req.method === "POST") {
      const patch = languagePatch(await readJsonBody<unknown>(req));
      const language = await createLanguageProfile(db, learner.id, { ...patch, level: patch.level || LEVELS_BY_MODE[learner.mode][0] || "" });
      return sendJson(res, 200, { language: languageInfo(language) } satisfies LanguageReply);
    }
    return methodNotAllowed(res, "GET, POST");
  }
  if (action === "archive") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const result = await archiveLanguageProfile(db, ctx.user.id, learner.id, languageId);
    if ("refused" in result) {
      if (result.refused === "last") throw new HttpError(409, `${learner.name} needs at least one language; add another before archiving this one`);
      throw new HttpError(404, "no such language");
    }
    return sendJson(res, 200, { language: languageInfo(result.profile) } satisfies LanguageReply);
  }
  if (action !== undefined) return sendJson(res, 404, { error: "no such route" });
  if (req.method === "GET") {
    const language = await getLanguageProfile(db, learner.id, languageId);
    if (!language) throw new HttpError(404, "no such language");
    return sendJson(res, 200, { language: languageInfo(language) } satisfies LanguageReply);
  }
  if (req.method === "PATCH") {
    const language = await updateLanguageProfile(db, learner.id, languageId, languagePatch(await readJsonBody<unknown>(req)));
    if (!language) throw new HttpError(404, "no such language");
    return sendJson(res, 200, { language: languageInfo(language) } satisfies LanguageReply);
  }
  methodNotAllowed(res, "GET, PATCH");
}
