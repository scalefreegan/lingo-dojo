import type { IncomingMessage, ServerResponse } from "node:http";
import { assemble } from "../../scripts/assemble.mjs";
import {
  ID_RE, LEVELS_BY_MODE, MODES, PACK_ID_RE, createFolder, deleteFolder, deletePack, exportsDirFor, isMode, listFolders, loadContent,
  modeRoot, movePack, renamePack, savePack, writeExport,
} from "../../scripts/content.mjs";
import type {
  AssembleRequest, AssembleResult, Committed, ContentReply, ExportRequest, ExportResult, FolderDeleteReply, FolderReply, Mode,
  Pack, PackDeleteReply, PackReply, PackWriteReply, PacksReply, PickerKey, ProfileReply,
} from "../shared/wire.ts";
import { updateLearner, type Learner, type LearnerPatch } from "../../scripts/db/accounts.ts";
import { STALE_LEARNER, learnerMode, learnerProfile, type Ctx, type LearnerCtx } from "./auth.ts";
import { commitPacks } from "./commit.ts";
import { rawDb } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The content routes. All of them call loadContent() per request: content/ is
// small, the agent and the user's editor change it under the running server,
// and a cache would be one more thing to invalidate. The loader and assembler
// are the same modules the export CLI and the tests run.
//
// The mode comes from the session's active learner (auth.ts learnerMode):
// every route but GET /api/content works on that learner's tree, content/ or
// content/kids/ (scripts/content.mjs modeRoot), and answers 400 when a
// `?mode=` it is sent disagrees. Those routes are mounted with wrap's
// `learner: true`, so before any of this runs the request has named the
// learner its page shows and it is the active one (409 `stale_learner`
// otherwise, auth.ts pageLearner). GET
// /api/content keeps its `?mode=`, since an admin browses and has the agent
// edit both libraries. The two trees never mix: a kids pack lives in
// content/kids/packs and a kids export in exports/kids/.
//
// The profile is the active learner's row, not <tree>/profile.yaml: the
// loader still reads that file (the offline export CLI uses it), but every
// reply and every assemble here puts the learner in its place.
//
//   GET    /api/content            library (mode, levels, schema, frame, profile, languages, units, scenarios, problems)
//   PUT    /api/profile            merge the picker keys into the active learner → {profile}
//   GET    /api/packs              {packs, folders, problems}
//   GET    /api/packs/:id          one pack; an id is <stem> or <folder>/<stem>
//   PUT    /api/packs/:id          write <tree>/packs/<id>.yaml from a JSON pack → {pack, commit}
//   DELETE /api/packs/:id          → {ok, commit}
//   POST   /api/packs/:id/move     {folder} → {pack, commit}, pack.id being the new id
//   POST   /api/packs/:id/rename   {title} → {pack, commit}, likewise
//   POST   /api/folders            {name} → {folder, folders, commit}
//   DELETE /api/folders/:name      → {ok, folders, commit}; only an empty folder
//   POST   /api/assemble           {pack} → {markdown, warnings, stats}
//   POST   /api/export             {pack, id} → writes <exports>/<id>.md, {path, stats, warnings}
//
// Ids come from the request, so each is checked here (a 400 the user can
// read) and again inside the loader's write functions, which also prove the
// resolved path stays inside the tree's packs dir or exports/.
//
// Every pack write, move, rename or delete is followed by a `packs: …` commit
// (`packs(kids): …` for the kids tree) of that packs dir (commit.ts). The
// write is the result; the commit is reported beside it, and a git failure
// is `commit: null` plus `error` on a 200 rather than a failed request — the
// file is already on disk.

/** GET /api/content's `?mode=`: the active learner's mode when absent (adult
 *  with none picked), a 400 when not a mode. Either library may be read. */
function browseMode(req: IncomingMessage, ctx: Ctx): Mode {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("mode");
  if (raw == null || raw === "") return ctx.learner?.mode ?? "adult";
  if (!isMode(raw)) throw new HttpError(400, `unknown mode ${JSON.stringify(raw)} (one of ${MODES.join(", ")})`);
  return raw as Mode;
}

/** The library for assembling: the mode's tree with the active learner as
 *  its profile. */
function learnerContent(mode: Mode, ctx: Ctx) {
  return { ...loadContent(modeRoot(mode)), profile: learnerProfile(ctx.learner) };
}

/** An export id: one segment. */
function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new HttpError(400, `invalid id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens`);
  }
  return id;
}

/** A pack id from the path: `<stem>` or `<folder>/<stem>`. */
function checkPackId(id: unknown): string {
  if (typeof id !== "string" || !PACK_ID_RE.test(id)) {
    throw new HttpError(400, `invalid id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens, with at most one folder`);
  }
  return id;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** The loader's refusals carry an errno-style `code`; the ones a client can
 *  act on become a status. Anything else is a 500, like any thrown error. */
const STATUS_BY_CODE: Record<string, number> = { EINVAL: 400, ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409 };

function fromLoader<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = typeof code === "string" ? STATUS_BY_CODE[code] : undefined;
    if (status) throw new HttpError(status, (e as Error).message);
    throw e;
  }
}

/** The commit half of a write reply. A git failure is logged and reported,
 *  never thrown: the write it was recording has already happened. */
async function committed(what: string, mode: Mode): Promise<Committed> {
  const c = await commitPacks(what, { mode });
  if ("hash" in c) return { commit: { hash: c.hash, summary: c.summary } };
  if ("error" in c) {
    console.error(`[lingo-dojo] ${mode === "adult" ? "packs" : `packs(${mode})`}: commit failed (${what}): ${c.error}`);
    return { commit: null, error: `written, but git did not commit it: ${c.error}` };
  }
  return { commit: null };
}

/** GET /api/content's shape for a mode: the loader's result plus the mode
 *  and its level list, minus packs. The chat route builds its system prompt
 *  from the same shape. */
export function contentReply(mode: Mode, learner: Learner | null): ContentReply {
  const c = loadContent(modeRoot(mode));
  // The profile is the active learner's when it practises in this library;
  // the other library (an admin browsing it) has no learner, so no profile.
  const profile = learner?.mode === mode ? learnerProfile(learner) : {};
  return {
    mode, levels: LEVELS_BY_MODE[mode], root: c.root, schema: c.schema, frame: c.frame, profile, languages: c.languages,
    units: c.units, scenarios: c.scenarios, problems: c.problems,
  };
}

export function handleContent(req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  sendJson(res, 200, contentReply(browseMode(req, ctx), ctx.learner));
}

/** The keys PUT /api/profile may write: what the pickers and the Name field
 *  show, profile key → learner column. Goals and notes are prose, edited
 *  through PATCH /api/learners/:id, so this route can't clobber them. */
const PICKER_COLUMNS: Record<PickerKey, keyof LearnerPatch> = {
  learner_name: "name", native_language: "nativeLanguage", target_language: "targetLanguage", target_variant: "targetVariant", level: "level",
};
/** A name, a language or a variant is a few words; this is a sanity bound, not a format. */
const MAX_PROFILE_VALUE = 80;

export async function handleProfile(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "PUT") return methodNotAllowed(res, "PUT");
  learnerMode(req, ctx);
  const learner = ctx.learner;
  const body = await readJsonBody<unknown>(req);
  if (!isObject(body)) throw new HttpError(400, "body must be an object of profile keys");
  const patch: LearnerPatch = {};
  for (const [key, value] of Object.entries(body)) {
    const col = Object.prototype.hasOwnProperty.call(PICKER_COLUMNS, key) ? PICKER_COLUMNS[key as PickerKey] : undefined;
    if (!col) throw new HttpError(400, `unknown profile key "${key}" (this route takes ${Object.keys(PICKER_COLUMNS).join(", ")})`);
    if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
    if (value.length > MAX_PROFILE_VALUE) throw new HttpError(400, `${key} is too long (at most ${MAX_PROFILE_VALUE} characters)`);
    // A blank value clears the key, as it removed it from profile.yaml.
    patch[col] = value.trim();
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "nothing to save: the body names no profile key");
  if (patch.name === "") throw new HttpError(400, "a learner needs a name");
  const row = await updateLearner(rawDb(), ctx.user.id, learner.id, patch);
  // Archived since the session was read: the picker, not a silent no-op.
  if (!row) throw new HttpError(409, "choose who's practicing first", STALE_LEARNER);
  // The reply is the row as stored, not an echo of the request.
  sendJson(res, 200, { profile: learnerProfile(row) } satisfies ProfileReply);
}

export async function handlePacks(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const mode = learnerMode(req, ctx);
  const root = modeRoot(mode);
  const seg = subPath(req);
  if (!seg) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const { packs, problems } = loadContent(root);
    const packProblems = problems.filter((p) => /(^|[\\/])packs[\\/]/.test(p.file));
    sendJson(res, 200, { packs, folders: listFolders(root), problems: packProblems } satisfies PacksReply);
    return;
  }
  // POST /api/packs/<id>/<action>: the action is the last segment and the id
  // the rest. Only POST has actions, so GET /api/packs/oaxaca/move is still
  // a lookup of the pack "oaxaca/move".
  const parts = seg.split("/");
  const action = req.method === "POST" && parts.length > 1 && ["move", "rename"].includes(parts[parts.length - 1]) ? parts.pop() : null;
  const id = checkPackId(parts.join("/"));
  // Every write reads back through the loader, so the reply is what the file
  // now says (and what GET /api/packs will list), not an echo of the request.
  const readBack = (packId: string, verb: string): Pack => {
    const pack = loadContent(root).packs.find((p) => p.id === packId);
    if (!pack) throw new Error(`pack ${packId} was ${verb} but does not load back`);
    return pack;
  };

  if (action === "move") {
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body) || typeof body.folder !== "string") throw new HttpError(400, 'body must be {folder} ("" for no folder)');
    const folder = body.folder;
    const newId = fromLoader(() => movePack(id, folder, root));
    const pack = readBack(newId, "moved");
    sendJson(res, 200, { pack, ...(await committed(`moved ${id} to ${folder || "no folder"}`, mode)) } satisfies PackWriteReply);
    return;
  }
  if (action === "rename") {
    const body = await readJsonBody<unknown>(req);
    const title = isObject(body) ? body.title : undefined;
    if (typeof title !== "string" || !title.trim()) throw new HttpError(400, "body must be {title}, and a pack needs a title");
    const newId = fromLoader(() => renamePack(id, title, root));
    const pack = readBack(newId, "renamed");
    sendJson(res, 200, { pack, ...(await committed(`renamed ${id} to ${newId}`, mode)) } satisfies PackWriteReply);
    return;
  }
  if (req.method === "GET") {
    const pack = loadContent(root).packs.find((p) => p.id === id);
    if (!pack) return sendJson(res, 404, { error: `no pack "${id}"` });
    sendJson(res, 200, { pack } satisfies PackReply);
    return;
  }
  if (req.method === "PUT") {
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body)) throw new HttpError(400, "body must be a pack object");
    if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "a pack needs a title");
    const title = body.title.trim();
    const created = typeof body.created === "string" && body.created ? body.created : new Date().toISOString();
    fromLoader(() => savePack(id, { ...body, title, created }, root));
    const pack = readBack(id, "written");
    sendJson(res, 200, { pack, ...(await committed(`saved ${id}`, mode)) } satisfies PackWriteReply);
    return;
  }
  if (req.method === "DELETE") {
    if (!fromLoader(() => deletePack(id, root))) return sendJson(res, 404, { error: `no pack "${id}"` });
    sendJson(res, 200, { ok: true, ...(await committed(`deleted ${id}`, mode)) } satisfies PackDeleteReply);
    return;
  }
  methodNotAllowed(res, "GET, PUT, DELETE");
}

export async function handleFolders(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const mode = learnerMode(req, ctx);
  const root = modeRoot(mode);
  const name = subPath(req);
  if (!name) {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body) || typeof body.name !== "string") throw new HttpError(400, "body must be {name}");
    const folder = body.name;
    fromLoader(() => createFolder(folder, root)); // EINVAL on a bad name → 400, EEXIST → 409
    sendJson(res, 200, { folder, folders: listFolders(root), ...(await committed(`folder ${folder} created`, mode)) } satisfies FolderReply);
    return;
  }
  if (req.method !== "DELETE") return methodNotAllowed(res, "DELETE");
  if (!fromLoader(() => deleteFolder(name, root))) return sendJson(res, 404, { error: `no folder "${name}"` });
  sendJson(res, 200, { ok: true, folders: listFolders(root), ...(await committed(`folder ${name} deleted`, mode)) } satisfies FolderDeleteReply);
}

export async function handleAssemble(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const mode = learnerMode(req, ctx);
  const body = await readJsonBody<Partial<AssembleRequest>>(req);
  if (!isObject(body) || !isObject(body.pack)) throw new HttpError(400, "body must be {pack}");
  sendJson(res, 200, assemble(learnerContent(mode, ctx), body.pack, mode) satisfies AssembleResult);
}

export async function handleExport(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const mode = learnerMode(req, ctx);
  const body = await readJsonBody<Partial<ExportRequest>>(req);
  if (!isObject(body) || !isObject(body.pack)) throw new HttpError(400, "body must be {pack, id}");
  const id = checkId(body.id);
  const { markdown, stats, warnings } = assemble(learnerContent(mode, ctx), body.pack, mode);
  const path = writeExport(id, markdown, exportsDirFor(mode));
  sendJson(res, 200, { path, stats, warnings } satisfies ExportResult);
}
