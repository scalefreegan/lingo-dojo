import type { IncomingMessage, ServerResponse } from "node:http";
import { savePref } from "../../scripts/db/prefs.ts";
import { readPref } from "../shared/prefs.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The learner's kept choices (docs/DATA.md §Kept choices).
//
//   PUT /api/prefs   {key, value, at}   → {saved}   (false: a later choice is kept)
//
// Read with the page's first request, not here: GET /api/auth/me carries the
// active language's (auth.ts meReply), so they are in the browser before the
// app draws. Mounted with wrap's `learner: true`, and the language is the
// session's, never one named in the body.

/** /api/prefs, mounted with wrap's `learner: true`. */
export async function handlePrefs(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "PUT") return methodNotAllowed(res, "PUT");
  const r = readPref(await readJsonBody(req));
  if ("error" in r) throw new HttpError(400, r.error);
  sendJson(res, 200, { saved: await savePref(rawDb(), ctx.language, r.value) });
}
