import type { IncomingMessage, ServerResponse } from "node:http";
import { assemble } from "../../scripts/assemble.mjs";
import { ID_RE, LEVELS_BY_MODE, MODES, exportsDirFor, isMode, loadContent, modeRoot, writeExport } from "../../scripts/content.mjs";
import type {
  AssembleRequest, AssembleResult, ContentReply, DeletedPacksReply, ExportRequest, ExportResult, FolderDeleteReply, FolderReply, Mode,
  PackDeleteReply, PackReply, PackRestoreReply, PackRevisionsReply, PackWriteReply, PacksReply, PickerKey, ProfileReply,
} from "../shared/wire.ts";
import {
  updateLanguageProfile, updateLearner, type LanguageProfile, type LanguageProfilePatch, type Learner, type LearnerPatch,
} from "../../scripts/db/accounts.ts";
import {
  PackError, createFolder, deleteFolder, deletePack, getPack, listDeleted, listPacks, listRevisions, movePack, parsePackId, renamePack,
  restoreRevision, savePack, undeletePack,
} from "../../scripts/db/packs.ts";
import { STALE_LEARNER, languageWriteError, learnerMode, learnerProfile, type Ctx, type LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { reviewFor } from "./recall.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The content routes. The library ones call loadContent() per request:
// content/ is small, the agent and the user's editor change it under the
// running server, and a cache would be one more thing to invalidate. The
// loader and assembler are the same modules the export CLI and the tests run.
//
// The mode comes from the session's active learner (auth.ts learnerMode):
// every route but GET /api/content works for that learner, and answers 400
// when a `?mode=` it is sent disagrees. Those routes are mounted with wrap's
// `learner: true`, so before any of this runs the request has named the
// learner its page shows and it is the active one (409 `stale_learner`
// otherwise, auth.ts pageLearner). GET /api/content keeps its `?mode=`,
// since an admin browses and has the agent edit both libraries.
//
// The profile is the active learner's row with its active language's, not
// <tree>/profile.yaml: the loader still reads that file (the offline export
// CLI uses it), but every reply and every assemble here puts the learner and
// its language in its place.
//
// Saved packs and their folders are the active language's rows in the
// database (scripts/db/packs.ts, docs/DATA.md §Packs), not files: each of a
// learner's languages has its own library, a kids learner's are kids packs
// because the learner is, and no pack route writes under content/ or makes
// a git commit. The
// pack files under content/**/packs are seed content (imported at the first
// run and by `npm run db:import`) and the export CLI's input; the app never
// lists them. Undo is the revision log: every write records a revision, a
// delete is soft, and /api/pack-revisions lists and restores them.
//
//   GET    /api/content            library (mode, levels, schema, frame, profile, languages, units, scenarios, problems)
//   PUT    /api/profile            merge the picker keys into the active learner and language → {profile}
//   GET    /api/packs              {packs, folders, problems}
//   GET    /api/packs/:id          one pack; an id is <slug> or <folder>/<slug>
//   PUT    /api/packs/:id          create or replace the pack at that id from a JSON pack → {pack}
//   DELETE /api/packs/:id          soft delete → {ok}
//   POST   /api/packs/:id/move     {folder} → {pack}, pack.id being the new id
//   POST   /api/packs/:id/rename   {title} → {pack}, likewise
//   POST   /api/folders            {name} → {folder, folders}
//   DELETE /api/folders/:name      → {ok, folders}; only a folder with no packs
//   GET    /api/pack-revisions?id=<pack id>          → {revisions}, newest first
//   GET    /api/pack-revisions/deleted               → {packs}, the deleted packs
//   POST   /api/pack-revisions/:revision/restore     → {pack}
//   POST   /api/assemble           {pack} → {markdown, warnings, stats}
//   POST   /api/export             {pack, id} → writes <exports>/<id>.md, {path, stats, warnings}
//
// Ids come from the request, so each is checked (a 400 the user can read)
// before any query; the queries themselves are scoped to the language
// (forLanguageProfile), so another language's pack, of the same learner or
// any other, is a 404 like a missing one.

/** GET /api/content's `?mode=`: the active learner's mode when absent (adult
 *  with none picked), a 400 when not a mode. Either library may be read. */
function browseMode(req: IncomingMessage, ctx: Ctx): Mode {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("mode");
  if (raw == null || raw === "") return ctx.learner?.mode ?? "adult";
  if (!isMode(raw)) throw new HttpError(400, `unknown mode ${JSON.stringify(raw)} (one of ${MODES.join(", ")})`);
  return raw as Mode;
}

/** The library for assembling: the mode's tree with the active learner and
 *  language as its profile. */
function learnerContent(mode: Mode, ctx: Ctx) {
  return { ...loadContent(modeRoot(mode)), profile: learnerProfile(ctx.learner, ctx.language) };
}

/** An export id: one segment. */
function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new HttpError(400, `invalid id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens`);
  }
  return id;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** The handle the pack layer runs its transactions on. Every query it makes
 *  goes through forLanguageProfile(tx, language), the scope profileRows()
 *  is, built on the transaction rather than the pool (the accounts layer's
 *  pattern). */
const db = () => rawDb();

/** PackError codes (scripts/db/packs.ts) → the status a client can act on.
 *  Anything else is a 500, like any thrown error. */
const STATUS_BY_CODE: Record<PackError["code"], number> = { EINVAL: 400, ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, ESTATE: 409 };

async function packOp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PackError) throw new HttpError(STATUS_BY_CODE[e.code], e.message);
    throw e;
  }
}

/** GET /api/content's shape for a mode: the loader's result plus the mode
 *  and its level list, minus packs. The chat route builds its system prompt
 *  from the same shape. */
export function contentReply(mode: Mode, learner: Learner | null, language: LanguageProfile | null): ContentReply {
  const c = loadContent(modeRoot(mode));
  // The profile is the active learner's when it practises in this library;
  // the other library (an admin browsing it) has no learner, so no profile.
  const profile = learner?.mode === mode ? learnerProfile(learner, language) : {};
  return {
    mode, levels: LEVELS_BY_MODE[mode], root: c.root, schema: c.schema, frame: c.frame, profile, languages: c.languages,
    units: c.units, scenarios: c.scenarios, problems: c.problems,
  };
}

export function handleContent(req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  sendJson(res, 200, contentReply(browseMode(req, ctx), ctx.learner, ctx.language));
}

/** The keys PUT /api/profile may write: what the pickers and the Name field
 *  show, profile key → the learner's column (the person) or the active
 *  language's (the rest). Goals and notes are prose, edited through PATCH
 *  /api/learners/:id/languages/:languageId, so this route can't clobber them.
 *  `target_language` may only name the active language itself (a no-op):
 *  it is the profile's identity, so another one is a 400 from
 *  updateLanguageProfile, never a rename of this profile and its packs. */
const PICKER_COLUMNS: Record<PickerKey, { learner: keyof LearnerPatch } | { language: keyof LanguageProfilePatch }> = {
  learner_name: { learner: "name" },
  native_language: { learner: "nativeLanguage" },
  target_language: { language: "targetLanguage" },
  target_variant: { language: "targetVariant" },
  level: { language: "level" },
};
/** A name, a language or a variant is a few words; this is a sanity bound, not a format. */
const MAX_PROFILE_VALUE = 80;

export async function handleProfile(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "PUT") return methodNotAllowed(res, "PUT");
  learnerMode(req, ctx);
  const body = await readJsonBody<unknown>(req);
  if (!isObject(body)) throw new HttpError(400, "body must be an object of profile keys");
  const learnerSet: LearnerPatch = {};
  const languageSet: LanguageProfilePatch = {};
  for (const [key, value] of Object.entries(body)) {
    const col = Object.prototype.hasOwnProperty.call(PICKER_COLUMNS, key) ? PICKER_COLUMNS[key as PickerKey] : undefined;
    if (!col) throw new HttpError(400, `unknown profile key "${key}" (this route takes ${Object.keys(PICKER_COLUMNS).join(", ")})`);
    if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
    if (value.length > MAX_PROFILE_VALUE) throw new HttpError(400, `${key} is too long (at most ${MAX_PROFILE_VALUE} characters)`);
    // A blank value clears the key, as it removed it from profile.yaml.
    if ("learner" in col) learnerSet[col.learner] = value.trim();
    else languageSet[col.language] = value.trim();
  }
  if (Object.keys(learnerSet).length + Object.keys(languageSet).length === 0) throw new HttpError(400, "nothing to save: the body names no profile key");
  if (learnerSet.name === "") throw new HttpError(400, "a learner needs a name");
  // One transaction: both rows change, or neither does. The learner or its
  // language archived since the session was read throws inside it, so the
  // learner's half rolls back too, and the page re-reads who's practising.
  const stale = () => new HttpError(409, "choose who's practicing first", STALE_LEARNER);
  const rows = await rawDb().transaction(async (tx) => {
    const learner = await updateLearner(tx, ctx.user.id, ctx.learner.id, learnerSet);
    if (!learner) throw stale();
    const language = await updateLanguageProfile(tx, learner.id, ctx.language.id, languageSet).catch((e) => languageWriteError(e, learner.name));
    if (!language) throw stale();
    return { learner, language };
  });
  // The reply is the rows as stored, not an echo of the request.
  sendJson(res, 200, { profile: learnerProfile(rows.learner, rows.language) } satisfies ProfileReply);
}

export async function handlePacks(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  learnerMode(req, ctx);
  const language = ctx.language;
  const seg = subPath(req);
  if (!seg) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const { packs, folders } = await listPacks(db(), language);
    sendJson(res, 200, { packs, folders, problems: [] } satisfies PacksReply);
    return;
  }
  // POST /api/packs/<id>/<action>: the action is the last segment and the id
  // the rest. Only POST has actions, so GET /api/packs/oaxaca/move is still
  // a lookup of the pack "oaxaca/move".
  const parts = seg.split("/");
  const action = req.method === "POST" && parts.length > 1 && ["move", "rename"].includes(parts[parts.length - 1]) ? parts.pop() : null;
  const id = parts.join("/");
  await packOp(async () => parsePackId(id)); // a 400 before the body is read

  if (action === "move") {
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body) || typeof body.folder !== "string") throw new HttpError(400, 'body must be {folder} ("" for no folder)');
    const pack = await packOp(() => movePack(db(), language, id, body.folder));
    sendJson(res, 200, { pack } satisfies PackWriteReply);
    return;
  }
  if (action === "rename") {
    const body = await readJsonBody<unknown>(req);
    const title = isObject(body) ? body.title : undefined;
    if (typeof title !== "string" || !title.trim()) throw new HttpError(400, "body must be {title}, and a pack needs a title");
    const pack = await packOp(() => renamePack(db(), language, id, title));
    sendJson(res, 200, { pack } satisfies PackWriteReply);
    return;
  }
  if (req.method === "GET") {
    const pack = await packOp(() => getPack(db(), language, id));
    if (!pack) return sendJson(res, 404, { error: `no pack "${id}"` });
    sendJson(res, 200, { pack } satisfies PackReply);
    return;
  }
  if (req.method === "PUT") {
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body)) throw new HttpError(400, "body must be a pack object");
    if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "a pack needs a title");
    const { pack } = await packOp(() => savePack(db(), language, id, body));
    sendJson(res, 200, { pack } satisfies PackWriteReply);
    return;
  }
  if (req.method === "DELETE") {
    if (!(await packOp(() => deletePack(db(), language, id)))) return sendJson(res, 404, { error: `no pack "${id}"` });
    sendJson(res, 200, { ok: true } satisfies PackDeleteReply);
    return;
  }
  methodNotAllowed(res, "GET, PUT, DELETE");
}

export async function handleFolders(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  learnerMode(req, ctx);
  const language = ctx.language;
  const name = subPath(req);
  if (!name) {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const body = await readJsonBody<unknown>(req);
    if (!isObject(body) || typeof body.name !== "string") throw new HttpError(400, "body must be {name}");
    const folder = body.name;
    const folders = await packOp(() => createFolder(db(), language, folder)); // a bad name → 400, a taken one → 409
    sendJson(res, 200, { folder, folders } satisfies FolderReply);
    return;
  }
  if (req.method !== "DELETE") return methodNotAllowed(res, "DELETE");
  if (!(await packOp(() => deleteFolder(db(), language, name)))) return sendJson(res, 404, { error: `no folder "${name}"` });
  const { folders } = await listPacks(db(), language);
  sendJson(res, 200, { ok: true, folders } satisfies FolderDeleteReply);
}

/** The undo surface: a pack's revisions and the deleted packs (paged), a
 *  revision's content restored onto its live pack, and a deleted pack
 *  undeleted. Restore and undelete are separate actions, so a stale click
 *  (the pack came back meanwhile) is a 409, never a silent content change. */
export async function handlePackRevisions(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  learnerMode(req, ctx);
  const language = ctx.language;
  const seg = subPath(req);
  if (!seg) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const id = q.get("id") ?? undefined;
    const revision = q.get("revision") ?? undefined;
    if (!id === !revision) throw new HttpError(400, "name the pack: ?id=<pack id> or ?revision=<revision id>");
    const page = await packOp(() => listRevisions(db(), language, { id, revision }, { offset: q.get("offset") ?? undefined }));
    sendJson(res, 200, { revisions: page.items, next: page.next } satisfies PackRevisionsReply);
    return;
  }
  if (seg === "deleted") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const offset = new URL(req.url ?? "/", "http://localhost").searchParams.get("offset") ?? undefined;
    const page = await packOp(() => listDeleted(db(), language, { offset }));
    sendJson(res, 200, { packs: page.items, next: page.next } satisfies DeletedPacksReply);
    return;
  }
  const m = /^([^/]+)\/(restore|undelete)$/.exec(seg);
  if (!m) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const pack = await packOp(() => (m[2] === "undelete" ? undeletePack : restoreRevision)(db(), language, m[1]));
  sendJson(res, 200, { pack } satisfies PackRestoreReply);
}

export async function handleAssemble(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const mode = learnerMode(req, ctx);
  const body = await readJsonBody<Partial<AssembleRequest>>(req);
  if (!isObject(body) || !isObject(body.pack)) throw new HttpError(400, "body must be {pack}");
  // The review block as a session started now would have it (the Go
  // tab's preview, Copy), and its phrases for the "revisiting" line.
  const content = learnerContent(mode, ctx);
  const review = await reviewFor(ctx.language, content, body.pack, mode);
  sendJson(res, 200, { ...assemble(content, body.pack, { mode, review: review.items }), review } satisfies AssembleResult);
}

export async function handleExport(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const mode = learnerMode(req, ctx);
  const body = await readJsonBody<Partial<ExportRequest>>(req);
  if (!isObject(body) || !isObject(body.pack)) throw new HttpError(400, "body must be {pack, id}");
  const id = checkId(body.id);
  const content = learnerContent(mode, ctx);
  const review = await reviewFor(ctx.language, content, body.pack, mode);
  const { markdown, stats, warnings } = assemble(content, body.pack, { mode, review: review.items });
  const path = writeExport(id, markdown, exportsDirFor(mode));
  sendJson(res, 200, { path, stats, warnings } satisfies ExportResult);
}
