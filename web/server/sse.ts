import type { ServerResponse, IncomingMessage } from "node:http";

// HTTP helpers shared by every route, copied from Atlas (web/server/sse.ts)
// so the embedded-agent chat can drop in unchanged: JSON bodies and replies,
// the HttpError wrap() turns into a status, and SSE over a POST body (the
// client parses the stream manually; EventSource can't POST). openSse has no
// caller until server/chat.ts lands.

export type SseSend = (event: string, data: unknown) => void;

export function openSse(res: ServerResponse): SseSend {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return (event, data) => {
    // destroyed catches client aborts (writableEnded stays false there)
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** Thrown by readJsonBody; wrap() turns it into the status it names. */
export class HttpError extends Error {
  status: number;
  /** A machine-readable reason beside the sentence, for the few errors the
   *  client acts on rather than shows (wire.ts ErrorReply). */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const MAX_JSON_BODY = 1 << 20; // 1 MB — a pack is a few KB; a chat history is the largest legitimate body

/** `max` lowers the 1 MB cap for a route whose body is small by nature (a
 *  login), so a caller with no session can't make the server hold more. */
export async function readJsonBody<T>(req: IncomingMessage, max = MAX_JSON_BODY): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { Allow: allow, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `method not allowed (use ${allow})` }));
}

/** The path segment after the mount point, e.g. "/2026-10-19-x" → "2026-10-19-x".
 *  connect strips the mount prefix from req.url before the handler sees it. */
export function subPath(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  let seg = pathname.replace(/^\/+|\/+$/g, "");
  try {
    seg = decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, "malformed id");
  }
  return seg;
}
