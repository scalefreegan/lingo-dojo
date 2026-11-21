import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listLearners } from "../../scripts/db/accounts.ts";
import {
  addCustomStockConcept, customStockConcepts, deleteCustomStockConcept, stockCallDone, stockCallStarted, stockCallsSince, type CustomConcept,
} from "../../scripts/db/pictureStock.ts";
import { drawStockPicture, listStock } from "../../scripts/picture-stock.mjs";
import { deleteStockPicture, readStockPicture, stockPicture } from "../../scripts/picture-store.mjs";
import { PICTURE_DAILY_STOCK, PICTURE_THEME, STOCK_ID_RE, readNewConcept } from "../../scripts/pictures.mjs";
import type { StockChangeReply, StockConceptView, StockListReply } from "../shared/game.ts";
import type { Ctx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { BFL_CREDITS_PER_IMAGE, ImageRefused, bflProvider, imageProvider, type ImageProvider } from "./imageProvider.ts";
import { BackgroundBusy, backgroundSlotWhenFree, type SlotWait } from "./paid.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The shared stock pictures from the picture library page (docs/DATA.md
// §Stock pictures, bead ld-318): everyone browses the whole set; only an
// admin adds a concept, deletes one it added, or draws, redraws or draws
// every missing picture.
//
//   GET  /api/stock-pictures                       the set, with each picture's state (starts nothing)
//   GET  /api/stock-pictures/file/:id/:version     a stock picture (any logged-in user)
//   POST /api/stock-pictures/admin/concepts        {name, category, description, words}: a new concept (in the database)
//   POST /api/stock-pictures/admin/missing         {count}: draw every concept with no picture yet
//   POST /api/stock-pictures/admin/:id/draw        draw one (again, if it has a picture)
//   POST /api/stock-pictures/admin/:id/remove      delete a concept added from the page, and its picture
//
// The first two are mounted with wrap's default "user" (the shared set is
// nobody's: no learner check); the rest with "admin", so a non-admin gets
// 403 on every stock write before anything is read. The routes never write
// content/: content/pictures.yaml is the content agent's, and a concept
// added here lives in picture_stock_concepts, merged with the file's
// wherever the list is read (pictures.mjs mergeStock). A file concept can't
// be deleted here (a 409), only drawn again.
//
// Drawing: an admin's draw is queued, and one install-wide run draws the
// queue a picture at a time, each in the asking admin's background paid
// slot (paid.ts, the same as word pictures and cloze writing; waited for
// like theirs), with Black Forest Labs (the theme's own provider, like the
// CLI; the stub when LINGO_IMAGE_PROVIDER=stub). Each draw is entered in
// picture_stock_calls as it starts, and at most PICTURE_DAILY_STOCK are
// started in any 24 hours, install-wide, counted from that ledger before
// the slot is waited for and again inside it. A refusal (moderation) skips
// that concept; any other failure, the cap or a busy slot stops the run
// and empties the queue (the page says why; pressing again carries on).
// The page's poll of GET /api/stock-pictures only reads.

const DAY_MS = 86_400_000;
const since = () => new Date(Date.now() - DAY_MS);
/** How long a stock draw waits for the admin's background slot. Mutable for the tests. */
export const STOCK_SLOT_WAIT: SlotWait = { maxMs: 120_000, everyMs: 2_000 };

/** The provider stock pictures are drawn with: the stub when the stub is
 *  asked for (a scratch server, the tests), else Black Forest Labs (the
 *  theme's own look and seed), never the OpenAI fallback. */
export function stockProvider(): ImageProvider {
  const p = imageProvider();
  return p.key === "stub" ? p : bflProvider();
}
const STOCK_KEY_PROBLEM = "Shared pictures are drawn with Black Forest Labs: add BFL_API_KEY to .env.local in the app's folder.";
const stockProblem = (): string | null => (stockProvider().problem() ? STOCK_KEY_PROBLEM : null);

/** The admin's own concepts from the database; never throws (a read that
 *  fails is the file's concepts alone, logged): a broken read is no reason
 *  to fail a word's picturable check. */
export async function customConcepts(): Promise<CustomConcept[]> {
  try {
    return await customStockConcepts(rawDb());
  } catch (e) {
    console.warn("[lingo-dojo] pictures: the added stock concepts couldn't be read:", String((e as Error)?.message || e));
    return [];
  }
}

/** The whole stock list (the file's and the database's) with each one's
 *  file in the current theme. */
export async function stockList() {
  return listStock({ custom: await customConcepts() });
}

/* ---------------------------------- the run --------------------------------- */

/** Concepts waiting to be drawn, in order, with who asked. */
const queue = new Map<string, { userId: string; redraw: boolean }>();
/** Concepts the provider refused since the server started. */
const refused = new Set<string>();
let running: Promise<void> | null = null;
let stopped: string | null = null;

/** Resolves when the stock run (if any) has finished (the tests). */
export async function settleStockDraws(): Promise<void> {
  while (running) await running.catch(() => {});
}

/** Forget the queue's memory (the tests: a restart). */
export function resetStockMemory(): void {
  queue.clear();
  refused.clear();
  stopped = null;
}

function stopRun(why: string): void {
  stopped = why;
  queue.clear();
}

/** Put concepts in the queue and start the run if none is going. */
function enqueue(ids: string[], userId: string, redraw: boolean): number {
  let n = 0;
  for (const id of ids) {
    if (queue.has(id)) continue;
    queue.set(id, { userId, redraw });
    refused.delete(id);
    n++;
  }
  if (n) stopped = null;
  if (n && !running) {
    running = drain()
      .catch((e) => {
        stopRun(`Drawing stopped: ${String((e as Error)?.message || e)}`);
        console.error("[lingo-dojo] stock pictures: drawing stopped:", String((e as Error)?.message || e));
      })
      .finally(() => {
        running = null;
      });
  }
  return n;
}

/** Told apart from a draw's own result: the cap was reached while it waited. */
const CAPPED = Symbol("capped");

async function drain(): Promise<void> {
  const provider = stockProvider();
  for (;;) {
    const next = queue.entries().next();
    if (next.done) return;
    const [id, ask] = next.value;
    // Read again each time: a concept deleted meanwhile is skipped, and a
    // file drawn meanwhile (the CLI) isn't drawn twice unless redrawn.
    const concept = (await stockList()).find((c) => c.id === id);
    if (!concept || (!ask.redraw && concept.drawn)) {
      queue.delete(id);
      continue;
    }
    if (provider.problem()) return stopRun(STOCK_KEY_PROBLEM);
    if ((await stockCallsSince(rawDb(), since())) >= PICTURE_DAILY_STOCK) return stopRun(capSentence());
    let callId = "";
    try {
      const out = await backgroundSlotWhenFree(ask.userId, async () => {
        // Counted again here: the wait for the slot may have been long.
        if ((await stockCallsSince(rawDb(), since())) >= PICTURE_DAILY_STOCK) return CAPPED;
        // In the ledger before the provider is asked: a call that then
        // fails was (or may have been) paid all the same.
        callId = await stockCallStarted(rawDb(), ask.userId, id, since());
        return drawStockPicture(concept, provider, { theme: PICTURE_THEME });
      }, STOCK_SLOT_WAIT);
      if (out === CAPPED) return stopRun(capSentence());
      await stockCallDone(rawDb(), callId, "ok").catch(() => {});
      console.log(`[lingo-dojo] stock pictures: drew ${id}${out.credits != null ? ` (${out.credits} credits)` : ""}`);
      queue.delete(id);
    } catch (e) {
      if (e instanceof BackgroundBusy) return stopRun("Another background task (word pictures or practice sentences) kept the slot busy; press again in a moment.");
      if (e instanceof ImageRefused) {
        await stockCallDone(rawDb(), callId, "refused").catch(() => {});
        refused.add(id);
        queue.delete(id);
        console.warn(`[lingo-dojo] stock pictures: ${provider.name} refused ${id}; skipped`);
        continue;
      }
      if (callId) await stockCallDone(rawDb(), callId, "failed").catch(() => {});
      throw e;
    }
  }
}

const capSentence = () => `Today's ${PICTURE_DAILY_STOCK} shared pictures are drawn; more can be drawn tomorrow.`;

/* --------------------------------- the routes -------------------------------- */

/** A stock file's version: its type and modification time, so a redraw
 *  (same name, new bytes) is a new URL. */
function versionOf(id: string): string | null {
  const at = stockPicture(PICTURE_THEME.id, id);
  if (!at) return null;
  try {
    const st = fs.statSync(at.path);
    return `${at.type.split("/")[1]}-${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
  } catch {
    return null;
  }
}

async function listReply(ctx: Ctx): Promise<StockListReply> {
  const list = await stockList();
  const concepts: StockConceptView[] = list.map((c) => ({
    id: c.id, category: c.category, description: c.description, words: c.words, custom: c.custom,
    version: c.drawn ? versionOf(c.id) : null, queued: queue.has(c.id), refused: refused.has(c.id),
  }));
  return {
    theme: PICTURE_THEME.id,
    concepts,
    canEdit: !!ctx.user.isAdmin,
    drawing: !!running,
    usedToday: await stockCallsSince(rawDb(), since()),
    cap: PICTURE_DAILY_STOCK,
    costEach: BFL_CREDITS_PER_IMAGE / 100,
    problem: stockProblem(),
    stopped,
  };
}

/** /api/stock-pictures (wrap's "user"): browse the set, fetch a picture. */
export async function handleStock(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return sendJson(res, 200, (await listReply(ctx)) satisfies StockListReply);
  }
  if (parts.length === 3 && parts[0] === "file") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const [, id, version] = parts;
    if (!STOCK_ID_RE.test(id) || versionOf(id) !== version) throw new HttpError(404, "no such picture");
    const pic = readStockPicture(PICTURE_THEME.id, id);
    if (!pic) throw new HttpError(404, "no such picture");
    res.writeHead(200, {
      "Content-Type": pic.type,
      "Content-Length": pic.bytes.length,
      // The version is in the URL: a redraw is a new URL. Private: only a
      // logged-in user reads it, never a shared cache.
      "Cache-Control": "private, max-age=31536000, immutable",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(pic.bytes);
    return;
  }
  // Every write is under /admin (mounted as admin before this one).
  sendJson(res, 404, { error: "no such route" });
}

/** /api/stock-pictures/admin (wrap's "admin"): every stock write. */
export async function handleStockAdmin(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  if (parts.length === 1 && parts[0] === "concepts") {
    const body = await readJsonBody(req);
    const names = (await listLearners(rawDb(), ctx.user.id, { archived: true })).map((l) => l.name);
    const r = readNewConcept(body, await stockList(), names);
    if (r.error !== undefined) throw new HttpError(400, r.error);
    if (!(await addCustomStockConcept(rawDb(), r.concept, ctx.user.id))) throw new HttpError(409, `There is already a shared picture called "${r.concept.id}".`);
    // Drawn at once when it can be: adding one is asking for its picture.
    const queued = stockProblem() ? 0 : enqueue([r.concept.id], ctx.user.id, false);
    return sendJson(res, 201, { ...(await listReply(ctx)), queued } satisfies StockChangeReply);
  }
  if (parts.length === 1 && parts[0] === "missing") {
    const body = (await readJsonBody(req)) as { count?: unknown } | null;
    const problem = stockProblem();
    if (problem) throw new HttpError(400, problem);
    const missing = (await stockList()).filter((c) => !c.drawn && !queue.has(c.id)).map((c) => c.id);
    if (body?.count !== missing.length) throw new HttpError(409, `${missing.length} picture(s) are missing now, not ${String(body?.count)}; look again and confirm.`);
    const left = PICTURE_DAILY_STOCK - (await stockCallsSince(rawDb(), since()));
    if (left <= 0) throw new HttpError(429, capSentence());
    const queued = enqueue(missing.slice(0, left), ctx.user.id, false);
    return sendJson(res, 202, { ...(await listReply(ctx)), queued } satisfies StockChangeReply);
  }
  if (parts.length === 2 && (parts[1] === "draw" || parts[1] === "remove")) {
    const id = parts[0];
    const concept = STOCK_ID_RE.test(id) ? (await stockList()).find((c) => c.id === id) : undefined;
    if (!concept) throw new HttpError(404, "no such shared picture");
    if (parts[1] === "draw") {
      const problem = stockProblem();
      if (problem) throw new HttpError(400, problem);
      if ((await stockCallsSince(rawDb(), since())) >= PICTURE_DAILY_STOCK) throw new HttpError(429, capSentence());
      const queued = enqueue([id], ctx.user.id, true);
      return sendJson(res, 202, { ...(await listReply(ctx)), queued } satisfies StockChangeReply);
    }
    // Only a concept added from the page; the file's belong to the content
    // agent (a route never writes content/).
    if (!concept.custom) throw new HttpError(409, "This picture comes from the app's own list (content/pictures.yaml): it can be drawn again, not deleted.");
    if (!(await deleteCustomStockConcept(rawDb(), id))) throw new HttpError(404, "no such shared picture");
    queue.delete(id);
    // Its picture goes with it. Words that pointed at it leave the word
    // game until each is drawn again (picture-store.mjs: a stock file is
    // never a word's own).
    deleteStockPicture(PICTURE_THEME.id, id);
    return sendJson(res, 200, (await listReply(ctx)) satisfies StockChangeReply);
  }
  sendJson(res, 404, { error: "no such route" });
}
