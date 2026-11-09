import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleChat, handleSettings } from "./chat.ts";
import { handleAssemble, handleContent, handleExport, handleFolders, handlePacks, handleProfile } from "./content.ts";
import { HttpError, sendJson } from "./sse.ts";
import { handleVoice } from "./voice.ts";

// The whole "backend": dev-server-only middleware on the Vite server.
// Single-user, localhost — no auth by design. Copied from Atlas.

/**
 * Reject cross-origin requests. Without this, any website the user visits
 * while `npm run dev` is up can POST to these routes — a text/plain body is a
 * CORS "simple request" (no preflight), so the browser sends it and the
 * server would write pack files and exports (and, once the chat lands, spawn
 * agents that edit content/). A request with no Origin (same-origin
 * navigation, curl) is allowed; one whose Origin host doesn't match the
 * request Host is refused. Pure, so a test pins the rule rather than the
 * wiring.
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

/** Every route goes through here: same-origin check, JSON error envelope for
 *  anything thrown. No exceptions — a route that bypasses wrap() is the bug
 *  the same-origin rule in CLAUDE.md exists to prevent. */
export function wrap(fn: Handler): Handler {
  return (req, res) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { error: "cross-origin request refused" });
      return;
    }
    return Promise.resolve()
      .then(() => fn(req, res))
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

export function apiPlugins(): Plugin {
  return {
    name: "lingo-dojo-api",
    apply: "serve",
    configureServer(server) {
      // No database and no cache: every route re-reads content/ from disk,
      // so an edit by the agent or an editor is live on the next request.
      server.middlewares.use("/api/content", wrap(handleContent));
      server.middlewares.use("/api/profile", wrap(handleProfile));
      server.middlewares.use("/api/packs", wrap(handlePacks));
      server.middlewares.use("/api/folders", wrap(handleFolders));
      server.middlewares.use("/api/assemble", wrap(handleAssemble));
      server.middlewares.use("/api/export", wrap(handleExport));
      // The embedded agent (SSE, auto-commit of content/ after each turn) and
      // its model setting.
      server.middlewares.use("/api/chat", wrap(handleChat));
      server.middlewares.use("/api/settings", wrap(handleSettings));
      // Voice practice: transcribe, one dojo-master turn, speak (voice.ts).
      server.middlewares.use("/api/voice", wrap(handleVoice));
      // Anything else under /api is a typo, not the SPA shell: answer in the
      // envelope the client already parses instead of index.html.
      server.middlewares.use("/api", wrap((_req, res) => sendJson(res, 404, { error: "no such route" })));
    },
  };
}
