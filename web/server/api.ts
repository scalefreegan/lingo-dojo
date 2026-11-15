import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleAuth, handleFirstRun, handleLearners, handleLogin, handleMe, sessionFor, type Ctx, type PublicCtx } from "./auth.ts";
import { handleChat, handleSettings } from "./chat.ts";
import { handleAssemble, handleContent, handleExport, handleFolders, handlePacks, handleProfile } from "./content.ts";
import { checkDatabase, setDb, type Db } from "./db.ts";
import { HttpError, sendJson } from "./sse.ts";
import { handleVoice } from "./voice.ts";

// The whole "backend": dev-server-only middleware on the Vite server,
// bound to localhost. Copied from Atlas, plus logins (docs/DATA.md §Auth):
// every route says who may call it, and wrap() enforces it.

/**
 * Reject cross-origin requests. Without this, any website the user visits
 * while `npm run dev` is up can POST to these routes — a text/plain body is a
 * CORS "simple request" (no preflight), so the browser sends it and the
 * server would write pack files and exports (and, once the chat lands, spawn
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

/** Who may call a route: anyone (login, me, first run), any logged-in user
 *  (the default), or an admin (the content agent and anything else that
 *  writes content/). */
export type AuthLevel = "public" | "user" | "admin";

/**
 * Every route goes through here: the same-origin check, then the session
 * (cookie → user and active learner, auth.ts sessionFor), then the access
 * level, then a JSON error envelope for anything thrown. No exceptions — a
 * route that bypasses wrap() is the bug the rule in CLAUDE.md exists to
 * prevent. The level defaults to "user", so a new route is protected unless
 * it says otherwise: no session is a 401, a non-admin on an admin route a 403.
 */
export function wrap(fn: PublicHandler, opts: { auth: "public" }): Handler;
export function wrap(fn: UserHandler, opts?: { auth?: "user" | "admin" }): Handler;
export function wrap(fn: PublicHandler | UserHandler, opts: { auth?: AuthLevel } = {}): Handler {
  const level: AuthLevel = opts.auth ?? "user";
  return (req, res) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { error: "cross-origin request refused" });
      return;
    }
    return Promise.resolve()
      .then(async () => {
        const ctx = await sessionFor(req, res);
        if (level !== "public") {
          if (!ctx.user) throw new HttpError(401, "log in first");
          if (level === "admin" && !ctx.user.isAdmin) throw new HttpError(403, "only an admin can do that");
        }
        // The overloads tie each level to its handler type; at this point a
        // non-public route has a user, which is what UserHandler assumes.
        return (fn as PublicHandler)(req, res, ctx);
      })
      .catch((e) => {
        // A bad or oversized body is the client's fault, not a crash.
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(`[lingo-dojo] ${req.method} ${req.url}:`, e);
        // Headers already out (an SSE stream mid-flight): there is no
        // envelope left to send, and sendJson's writeHead would throw INSIDE
        // this catch — an unhandled rejection, which under Node 26 exits the
        // dev server. Cut the socket so the client sees a broken response
        // rather than a hung one.
        if (res.headersSent) { res.destroy(); return; }
        if (!res.writableEnded) sendJson(res, status, { error: String((e as Error)?.message || e) });
      });
  };
}

export function apiPlugins(opts: { checkDatabase?: boolean; db?: Db } = {}): Plugin {
  // The HTTP tests hand in an in-process PGlite: the real routes, no server.
  if (opts.db) setDb(opts.db);
  return {
    name: "lingo-dojo-api",
    apply: "serve",
    configureServer(server) {
      // Logins (auth.ts). The three public routes are mounted on their own
      // paths, ahead of /api/auth, so nothing else under it is public by
      // accident.
      server.middlewares.use("/api/auth/login", wrap(handleLogin, { auth: "public" }));
      server.middlewares.use("/api/auth/me", wrap(handleMe, { auth: "public" }));
      server.middlewares.use("/api/auth/first-run", wrap(handleFirstRun, { auth: "public" }));
      server.middlewares.use("/api/auth", wrap(handleAuth));
      server.middlewares.use("/api/learners", wrap(handleLearners));
      // No cache: every library route re-reads content/ from disk, so an
      // edit by the agent or an editor is live on the next request. The
      // profile is the active learner's row; packs are still files shared
      // by every account until they move to the database (DATA.md phase 2).
      server.middlewares.use("/api/content", wrap(handleContent));
      server.middlewares.use("/api/profile", wrap(handleProfile));
      server.middlewares.use("/api/packs", wrap(handlePacks));
      server.middlewares.use("/api/folders", wrap(handleFolders));
      server.middlewares.use("/api/assemble", wrap(handleAssemble));
      server.middlewares.use("/api/export", wrap(handleExport));
      // The embedded agent (SSE, auto-commit of content/ after each turn) and
      // its model setting: it writes the shared library, so admins only.
      server.middlewares.use("/api/chat", wrap(handleChat, { auth: "admin" }));
      server.middlewares.use("/api/settings", wrap(handleSettings, { auth: "admin" }));
      // Voice practice: transcribe, one dojo-master turn, speak (voice.ts).
      server.middlewares.use("/api/voice", wrap(handleVoice));
      // Anything else under /api is a typo, not the SPA shell: answer in the
      // envelope the client already parses instead of index.html.
      server.middlewares.use("/api", wrap((_req, res) => sendJson(res, 404, { error: "no such route" }), { auth: "public" }));
      // The boot check (docs/DATA.md): Vite awaits this hook, so a database
      // that is missing, down or behind on migrations stops `npm run dev`
      // with checkDatabase's message (what to run) instead of starting a
      // server whose first database route fails far from the cause. The
      // HTTP tests mount the plugin with checkDatabase: false and their own
      // PGlite (db); they never need a Postgres server.
      if (opts.checkDatabase === false) return;
      return checkDatabase().then(({ applied }) => {
        server.config.logger.info(`  database ready (${applied} migration(s) applied)`);
      });
    },
  };
}
