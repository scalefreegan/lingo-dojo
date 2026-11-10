/* Typed fetch layer (Atlas pattern). Every call goes to the same-origin Vite
 * middleware in server/ (which enforces the same-origin check in its own
 * wrap()). This is the only file in src/ that knows URL shapes — components
 * import a named function per endpoint, never req() itself.
 *
 * Every content, pack, folder, assemble, export and profile call names the
 * mode it works in ("adult" → content/, "kids" → content/kids/); the server
 * keeps the two trees apart, and so does the URL. */

import type {
  AssembleResult, ChatCommit, ChatDone, ChatError, ChatHeartbeat, ChatHistoryReply, ChatReply, ChatRequest, ChatStart,
  ContentReply, ExportRequest, ExportResult, FolderDeleteReply, FolderReply, FolderRequest, Mode, PackDeleteReply, PackInput,
  PackMoveRequest, PackRenameRequest, PackWriteReply, PacksReply, ProfileReply, ProfileRequest, SettingsReply, SettingsRequest,
  VoiceCastReply, VoiceCastRequest,
  LibraryAddReply, LibraryAddRequest, LibraryReply, LibrarySort, TranscribeReply, TtsProvider, VoiceSettingsReply, VoiceSettingsRequest, VoiceSpeakRequest, VoiceTurnReply, VoiceTurnRequest, VoicesReply,
} from "./types";

/** A non-2xx reply; `message` is the server's `{error}` sentence. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
    throw new ApiError(typeof err === "string" ? err : text.slice(0, 200) || `${res.status} ${res.statusText}`, res.status);
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

/** GET /api/content — re-read from disk on every call. */
export function getContent(mode: Mode): Promise<ContentReply> {
  return req<ContentReply>(inMode("/api/content", mode));
}

/** PUT /api/profile — merges the picker keys into that mode's profile.yaml. */
export function saveProfile(mode: Mode, patch: ProfileRequest): Promise<ProfileReply> {
  return req<ProfileReply>(inMode("/api/profile", mode), json(patch, "PUT"));
}

/* --------------------------------- packs --------------------------------- */

/** A pack id in a URL: each segment encoded on its own, so the one slash of
 *  a folder id stays a path separator. */
function packUrl(id: string, mode: Mode, action = ""): string {
  return inMode(`/api/packs/${id.split("/").map(encodeURIComponent).join("/")}${action}`, mode);
}

/** GET /api/packs — the saved packs and the folders under the tree's packs/. */
export function listPacks(mode: Mode): Promise<PacksReply> {
  return req<PacksReply>(inMode("/api/packs", mode));
}

/** PUT /api/packs/:id — creates or overwrites <tree>/packs/<id>.yaml and
 *  commits it. Every write below answers with the pack as it reads back and
 *  the commit that recorded it (see Committed in the wire types). */
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

/** POST /api/packs/:id/rename — new title, and a file renamed to match. */
export function renamePack(mode: Mode, id: string, title: string): Promise<PackWriteReply> {
  return req<PackWriteReply>(packUrl(id, mode, "/rename"), json({ title } satisfies PackRenameRequest));
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
  const res = await fetch(url, { ...json(body), signal });
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

/** Merges into data/voice.json; `voices` replaces the whole map. */
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

/** One line → playable audio. Errors come back as the usual {error}. */
export async function speakLine(body: VoiceSpeakRequest, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch("/api/voice/speak", { ...json(body), signal });
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
