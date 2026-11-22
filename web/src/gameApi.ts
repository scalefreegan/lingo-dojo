// The kids word game's calls (web/server/pictures.ts), beside practiceApi.ts:
// through the same req(), so the page's learner and language headers, the
// 401 and the stale-learner 409 behave as everywhere. The pictures are
// fetched with those headers too (an <img src> can't send them) and shown
// from blob URLs; the browser's HTTP cache keeps them (the route answers
// immutable, keyed by the picture's file in the URL).

import { json, req, reqBlob } from "./api";
import type {
  AddStockConceptRequest, DrawAnywayRequest, DrawMissingRequest, GameAnswerReply, GameAnswerRequest, GameStartReply, GameStartRequest, GameStatusReply, PoolLevel, PhrasePictureReply, RestyleReply, SetStockAdultsRequest, SetStockGroupRequest, StockChangeReply, StockListReply,
  WordPicturesReply,
} from "./types";
import { utcOffset } from "./practiceApi";

/** GET /api/game: the pictures' status. Starts nothing (safe to poll). */
export const gameStatus = (signal?: AbortSignal) => req<GameStatusReply>("/api/game", { signal });

/** POST /api/game/start: a game's rounds (from ready pictures only). */
export const startGame = (signal?: AbortSignal, level?: PoolLevel) => req<GameStartReply>("/api/game/start", { ...json((level ? { level } : {}) satisfies GameStartRequest), signal });

/** POST /api/game/answer: one tap, recorded quietly. */
export const answerRound = (body: Omit<GameAnswerRequest, "tz">) => req<GameAnswerReply>("/api/game/answer", json({ ...body, tz: utcOffset() }));

/** GET /api/game/audio/:phraseId: the word said (cached by the server). */
export async function wordAudio(phraseId: string, signal?: AbortSignal): Promise<Blob> {
  return (await reqBlob(`/api/game/audio/${encodeURIComponent(phraseId)}`, { signal })).blob;
}

/** GET /api/game/pictures/:id/:file: a picture's bytes. */
export async function pictureBlob(id: string, file: string, signal?: AbortSignal): Promise<Blob> {
  return (await reqBlob(`/api/game/pictures/${encodeURIComponent(id)}/${encodeURIComponent(file)}`, { signal })).blob;
}

/* ------------------------------- the grown-up ------------------------------- */

/** GET /api/pictures: the status, for the Phrase bank's line. */
export const pictureStatus = (signal?: AbortSignal) => req<GameStatusReply>("/api/pictures", { signal });

/** POST /api/pictures/fill: draw pictures for the words waiting. */
export const fillPictures = () => req<GameStatusReply>("/api/pictures/fill", json({}));

/** POST /api/pictures/restyle: Redraw all in the current style. */
export const restylePictures = () => req<RestyleReply>("/api/pictures/restyle", json({}));

/** GET /api/pictures/phrase/:id: a word's picture. */
export const phrasePicture = (phraseId: string, signal?: AbortSignal) => req<PhrasePictureReply>(`/api/pictures/phrase/${encodeURIComponent(phraseId)}`, { signal });

/** POST /api/pictures/phrase/:id/remove | redraw. */
export const changePhrasePicture = (phraseId: string, action: "remove" | "redraw") =>
  req<PhrasePictureReply>(`/api/pictures/phrase/${encodeURIComponent(phraseId)}/${action}`, json({}));

/** POST /api/pictures/phrase/:id/draw: a word left out as "no clear
 *  picture", drawn anyway, as the grown-up describes it (or by its meaning). */
export const drawPhrasePictureAnyway = (phraseId: string, description: string) =>
  req<PhrasePictureReply>(`/api/pictures/phrase/${encodeURIComponent(phraseId)}/draw`, json({ description } satisfies DrawAnywayRequest));

/** GET /api/pictures/words: the picture library's "My word pictures". */
export const wordPictures = (signal?: AbortSignal) => req<WordPicturesReply>("/api/pictures/words", { signal });

/* ------------------------------ stock pictures ------------------------------ */

/** GET /api/stock-pictures: the shared set (reads only; safe to poll). */
export const stockPictures = (signal?: AbortSignal) => req<StockListReply>("/api/stock-pictures", { signal });

/** GET /api/stock-pictures/file/:id/:version: a stock picture's bytes. */
export async function stockPictureBlob(id: string, version: string, signal?: AbortSignal): Promise<Blob> {
  return (await reqBlob(`/api/stock-pictures/file/${encodeURIComponent(id)}/${encodeURIComponent(version)}`, { signal })).blob;
}

/** POST /api/stock-pictures/admin/concepts (admins). */
export const addStockConcept = (body: AddStockConceptRequest) => req<StockChangeReply>("/api/stock-pictures/admin/concepts", json(body));

/** POST /api/stock-pictures/admin/missing (admins): `count` is what the page showed. */
export const drawMissingStock = (count: number) => req<StockChangeReply>("/api/stock-pictures/admin/missing", json({ count } satisfies DrawMissingRequest));

/** POST /api/stock-pictures/admin/:id/draw | remove (admins). */
export const changeStockPicture = (id: string, action: "draw" | "remove") => req<StockChangeReply>(`/api/stock-pictures/admin/${encodeURIComponent(id)}/${action}`, json({}));
/** Set or clear a shared picture's Adults only flag (admin only; a file
 *  concept's setting is install-wide, kept in the database). */
export const setStockAdults = (id: string, adults: boolean) =>
  req<StockChangeReply>(`/api/stock-pictures/admin/${encodeURIComponent(id)}/adults`, json({ adults } satisfies SetStockAdultsRequest));
/** Set or clear (null) an added shared picture's look-alike group (admin only). */
export const setStockGroup = (id: string, group: string | null) =>
  req<StockChangeReply>(`/api/stock-pictures/admin/${encodeURIComponent(id)}/group`, json({ group } satisfies SetStockGroupRequest));
