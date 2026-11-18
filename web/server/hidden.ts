import type { IncomingMessage, ServerResponse } from "node:http";
import { HiddenLimitError, hideScene, listHidden, unhideScene, type HiddenRow } from "../../scripts/db/hidden.ts";
import { readHiddenRef } from "../shared/scenes.ts";
import type { HiddenScene, HiddenSceneReply, HiddenScenesReply, UnhideSceneReply } from "../shared/wire.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// Hidden library scenes (docs/DATA.md §Hidden scenes): the scenes and
// collections the active language has hidden from its Scene tab and its
// random draws.
//
//   GET    /api/hidden-scenes                 → {hidden: [{kind, key, hiddenAt}]}, oldest first
//   POST   /api/hidden-scenes   {kind, key}   → {hidden, created}  (201 new, 200 already hidden; 409 past MAX_HIDDEN_PER_LANGUAGE)
//   DELETE /api/hidden-scenes   {kind, key}   → {unhidden}         (false: it wasn't hidden)
//
// Mounted with wrap's `learner: true`: the page must name the session's
// learner and language (else 409 stale_learner), and the language is the
// session's (ctx.language), never one named in the body, so a page can
// only hide and unhide within the language it shows. Every row goes
// through that language's scope (scripts/db/hidden.ts).

const wireRow = (r: HiddenRow): HiddenScene => ({ kind: r.kind, key: r.key, hiddenAt: r.hiddenAt.toISOString() });

async function bodyRef(req: IncomingMessage) {
  const r = readHiddenRef(await readJsonBody(req));
  if ("error" in r) throw new HttpError(400, r.error);
  return r.value;
}

/** /api/hidden-scenes, mounted with wrap's `learner: true`. */
export async function handleHiddenScenes(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method === "GET") {
    const rows = await listHidden(rawDb(), ctx.language);
    return sendJson(res, 200, { hidden: rows.map(wireRow) } satisfies HiddenScenesReply);
  }
  if (req.method === "POST") {
    const { kind, key } = await bodyRef(req);
    const { row, created } = await hideScene(rawDb(), ctx.language, kind, key).catch((e) => {
      if (e instanceof HiddenLimitError) throw new HttpError(409, e.message);
      throw e;
    });
    return sendJson(res, created ? 201 : 200, { hidden: wireRow(row), created } satisfies HiddenSceneReply);
  }
  if (req.method === "DELETE") {
    const { kind, key } = await bodyRef(req);
    return sendJson(res, 200, { unhidden: await unhideScene(rawDb(), ctx.language, kind, key) } satisfies UnhideSceneReply);
  }
  methodNotAllowed(res, "GET, POST, DELETE");
}
