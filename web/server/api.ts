import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type { ErrorCode, ErrorReply } from "../shared/wire.ts";
import {
  handleAuth, handleFirstRun, handleLearners, handleLogin, handleMe, pageLearner, sessionFor, type Ctx, type LearnerCtx, type PublicCtx,
} from "./auth.ts";
import { handleChat, handleSettings } from "./chat.ts";
import { handleConversations } from "./conversations.ts";
import { handleHiddenScenes } from "./hidden.ts";
import { handlePhrases } from "./phrases.ts";
import { handlePractice } from "./practice.ts";
import { handlePronunciation } from "./pronunciation.ts";
import { handleAssemble, handleContent, handleExport, handleFolders, handlePackRevisions, handlePacks, handleProfile } from "./content.ts";
import { checkDatabase, DatabaseNotReady, setDb, type Db } from "./db.ts";
import { openDatabaseGate, type DatabaseGate, type GateLog } from "./dbGate.ts";
import { HttpError, sendJson } from "./sse.ts";
import { handleVoice, handleVoiceCast, handleVoiceTranscribe, handleVoiceLibraryAdd, handleVoiceSound, handleVoiceTurn } from "./voice.ts";

// The whole "backend": dev-server-only middleware on the Vite server,
// bound to localhost. Copied from Atlas, plus logins (docs/DATA.md §Auth):
// every route says who may call it, and wrap() enforces it.

/**
 * Reject cross-origin requests. Without this, any website the user visits
 * while `npm run dev` is up can POST to these routes — a text/plain body is a
 * CORS "simple request" (no preflight), so the browser sends it and the
 * server would write packs and exports (and, once the chat lands, spawn
 * agents that edit content/). A request with no Origin (same-origin
 * navigation, curl) is allowed; one whose Origin host doesn't match the
 * request Host is refused. The session cookie is SameSite=Lax, which already
 * keeps it off a cross-site POST; this check stays as the second wall. Pure,
 * so a test pins the rule rather than the wiring.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // no Origin → not a cross-site fetch
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type PublicHandler = (req: IncomingMessage, res: ServerResponse, ctx: PublicCtx) => void | Promise<void>;
type UserHandler = (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => void | Promise<void>;
type LearnerHandler = (req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx) => void | Promise<void>;

/** Who may call a route: anyone (login, me, first run), any logged-in user
 *  (the default), or an admin (the content agent, the model setting, and
 *  anything that changes the owner's provider accounts). */
export type AuthLevel = "public" | "user" | "admin";

/** What a 500 says to the client. The thrown error can be a database error
 *  whose message holds the failed query and its parameters; that goes to
 *  the server log, never into a reply. */
export const INTERNAL_ERROR = "something went wrong on the server; its log has the details";

/**
 * Every route goes through here: the same-origin check, then the session
 * (cookie → user and active learner, auth.ts sessionFor), then the access
 * level, then — for a learner-scoped route — the page's learner, then a
 * JSON error envelope for anything thrown. No exceptions — a route that
 * bypasses wrap() is the bug the rule in CLAUDE.md exists to prevent. The
 * level defaults to "user", so a new route is protected unless it says
 * otherwise: no session is a 401, a non-admin on an admin route a 403.
 * `learner: true` is for a route that acts for the active learner (its
 * profile, its mode's packs, its voice turn): the request's X-Learner-Id
 * must be that learner, else a 409 `stale_learner` (auth.ts pageLearner),
 * checked here once rather than in each handler.
 */
export function wrap(fn: PublicHandler, opts: { auth: "public" }): Handler;
export function wrap(fn: LearnerHandler, opts: { auth?: "user" | "admin"; learner: true }): Handler;
export function wrap(fn: UserHandler, opts?: { auth?: "user" | "admin" }): Handler;
export function wrap(fn: PublicHandler | UserHandler | LearnerHandler, opts: { auth?: AuthLevel; learner?: boolean } = {}): Handler {
  const level: AuthLevel = opts.auth ?? "user";
  return (req, res) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { error: "cross-origin request refused" } satisfies ErrorReply);
      return;
    }
    return Promise.resolve()
      .then(async () => {
        const ctx = await sessionFor(req, res);
        if (level !== "public") {
          if (!ctx.user) throw new HttpError(401, "log in first");
          if (level === "admin" && !ctx.user.isAdmin) throw new HttpError(403, "only an admin can do that");
          if (opts.learner) pageLearner(req, ctx);
        }
        // The overloads tie each option set to its handler type; at this
        // point a non-public route has a user, and a learner route a learner.
        return (fn as PublicHandler)(req, res, ctx);
      })
      .catch((e) => {
        // A bad or oversized body is the client's fault, not a crash.
        const known = e instanceof HttpError;
        const status = known ? e.status : 500;
        // The path only: a query string can carry what a learner wrote or
        // said (the pronunciation route's ?text=), never for the log.
        if (status >= 500 && !known) console.error(`[lingo-dojo] ${req.method} ${(req.url ?? "").split("?")[0]}:`, e);
        // Headers already out (an SSE stream mid-flight): there is no
        // envelope left to send, and sendJson's writeHead would throw INSIDE
        // this catch — an unhandled rejection, which under Node 26 exits the
        // dev server. Cut the socket so the client sees a broken response
        // rather than a hung one.
        if (res.headersSent) { res.destroy(); return; }
        if (res.writableEnded) return;
        // Only an HttpError's sentence is meant for the client; anything
        // else (a database error, a bug) is logged above and answered with
        // the generic line.
        const reply: ErrorReply = known ? { error: e.message, ...(e.code ? { code: e.code as ErrorCode } : {}) } : { error: INTERNAL_ERROR };
        sendJson(res, status, reply);
      });
  };
}

/** Set once the plugin has started in this process. On globalThis because
 *  a Vite restart re-imports the config, and with it a fresh copy of this
 *  module; the process (and this flag) stays. */
const STARTED = Symbol.for("lingo-dojo.api.started");
export type StartedFlag = { [STARTED]?: boolean };

/**
 * The boot check (docs/DATA.md). Vite awaits configureServer, so on the
 * first start a database that is missing, down or behind on migrations stops
 * `npm run dev` with checkDatabase's message (what to run) instead of
 * starting a server whose first database route fails far from the cause.
 * On a restart (a server file changed, as a `git pull` does) it never
 * throws: the new code comes up behind a gate that answers 503 until the
 * database is current (dbGate.ts says why a throw here is worse).
 */
export async function bootGate(
  logger: GateLog,
  { check: runCheck = checkDatabase, flag = globalThis as StartedFlag }: { check?: () => Promise<{ applied: number }>; flag?: StartedFlag } = {},
): Promise<DatabaseGate> {
  let applied = 0;
  const check = async () => {
    ({ applied } = await runCheck());
  };
  const gate = await openDatabaseGate(check, { log: logger });
  if (gate.error && !flag[STARTED]) throw gate.error;
  flag[STARTED] = true;
  if (gate.error) {
    const fix = gate.error instanceof DatabaseNotReady ? gate.error.liveFix : "";
    logger.error(
      `${gate.error.message.split("\n")[0]}\n` +
        `Restarted with the new code anyway; until then every /api request answers 503. ${fix}`,
    );
  } else {
    logger.info(`  database ready (${applied} migration(s) applied)`);
  }
  return gate;
}

export function apiPlugins(
  opts: { checkDatabase?: boolean; db?: Db; boot?: { check: () => Promise<{ applied: number }>; flag: StartedFlag } } = {},
): Plugin {
  // The HTTP tests hand in an in-process PGlite: the real routes, no server.
  if (opts.db) setDb(opts.db);
  return {
    name: "lingo-dojo-api",
    apply: "serve",
    configureServer(server) {
      // The HTTP tests mount the plugin with checkDatabase: false and their
      // own PGlite (db); they never need a Postgres server, and they call
      // this hook without awaiting it, so the routes go on synchronously.
      if (opts.checkDatabase === false) return mountRoutes(server.middlewares);
      const logger = { info: (m: string) => server.config.logger.info(m), error: (m: string) => server.config.logger.error(m, { timestamp: true }) };
      return bootGate(logger, opts.boot).then((gate) => {
        // Ahead of every route, so no handler runs on a stale schema.
        server.middlewares.use("/api", gate.middleware);
        mountRoutes(server.middlewares);
      });
    },
  };
}

/** Every /api mount, in order (the first matching prefix wins). */
function mountRoutes(middlewares: ViteDevServer["middlewares"]): void {
  // Logins (auth.ts). The three public routes are mounted on their own
  // paths, ahead of /api/auth, so nothing else under it is public by
  // accident.
  middlewares.use("/api/auth/login", wrap(handleLogin, { auth: "public" }));
  middlewares.use("/api/auth/me", wrap(handleMe, { auth: "public" }));
  middlewares.use("/api/auth/first-run", wrap(handleFirstRun, { auth: "public" }));
  middlewares.use("/api/auth", wrap(handleAuth));
  middlewares.use("/api/learners", wrap(handleLearners));
  // No cache: every library route re-reads content/ from disk, so an
  // edit by the agent or an editor is live on the next request. The
  // library itself (GET /api/content) is readable in either mode. The
  // rest act for the active learner (`learner: true`: the page must
  // name that learner): the profile is its row, its packs, folders and
  // pack revisions are its rows in the database (no other learner's,
  // not even the same account's), and the mode its assembles and
  // exports work in is its mode.
  middlewares.use("/api/content", wrap(handleContent));
  middlewares.use("/api/profile", wrap(handleProfile, { learner: true }));
  middlewares.use("/api/packs", wrap(handlePacks, { learner: true }));
  middlewares.use("/api/folders", wrap(handleFolders, { learner: true }));
  middlewares.use("/api/pack-revisions", wrap(handlePackRevisions, { learner: true }));
  // Library scenes and collections the active language has hidden
  // (hidden.ts): a per-language preference, the library itself untouched.
  middlewares.use("/api/hidden-scenes", wrap(handleHiddenScenes, { learner: true }));
  middlewares.use("/api/assemble", wrap(handleAssemble, { learner: true }));
  middlewares.use("/api/export", wrap(handleExport, { learner: true }));
  // The embedded agent (SSE, auto-commit of content/ after each turn) and
  // its model setting: it writes the shared library, so admins only.
  middlewares.use("/api/chat", wrap(handleChat, { auth: "admin" }));
  middlewares.use("/api/settings", wrap(handleSettings, { auth: "admin" }));
  // Voice practice (voice.ts). A turn, a cast and the character card's
  // cached sounds are for the learner;
  // adding a Voice Library voice changes the owner's ElevenLabs account,
  // so it is an admin's. Mounted ahead of /api/voice, whose handler has
  // the rest (settings, voices, transcribe, speak, library search).
  middlewares.use("/api/voice/turn", wrap(handleVoiceTurn, { learner: true }));
  middlewares.use("/api/voice/cast", wrap(handleVoiceCast, { learner: true }));
  middlewares.use("/api/voice/sound", wrap(handleVoiceSound, { learner: true }));
  // Scribe keyterms come from the learner's conversation and phrase bank.
  middlewares.use("/api/voice/transcribe", wrap(handleVoiceTranscribe, { learner: true }));
  middlewares.use("/api/voice/library/add", wrap(handleVoiceLibraryAdd, { auth: "admin" }));
  middlewares.use("/api/voice", wrap(handleVoice));
  // Saved conversations (conversations.ts): the learner's own, so the
  // page must name that learner, like the turn that writes them. End
  // comes from a page-unload keepalive fetch too, which carries the
  // same header and cookie, so it passes the same checks.
  middlewares.use("/api/conversations", wrap(handleConversations, { learner: true }));
  // The phrase bank (phrases.ts): the active language's own, like its
  // packs and History.
  middlewares.use("/api/phrases", wrap(handlePhrases, { learner: true }));
  // Practice (practice.ts): flashcards over that same bank.
  middlewares.use("/api/practice", wrap(handlePractice, { learner: true }));
  // Pronunciation checks (pronunciation.ts): a recording scored against
  // known text for the active learner's language, Mandarin only; Azure
  // with keys for any learner, local otherwise. Nothing is stored.
  middlewares.use("/api/pronunciation", wrap(handlePronunciation, { learner: true }));
  // Anything else under /api is a typo, not the SPA shell: answer in the
  // envelope the client already parses instead of index.html.
  middlewares.use("/api", wrap((_req, res) => sendJson(res, 404, { error: "no such route" }), { auth: "public" }));
}
