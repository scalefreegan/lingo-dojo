import type { IncomingMessage, ServerResponse } from "node:http";
import { PhraseError, addPhrase, deletePhrase, findPhrase, getPhrase, listPhrases, updatePhrase } from "../../scripts/db/phrases.ts";
import { bankPage, readPhraseInput } from "../../scripts/phrases.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { PhraseInput, PhraseLookupReply, PhraseReply, PhrasesReply } from "../shared/wire.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The phrase bank's routes (docs/DATA.md §Phrase bank): the active
// learner's active language's bank, for the Library's Phrase bank view and
// the transcript's ☆ Star.
//
//   GET    /api/phrases            ?q=&show=&band=&sort=&offset=&limit= → {phrases, total, nextOffset, counts, language}
//   POST   /api/phrases            {text, meaning?, note?, starred?} → {phrase, created}  (201 new, 200 already there)
//   GET    /api/phrases/lookup     ?text= → {phrase | null}: the phrase with those words (the ☆'s state)
//   GET    /api/phrases/:id        → {phrase}: with its examples
//   PATCH  /api/phrases/:id        {text?, meaning?, note?, starred?, suspended?} → {phrase}
//   DELETE /api/phrases/:id        → {deleted: true}; its cards, reviews and examples go with it
//
// Mounted with wrap's `learner: true`: the page must name the session's
// learner and language (else 409 stale_learner), and every row is read and
// written through that language's scope (scripts/db/phrases.ts), so another
// language's phrase id, of the same learner or any other, is the same 404 as
// one that doesn't exist. What a voice turn's glosses and a scenario's lists
// add is written by the turn and the conversation start (conversations.ts),
// not here.

/** PhraseError codes → the status a client can act on. */
const STATUS_BY_CODE: Record<PhraseError["code"], number> = { EINVAL: 400, ENOENT: 404, EEXIST: 409 };

async function op<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PhraseError) throw new HttpError(STATUS_BY_CODE[e.code], e.message);
    throw e;
  }
}

function input(body: unknown, create: boolean): PhraseInput & { text?: string } {
  const r = readPhraseInput(body, { create });
  if (r.error !== undefined) throw new HttpError(400, r.error);
  return r.value;
}

/** The active language's locale (es-MX): what a phrase added here is
 *  marked as first met in. "" when the language has none. */
const localeOf = (ctx: LearnerCtx) => localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";

async function list(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const all = await listPhrases(rawDb(), ctx.language);
  const page = bankPage(all, {
    q: (q.get("q") ?? "").slice(0, 200),
    show: q.get("show") ?? "all",
    band: q.get("band") ?? "",
    sort: q.get("sort") ?? "recent",
    offset: Number(q.get("offset") ?? 0),
    limit: Number(q.get("limit") ?? 50),
  });
  sendJson(res, 200, {
    ...page,
    language: { targetLanguage: ctx.language.targetLanguage, targetVariant: ctx.language.targetVariant, locale: localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) },
  } satisfies PhrasesReply);
}

/** /api/phrases, mounted with wrap's `learner: true`. */
export async function handlePhrases(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length > 1) return sendJson(res, 404, { error: "no such route" });
  const [id] = parts;
  if (id === undefined) {
    if (req.method === "GET") return list(req, res, ctx);
    if (req.method === "POST") {
      const body = input(await readJsonBody(req), true);
      const out = await op(() => addPhrase(rawDb(), ctx.language, localeOf(ctx), { ...body, text: body.text! }));
      return sendJson(res, out.created ? 201 : 200, out satisfies PhraseReply);
    }
    return methodNotAllowed(res, "GET, POST");
  }
  if (id === "lookup") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const text = (new URL(req.url ?? "/", "http://localhost").searchParams.get("text") ?? "").slice(0, 400);
    return sendJson(res, 200, { phrase: await findPhrase(rawDb(), ctx.language, text) } satisfies PhraseLookupReply);
  }
  if (req.method === "GET") return sendJson(res, 200, { phrase: await op(() => getPhrase(rawDb(), ctx.language, id)) } satisfies PhraseReply);
  if (req.method === "PATCH") {
    const body = input(await readJsonBody(req), false);
    return sendJson(res, 200, { phrase: await op(() => updatePhrase(rawDb(), ctx.language, id, body)) } satisfies PhraseReply);
  }
  if (req.method === "DELETE") {
    await op(() => deletePhrase(rawDb(), ctx.language, id));
    return sendJson(res, 200, { deleted: true });
  }
  methodNotAllowed(res, "GET, PATCH, DELETE");
}
