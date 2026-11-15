import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_MODELS, failureHint, startClaude } from "../../scripts/claude.mjs";
import { MODES, REPO_ROOT, isMode } from "../../scripts/content.mjs";
import type { Ctx } from "./auth.ts";
import { contentReply } from "./content.ts";
import type {
  ChatCommit, ChatDone, ChatError, ChatHeartbeat, ChatHistoryReply, ChatMessage, ChatReply, ChatRequest, ChatStart,
  ContentReply, Mode, SettingsReply, SettingsRequest,
} from "../shared/wire.ts";
import { commitContent } from "./commit.ts";
import { HttpError, methodNotAllowed, openSse, readJsonBody, sendJson, subPath } from "./sse.ts";
import { appendHistory, clearHistory, getModel, readHistory, setModel } from "./store.ts";

// The embedded agent: a headless `claude -p` (scripts/claude.mjs) that may
// read the repo and write only under content/, run one turn per request.
//
//   POST   /api/chat            {message} → SSE: start, heartbeat…, message, commit, done
//                               (or error, done); 409 while a run is in progress
//   GET    /api/chat/history    {messages}
//   DELETE /api/chat/history    {ok}
//   GET    /api/settings        {model, models}
//   PUT    /api/settings        {model} → {model, models}
//
// Admins only (api.ts): the agent writes the library everyone shares. The
// transcript and the model are the admin's own (store.ts: agent_messages and
// user_settings), and the agent sees the active learner's profile.
//
// The CLI buffers the whole turn in --output-format json, so there is nothing
// to stream until it finishes: the heartbeats are what keep the connection
// (and the UI's elapsed counter) alive meanwhile. After the reply, the server
// commits any change under content/ and reports it as a `commit` event, so
// the UI can show the hash and reload the library.

const HEARTBEAT_MS = 4000;
/** Messages replayed into the prompt: ~20 exchanges. */
const HISTORY_WINDOW = 40;

/* ------------------------------ the prompts ------------------------------ */

/** Built per request from the library on disk, so the agent sees the slots
 *  and ids as they are now — including what it added last turn. */
export function systemPrompt(c: ContentReply): string {
  const slots = c.schema.slots.map((s) => `  - ${s.id} — "${s.title}" (pick ${s.pick}${s.required ? ", required" : ""})`).join("\n");
  const units = c.units.map((u) => `  - ${u.id} — slot ${u.slot} — "${u.title}"${u.default ? " (default)" : ""}`).join("\n");
  const scenarios = c.scenarios.map((s) => `  - ${s.id} — "${s.title}"`).join("\n");
  const profile = Object.entries(c.profile)
    .map(([k, v]) => `  - ${k}: ${typeof v === "string" ? v.trim().replace(/\s+/g, " ") : JSON.stringify(v)}`)
    .join("\n");
  // The tree the user is looking at; the listing below is that tree's.
  const tree = c.mode === "kids" ? "content/kids/" : "content/";
  const other = c.mode === "kids" ? "content/ (adult mode)" : "content/kids/ (kids mode)";
  return `You are the content editor for Lingo Dojo, a composable prompt-pack builder for language-practice sessions run elsewhere as a voice conversation with an AI "dojo master". You run headless inside the app; the user talks to you from a chat drawer and sees only your final reply.

The content library is the product. It lives under content/ in this repository (${REPO_ROOT}): markdown with YAML frontmatter, plus YAML. There are two libraries with the same file format: content/ is adult mode and content/kids/ is kids mode (sessions for a child who does not read yet), each with its own schema.yaml, frame.md, profile.yaml, units/, scenarios/ and packs/. The user is in ${c.mode} mode right now, looking at ${tree} — edit that tree unless they clearly ask about ${other}. Before you create or edit anything, read docs/CONTENT.md — it is the exact file-format contract, and the loader rejects files that break it. In short:
- ${tree}schema.yaml: the slots, in prompt order (id, title, pick: one|any, required, description).
- ${tree}units/<id>.md: one unit. Frontmatter: id (MUST equal the filename stem), slot (a slot id), title, summary, tags (list), default (true/false, preselected in a new pack), level (list of levels, optional: ${c.levels.join(", ")}). The body is instructions to the dojo master, in English, second person ("you"), self-contained — no references to other units. Placeholders {{learner_name}}, {{native_language}}, {{target_language}}, {{target_variant}}, {{level}}, {{scenario_title}} are substituted at assembly time.
- ${tree}scenarios/<id>.md: the setting and story. Frontmatter: id, title, summary (required); tags, language, collection, category, roles (mapping), beats (list), twists (list), vocab (list of {term, gloss}), phrases (list of English meanings) optional. The body is free prose for the dojo master. A scenario for one language and place (the Oaxaca trip) sets language and uses vocab; a generic one that works in any language omits language, lists phrases instead of vocab, and may use {{location}} in roles, twists and the body (never in title, summary or beats) so the session's Location — or a city the dojo master picks — sets the scene.
- ${tree}profile.yaml: only a seed for a fresh install and the offline export CLI; the app's learners live in its database, and the Profile below is the active learner's. ${tree}frame.md: the fixed preamble. ${tree}packs/*.yaml: saved packs — the app writes these; leave them alone unless asked.

The ${c.mode} library right now:
Slots:
${slots || "  (none)"}
Units (id — slot — title):
${units || "  (none)"}
Scenarios (id — title):
${scenarios || "  (none)"}
Profile:
${profile || "  (empty)"}

Rules:
- You may create or edit files only under content/. Your tools are already restricted to that: do not try to write anywhere else, run commands, or touch web/, scripts/, docs/ or anything outside content/. If the user asks for that, say you can't and why.
- Keep ids kebab-case, unique, and equal to the filename stem. A new unit goes in an existing slot unless the user asks for a new slot (then add the slot to schema.yaml as well).
- Match the voice and length of the existing units; read one or two neighbours first.
- Do not run git; the app commits your changes after each turn.
- Reply briefly, in plain prose, no headings. End your reply with ONE final line that says what you changed, starting with a verb, e.g. "Added unit warmup-greetings (warmup slot)." or "Edited correct-gently: softened the tone." If you changed nothing, the final line is exactly "No files changed."`;
}

/** The transcript replayed as the prompt, wine-guide style. Commit lines go
 *  in as system notes, so the agent knows its last edit landed. */
export function historyPrompt(prior: ChatMessage[], message: string): string {
  const render = (m: ChatMessage) =>
    m.role === "commit" ? `[SYSTEM]\nCommitted ${m.text}` : `[${m.role.toUpperCase()}]\n${m.text}`;
  const transcript = prior.length ? `Conversation so far:\n\n${prior.map(render).join("\n\n")}\n\n---\n\n` : "";
  return `${transcript}[USER]\n${message}\n\n[ASSISTANT]\nRespond to the latest user message. Today is ${new Date().toISOString().slice(0, 10)}.`;
}

/* -------------------------------- the run -------------------------------- */

// One agent at a time: two runs editing content/ concurrently would race
// each other's commits. It is one flag for every admin, not one per user,
// for the same reason: there is one content/.
let running = false;

async function handleChatPost(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readJsonBody<Partial<ChatRequest>>(req);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "message is required");
  if (message.length > 20_000) throw new HttpError(413, "message too long");
  const mode: Mode = body?.mode == null ? "adult" : (body.mode as Mode);
  if (!isMode(mode)) throw new HttpError(400, `unknown mode ${JSON.stringify(body?.mode)} (one of ${MODES.join(", ")})`);
  // Checked and set synchronously after the one await above, so two bodies
  // arriving together cannot both pass.
  if (running) throw new HttpError(409, "the agent is already working on a message; wait for it to finish");
  running = true;

  const send = openSse(res);
  const now = () => new Date().toISOString();
  // Cancellation listens on `res`, not `req`: readJsonBody consumed the
  // request body, which destroys the IncomingMessage — a `close` listener on
  // it never fires, so a req-based kill would leak the process group.
  const ctrl = new AbortController();
  const onClose = () => ctrl.abort();
  res.on("close", onClose);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    send("heartbeat", { elapsed: Math.round((Date.now() - startedAt) / 1000) } satisfies ChatHeartbeat);
  }, HEARTBEAT_MS);

  // Everything after openSse() stays inside the try: headers are out, so an
  // exception here can only be reported as an SSE error, never as a status.
  try {
    const prior = await readHistory(ctx.user.id, HISTORY_WINDOW);
    const model = await getModel(ctx.user.id);
    const system = systemPrompt(contentReply(mode, ctx.learner));
    await appendHistory(ctx.user.id, { role: "user", text: message, ts: now() });
    send("start", { model } satisfies ChatStart);

    const { result } = startClaude({
      prompt: historyPrompt(prior, message),
      systemPrompt: system,
      model,
      cwd: REPO_ROOT,
      signal: ctrl.signal,
    });
    const run = await result;
    const text = run.text.trim();
    const reply: ChatMessage = { role: "assistant", text, ts: now() };
    await appendHistory(ctx.user.id, reply);
    send("message", { ...reply, role: "assistant", costUsd: run.costUsd, numTurns: run.numTurns, denied: run.permissionDenials.length } satisfies ChatReply);
    if (run.permissionDenials.length) {
      console.warn(`[lingo-dojo] agent: ${run.permissionDenials.length} tool call(s) denied by the sandbox`, run.permissionDenials);
    }

    const commit: ChatCommit = await commitContent(text);
    if ("hash" in commit) await appendHistory(ctx.user.id, { role: "commit", text: `${commit.hash}: ${commit.summary}`, ts: now() });
    else if ("error" in commit) console.error(`[lingo-dojo] agent: commit failed: ${commit.error}`);
    send("commit", commit);
    send("done", { ok: true } satisfies ChatDone);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    send("error", { error: failureHint(msg) || msg } satisfies ChatError);
    send("done", { ok: false } satisfies ChatDone);
  } finally {
    running = false;
    clearInterval(heartbeat);
    res.off("close", onClose);
    res.end();
  }
}

/* -------------------------------- routes --------------------------------- */

export async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const seg = subPath(req);
  if (!seg) {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return handleChatPost(req, res, ctx);
  }
  if (seg === "history") {
    if (req.method === "GET") return sendJson(res, 200, { messages: await readHistory(ctx.user.id) } satisfies ChatHistoryReply);
    if (req.method === "DELETE") {
      if (running) throw new HttpError(409, "the agent is working; clear the history when it finishes");
      await clearHistory(ctx.user.id);
      return sendJson(res, 200, { ok: true });
    }
    return methodNotAllowed(res, "GET, DELETE");
  }
  sendJson(res, 404, { error: "no such route" });
}

export async function handleSettings(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  const reply = async (): Promise<SettingsReply> => ({ model: await getModel(ctx.user.id), models: AGENT_MODELS });
  if (req.method === "GET") return sendJson(res, 200, await reply());
  if (req.method === "PUT") {
    const body = await readJsonBody<Partial<SettingsRequest>>(req);
    const model = body?.model;
    if (typeof model !== "string" || !AGENT_MODELS.some((m) => m.id === model)) {
      throw new HttpError(400, `model must be one of ${AGENT_MODELS.map((m) => m.id).join(", ")}`);
    }
    await setModel(ctx.user.id, model);
    return sendJson(res, 200, await reply());
  }
  methodNotAllowed(res, "GET, PUT");
}
