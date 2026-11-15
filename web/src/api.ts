/* Typed fetch layer (Atlas pattern). Every call goes to the same-origin Vite
 * middleware in server/ (which enforces the same-origin check in its own
 * wrap()). This is the only file in src/ that knows URL shapes — components
 * import a named function per endpoint, never req() itself.
 *
 * Every content, pack, folder, assemble, export and profile call names the
 * mode it works in ("adult" → content/, "kids" → content/kids/); the server
 * keeps the two trees apart, and so does the URL. The mode is the active
 * learner's: the server answers 400 if the URL names the other one. Every
 * call also names the learner and the language this page shows
 * (X-Learner-Id and X-Language-Profile-Id, set in send() below); a
 * learner-scoped route answers 409 `stale_learner` when either is not the
 * session's active one, so a stale tab can't write another learner's (or
 * another language's) profile, packs or conversations, or run a turn as
 * them. */

import type {
  AssembleResult, ChatCommit, ChatDone, ChatError, ChatHeartbeat, ChatHistoryReply, ChatReply, ChatRequest, ChatStart,
  ContentReply, ConversationCreateRequest, ConversationReply, ConversationTurnsReply, ConversationsReply, ErrorCode, ErrorReply, ExportRequest, ExportResult, FolderDeleteReply, LanguageHeader, LanguageReply, LanguageRequest, LanguagesReply, LearnerHeader, FolderReply, FolderRequest, LearnerReply, LearnerRequest, LoginRequest, MeReply, Mode,
  DeletedPacksReply, PackDeleteReply, PackInput, PackRestoreReply, PackRevisionsReply, PickLanguageRequest, PickLearnerRequest,
  PackMoveRequest, PackRenameRequest, PackWriteReply, PacksReply, ProfileReply, ProfileRequest, SettingsReply, SettingsRequest,
  VoiceCastReply, VoiceCastRequest, PhraseInput, PhraseLookupReply, PhraseReply, PhraseShow, PhraseSort, PhrasesReply, MasteryBand,
  LibraryAddReply, LibraryAddRequest, LibraryReply, LibrarySort, TranscribeReply, TtsProvider, VoiceSettingsReply, VoiceSettingsRequest, VoiceSpeakRequest, VoiceTurnReply, VoiceTurnRequest, VoicesReply,
} from "./types";

/** A non-2xx reply; `message` is the server's `{error}` sentence, and
 *  `code` the reason beside it for the few errors the client acts on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: ErrorCode;
  constructor(message: string, status: number, code?: ErrorCode) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (code) this.code = code;
  }
}

/** Fired on window when any call answers 401: the session ended (logged out
 *  in another tab, expired, password changed). The auth gate listens and
 *  goes back to the login screen instead of every caller handling it. */
export const UNAUTHORIZED_EVENT = "lingo-dojo:unauthorized";

/** Fired on window when a call answers 409 `stale_learner`: this page shows
 *  a learner or language that is no longer the session's (another tab
 *  picked someone else, switched language or archived this one, or another
 *  account logged in). The auth gate
 *  re-reads /api/auth/me and shows the right learner or the picker. Any
 *  other 409 (the voice-turn lock, a folder that isn't empty) stays an
 *  ordinary error for its caller. */
export const STALE_LEARNER_EVENT = "lingo-dojo:stale-learner";

const LEARNER_HEADER: LearnerHeader = "X-Learner-Id";
const LANGUAGE_HEADER: LanguageHeader = "X-Language-Profile-Id";
const STALE_LEARNER: ErrorCode = "stale_learner";

/** What this page renders: a learner and the language it is practising. */
export interface PageLearner {
  learnerId: string;
  languageId: string;
}

/** The learner and language this page renders, sent with every call
 *  (X-Learner-Id, X-Language-Profile-Id) so the server can refuse a
 *  learner-scoped call from a page that is out of date: the session cookie
 *  is shared by every tab, so the server can't tell otherwise. Set by the
 *  auth gate whenever what it shows changes. */
let pageLearner: PageLearner | null = null;

export function setPageLearner(page: PageLearner | null): void {
  pageLearner = page;
}

/** The learner and language this page renders now (null before one is picked). */
export function getPageLearner(): PageLearner | null {
  return pageLearner;
}

/** Work to finish while the page still shows its learner and language, run
 *  by the auth gate before it switches learner or language: the open voice
 *  session's End, which the server refuses (stale_learner) once the session
 *  has moved on. Each returns a promise the switch waits for, up to
 *  BEFORE_SWITCH_MS, so a slow network delays a switch by at most that. */
const beforeSwitch = new Set<() => Promise<void>>();
const BEFORE_SWITCH_MS = 1500;

/** Register `fn` to run before a switch; returns the unregister. */
export function onBeforeSwitch(fn: () => Promise<void>): () => void {
  beforeSwitch.add(fn);
  return () => {
    beforeSwitch.delete(fn);
  };
}

/** Run every registered before-switch step and wait for them, at most
 *  BEFORE_SWITCH_MS; a step that fails doesn't stop the switch. */
export async function settleBeforeSwitch(): Promise<void> {
  const steps = [...beforeSwitch].map((fn) => fn().catch(() => undefined));
  if (!steps.length) return;
  let timer: number | undefined;
  await Promise.race([Promise.all(steps), new Promise<void>((resolve) => (timer = window.setTimeout(resolve, BEFORE_SWITCH_MS)))]);
  window.clearTimeout(timer);
}

/** The two headers naming a page's learner and language. */
function pageHeaders(page: PageLearner): Record<string, string> {
  return { [LEARNER_HEADER]: page.learnerId, [LANGUAGE_HEADER]: page.languageId };
}

/** fetch with the page's learner and language. Every call below goes through it. */
function send(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (pageLearner) for (const [k, v] of Object.entries(pageHeaders(pageLearner))) headers.set(k, v);
  return fetch(url, { ...init, headers });
}

function check401(res: Response): void {
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await send(url, init);
  check401(res);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const reply = body && typeof body === "object" ? (body as Partial<ErrorReply>) : null;
    if (res.status === 409 && reply?.code === STALE_LEARNER) window.dispatchEvent(new Event(STALE_LEARNER_EVENT));
    const err = reply?.error;
    throw new ApiError(typeof err === "string" ? err : text.slice(0, 200) || `${res.status} ${res.statusText}`, res.status, reply?.code);
  }
  return body as T;
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** `<path>?mode=<mode>` — every tree-scoped route. */
function inMode(path: string, mode: Mode): string {
  return `${path}?mode=${encodeURIComponent(mode)}`;
}

/* ---------------------------------- auth --------------------------------- */
// The session is an httpOnly cookie: the browser sends it, scripts never see
// it. These calls only learn who is logged in and change that.

/** GET /api/auth/me — who is logged in (or that no account exists yet). */
export function getMe(): Promise<MeReply> {
  return req<MeReply>("/api/auth/me");
}

/** POST /api/auth/login — sets the session cookie. A wrong password is not
 *  a lost session, so this skips the 401 event. */
export async function login(username: string, password: string): Promise<MeReply> {
  const res = await send("/api/auth/login", json({ username, password } satisfies LoginRequest));
  const body = (await res.json().catch(() => null)) as (MeReply & { error?: string }) | null;
  if (!res.ok) throw new ApiError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
  return body as MeReply;
}

/** POST /api/auth/first-run — the first account (an admin), only while there are none. */
export function createFirstAccount(username: string, password: string): Promise<MeReply> {
  return req<MeReply>("/api/auth/first-run", json({ username, password } satisfies LoginRequest));
}

export function logout(): Promise<{ ok: true }> {
  return req<{ ok: true }>("/api/auth/logout", json({}));
}

/** PUT /api/auth/learner — who's practising in this session (null: back to the picker). */
export function pickLearner(learnerId: string | null): Promise<MeReply> {
  return req<MeReply>("/api/auth/learner", json({ learnerId } satisfies PickLearnerRequest, "PUT"));
}

export function createLearner(body: LearnerRequest): Promise<LearnerReply> {
  return req<LearnerReply>("/api/learners", json(body));
}

export function updateLearner(id: string, body: LearnerRequest): Promise<LearnerReply> {
  return req<LearnerReply>(`/api/learners/${encodeURIComponent(id)}`, json(body, "PATCH"));
}

export function archiveLearner(id: string): Promise<LearnerReply> {
  return req<LearnerReply>(`/api/learners/${encodeURIComponent(id)}/archive`, json({}));
}

/** PUT /api/auth/language — which of the active learner's languages this session practises. */
export function pickLanguage(languageId: string): Promise<MeReply> {
  return req<MeReply>("/api/auth/language", json({ languageId } satisfies PickLanguageRequest, "PUT"));
}

const languagesUrl = (learnerId: string, languageId = "", action = "") =>
  `/api/learners/${encodeURIComponent(learnerId)}/languages${languageId ? `/${encodeURIComponent(languageId)}` : ""}${action}`;

/** A learner's languages (not archived). */
export function listLanguages(learnerId: string): Promise<LanguagesReply> {
  return req<LanguagesReply>(languagesUrl(learnerId));
}

export function createLanguage(learnerId: string, body: LanguageRequest): Promise<LanguageReply> {
  return req<LanguageReply>(languagesUrl(learnerId), json(body));
}

export function updateLanguage(learnerId: string, languageId: string, body: LanguageRequest): Promise<LanguageReply> {
  return req<LanguageReply>(languagesUrl(learnerId, languageId), json(body, "PATCH"));
}

/** Archive one of a learner's languages: a 409 for its last one. */
export function archiveLanguage(learnerId: string, languageId: string): Promise<LanguageReply> {
  return req<LanguageReply>(languagesUrl(learnerId, languageId, "/archive"), json({}));
}

/* --------------------------------- content -------------------------------- */

/** GET /api/content — re-read from disk on every call. */
export function getContent(mode: Mode): Promise<ContentReply> {
  return req<ContentReply>(inMode("/api/content", mode));
}

/** PUT /api/profile — merges the picker keys into the active learner and its active language. */
export function saveProfile(mode: Mode, patch: ProfileRequest): Promise<ProfileReply> {
  return req<ProfileReply>(inMode("/api/profile", mode), json(patch, "PUT"));
}

/* --------------------------------- packs --------------------------------- */

/** A pack id in a URL: each segment encoded on its own, so the one slash of
 *  a folder id stays a path separator. */
function packUrl(id: string, mode: Mode, action = ""): string {
  return inMode(`/api/packs/${id.split("/").map(encodeURIComponent).join("/")}${action}`, mode);
}

/** GET /api/packs — the active learner's saved packs and folders. */
export function listPacks(mode: Mode): Promise<PacksReply> {
  return req<PacksReply>(inMode("/api/packs", mode));
}

/** PUT /api/packs/:id — creates or replaces the pack at that id. Every
 *  write below answers with the pack as stored, and records a revision. */
export function savePack(mode: Mode, id: string, pack: PackInput): Promise<PackWriteReply> {
  return req<PackWriteReply>(packUrl(id, mode), json(pack, "PUT"));
}

export function deletePack(mode: Mode, id: string): Promise<PackDeleteReply> {
  return req<PackDeleteReply>(packUrl(id, mode), { method: "DELETE" });
}

/** POST /api/packs/:id/move — "" for the top level; the reply's pack.id is the new id. */
export function movePack(mode: Mode, id: string, folder: string): Promise<PackWriteReply> {
  return req<PackWriteReply>(packUrl(id, mode, "/move"), json({ folder } satisfies PackMoveRequest));
}

/** POST /api/packs/:id/rename — new title, and an id renamed to match. */
export function renamePack(mode: Mode, id: string, title: string): Promise<PackWriteReply> {
  return req<PackWriteReply>(packUrl(id, mode, "/rename"), json({ title } satisfies PackRenameRequest));
}

/** GET /api/pack-revisions?id= — a saved pack's revisions, newest first, a page at a time. */
export function listPackRevisions(mode: Mode, id: string, offset = 0): Promise<PackRevisionsReply> {
  return req<PackRevisionsReply>(`${inMode("/api/pack-revisions", mode)}&id=${encodeURIComponent(id)}&offset=${offset}`);
}

/** GET /api/pack-revisions/deleted — the soft-deleted packs, newest first, a page at a time. */
export function listDeletedPacks(mode: Mode, offset = 0): Promise<DeletedPacksReply> {
  return req<DeletedPacksReply>(`${inMode("/api/pack-revisions/deleted", mode)}&offset=${offset}`);
}

/** POST /api/pack-revisions/:revision/restore — a live pack takes that revision's content. */
export function restorePackRevision(mode: Mode, revision: string): Promise<PackRestoreReply> {
  return req<PackRestoreReply>(inMode(`/api/pack-revisions/${encodeURIComponent(revision)}/restore`, mode), { method: "POST" });
}

/** POST /api/pack-revisions/:revision/undelete — the deleted pack comes back
 *  (409 when it already has, or its id was taken). */
export function undeletePack(mode: Mode, revision: string): Promise<PackRestoreReply> {
  return req<PackRestoreReply>(inMode(`/api/pack-revisions/${encodeURIComponent(revision)}/undelete`, mode), { method: "POST" });
}

export function createFolder(mode: Mode, name: string): Promise<FolderReply> {
  return req<FolderReply>(inMode("/api/folders", mode), json({ name } satisfies FolderRequest));
}

/** DELETE /api/folders/:name — refused (409) unless the folder is empty. */
export function deleteFolder(mode: Mode, name: string): Promise<FolderDeleteReply> {
  return req<FolderDeleteReply>(inMode(`/api/folders/${encodeURIComponent(name)}`, mode), { method: "DELETE" });
}

export function assemblePack(mode: Mode, pack: PackInput, signal?: AbortSignal): Promise<AssembleResult> {
  return req<AssembleResult>(inMode("/api/assemble", mode), { ...json({ pack }), signal });
}

export function exportPack(mode: Mode, id: string, pack: PackInput): Promise<ExportResult> {
  return req<ExportResult>(inMode("/api/export", mode), json({ id, pack } satisfies ExportRequest));
}

/* --------------------------------- chat ---------------------------------- */

/** Handlers for the SSE events POST /api/chat emits (shapes in wire.ts). */
export interface ChatHandlers {
  start?: (d: ChatStart) => void;
  heartbeat?: (d: ChatHeartbeat) => void;
  message?: (d: ChatReply) => void;
  commit?: (d: ChatCommit) => void;
  error?: (d: ChatError) => void;
  done?: (d: ChatDone) => void;
}

/** EventSource can't POST, so the stream is parsed by hand (wine-guide
 *  pattern). Resolves when the server's terminal `done` arrives; a stream
 *  that ends without one is an error, not a quiet success. */
async function ssePost(url: string, body: unknown, handlers: ChatHandlers, signal?: AbortSignal): Promise<void> {
  const res = await send(url, { ...json(body), signal });
  check401(res);
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawDone = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      if (event === "done") sawDone = true;
      try {
        const parsed: unknown = JSON.parse(data);
        (handlers as Record<string, ((d: unknown) => void) | undefined>)[event]?.(parsed);
      } catch {
        /* malformed frame */
      }
    }
  }
  if (!sawDone) throw new Error("stream ended unexpectedly — the server may have restarted; try again");
}

/** The agent is told which library the user is looking at. */
export function sendChat(mode: Mode, message: string, handlers: ChatHandlers, signal?: AbortSignal): Promise<void> {
  return ssePost("/api/chat", { message, mode } satisfies ChatRequest, handlers, signal);
}

export function getChatHistory(): Promise<ChatHistoryReply> {
  return req<ChatHistoryReply>("/api/chat/history");
}

export function clearChatHistory(): Promise<{ ok: true }> {
  return req<{ ok: true }>("/api/chat/history", { method: "DELETE" });
}

export function getSettings(): Promise<SettingsReply> {
  return req<SettingsReply>("/api/settings");
}

export function setModel(model: string): Promise<SettingsReply> {
  return req<SettingsReply>("/api/settings", json({ model } satisfies SettingsRequest, "PUT"));
}

/* --------------------------------- voice --------------------------------- */

/** The session languages, so the reply carries their locales. */
export interface VoiceLanguages {
  target: string;
  variant: string;
  native: string;
}

function voiceSettingsUrl(langs?: VoiceLanguages): string {
  if (!langs) return "/api/voice/settings";
  const q = new URLSearchParams({ target: langs.target, variant: langs.variant, native: langs.native });
  return `/api/voice/settings?${q}`;
}

/** This session's voices, drawn fresh: Random slots get a new voice each time. */
export function getCast(body: VoiceCastRequest, signal?: AbortSignal): Promise<VoiceCastReply> {
  return req<VoiceCastReply>("/api/voice/cast", { ...json(body), signal });
}

export function getVoiceSettings(langs?: VoiceLanguages): Promise<VoiceSettingsReply> {
  return req<VoiceSettingsReply>(voiceSettingsUrl(langs));
}

/** Merges into this user's voice settings; `voices` replaces the whole map. */
export function saveVoiceSettings(patch: VoiceSettingsRequest, langs?: VoiceLanguages): Promise<VoiceSettingsReply> {
  return req<VoiceSettingsReply>(voiceSettingsUrl(langs), json(patch, "PUT"));
}

export function listVoices(provider: TtsProvider, locale: string, signal?: AbortSignal): Promise<VoicesReply> {
  const q = new URLSearchParams({ provider, locale });
  return req<VoicesReply>(`/api/voice/voices?${q}`, { signal });
}

/** A WAV recording → what the learner said. `locales` are candidates (Azure
 *  uses them; ElevenLabs detects the language itself). */
/** `locales[0]` is the target language the speech is taken to be in;
 *  `terms` are target phrases to expect (the server trims them to keyterms). */
export function transcribe(audio: Blob, locales: string[], signal?: AbortSignal, terms: string[] = []): Promise<TranscribeReply> {
  const q = new URLSearchParams({ locales: locales.join(",") });
  for (const t of terms) q.append("term", t);
  return req<TranscribeReply>(`/api/voice/transcribe?${q}`, { method: "POST", headers: { "Content-Type": audio.type || "audio/wav" }, body: audio, signal });
}

export function voiceTurn(body: VoiceTurnRequest, signal?: AbortSignal): Promise<VoiceTurnReply> {
  return req<VoiceTurnReply>("/api/voice/turn", { ...json(body), signal });
}

/* -------------------------------- phrase bank ------------------------------- */
// The active language's phrase bank (Library → Phrase bank, and the
// transcript's ☆ Star).

export interface PhraseQuery {
  q?: string;
  show?: PhraseShow;
  band?: MasteryBand | "";
  sort?: PhraseSort;
  offset?: number;
  limit?: number;
}

/** GET /api/phrases: one page of the bank, searched, filtered and sorted. */
export function listPhrases(query: PhraseQuery = {}, signal?: AbortSignal): Promise<PhrasesReply> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, String(v));
  return req<PhrasesReply>(`/api/phrases?${q}`, { signal });
}

/** POST /api/phrases: add words, or star them when they are already there. */
export function addPhrase(body: PhraseInput & { text: string }): Promise<PhraseReply> {
  return req<PhraseReply>("/api/phrases", json(body));
}

/** GET /api/phrases/lookup: the phrase with these words, or null. */
export function lookupPhrase(text: string, signal?: AbortSignal): Promise<PhraseLookupReply> {
  return req<PhraseLookupReply>(`/api/phrases/lookup?text=${encodeURIComponent(text)}`, { signal });
}

/** GET /api/phrases/:id: one phrase with its examples. */
export function getPhrase(id: string, signal?: AbortSignal): Promise<PhraseReply> {
  return req<PhraseReply>(`/api/phrases/${encodeURIComponent(id)}`, { signal });
}

export function updatePhrase(id: string, body: PhraseInput): Promise<PhraseReply> {
  return req<PhraseReply>(`/api/phrases/${encodeURIComponent(id)}`, json(body, "PATCH"));
}

export function deletePhrase(id: string): Promise<{ deleted: true }> {
  return req<{ deleted: true }>(`/api/phrases/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ------------------------------ conversations ----------------------------- */
// Saved voice sessions: the active learner's, like the turn that writes them.

/** POST /api/conversations: a session's first turn is about to run. */
export function createConversation(body: ConversationCreateRequest, signal?: AbortSignal): Promise<ConversationReply> {
  return req<ConversationReply>("/api/conversations", { ...json(body), signal });
}

/** GET /api/conversations: History, newest first, a page at a time. */
export function listConversations(offset = 0, limit = 20): Promise<ConversationsReply> {
  const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return req<ConversationsReply>(`/api/conversations?${q}`);
}

/** GET /api/conversations/:id: one page of its turns, from idx `from`. */
export function getConversation(id: string, from = 0, signal?: AbortSignal): Promise<ConversationTurnsReply> {
  return req<ConversationTurnsReply>(`/api/conversations/${encodeURIComponent(id)}?from=${from}`, { signal });
}

export function deleteConversation(id: string): Promise<{ deleted: true }> {
  return req<{ deleted: true }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * POST /api/conversations/:id/end, fire and forget. A keepalive fetch, so it
 * still goes out when the page is unloading (Close, a reload, the tab shut):
 * unlike sendBeacon it can carry the headers wrap() checks. `page` is the
 * learner and language the conversation was started for, sent as is: after
 * a learner or language switch the page's are already the next ones, and
 * the server then answers stale_learner, which is ignored here rather than
 * sending this page to re-read who's practising (the conversation is ended
 * two idle hours later instead). Ending twice is harmless (idempotent).
 */
export function endConversation(id: string, page: PageLearner): Promise<void> {
  return fetch(`/api/conversations/${encodeURIComponent(id)}/end`, {
    method: "POST",
    keepalive: true,
    headers: pageHeaders(page),
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** One line → playable audio. Errors come back as the usual {error}. */
export async function speakLine(body: VoiceSpeakRequest, signal?: AbortSignal): Promise<Blob> {
  const res = await send("/api/voice/speak", { ...json(body), signal });
  check401(res);
  if (res.ok) return res.blob();
  const text = await res.text();
  let msg = text.slice(0, 200) || `${res.status} ${res.statusText}`;
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === "string") msg = j.error;
  } catch {
    /* non-JSON */
  }
  throw new ApiError(msg, res.status);
}

/** Search the ElevenLabs Voice Library (`locale` narrows to native speakers). */
export function searchLibrary(
  params: { locale: string; gender: string; q: string; sort: LibrarySort; page: number },
  signal?: AbortSignal,
): Promise<LibraryReply> {
  const q = new URLSearchParams({ locale: params.locale, gender: params.gender, q: params.q, sort: params.sort, page: String(params.page) });
  return req<LibraryReply>(`/api/voice/library?${q}`, { signal });
}

/** Add a library voice to the ElevenLabs account; resolves to the id to use. */
export function addLibraryVoice(body: LibraryAddRequest): Promise<LibraryAddReply> {
  return req<LibraryAddReply>("/api/voice/library/add", json(body));
}
