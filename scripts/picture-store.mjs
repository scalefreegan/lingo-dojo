// The word game's pictures on disk (docs/DATA.md §Kids word game), beside
// the phrase audio cache (scripts/audio-cache.mjs) and built the same way:
//
//   <dir>/<64 hex>.<png|webp|jpg>               a word's own picture
//   <dir>/stock/<theme>/<concept id>.<ext>      the shared stock set (ld-6k7)
//
// Unlike the audio cache this is not a cache that may drop a file: a
// picture is paid for once and kept until a grown-up removes or redraws it
// (or its word is edited and drawn again), so there is no size bound and no
// eviction. The directory is LINGO_IMAGES_DIR, else <LINGO_DATA_DIR or
// data/>/images (data/ is gitignored), read per call so a test can point it
// at a temp dir.
//
// Safety. A file name is only ever a random 64-hex key this module made
// (stored in phrase_pictures.file) plus an extension from a fixed list:
// nothing a client sends becomes a path. The route that serves a file takes
// a picture id the active language profile owns, so files are per learner
// (and so per user) by the row that names them. Writes are atomic (a temp
// file in the same directory, then rename), mode 0600 in a 0700 directory.
//
// The stock set lives apart, under stock/<theme>/ (pictures.mjs
// PICTURE_THEME: a new theme is a new folder, never a mix), named by the
// concept's id. A word pointing at one stores stockKey(theme, id) as its
// `file`, which is never the name of a file here, and deletePicture only
// ever touches <dir>/<64 hex>.<ext> directly inside <dir>: no per-word
// removal, redraw or phrase delete can reach a stock file. Only
// deleteStockPicture does (the grown-up's explicit stock management).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./content.mjs";
import { STOCK_ID_RE, THEME_RE } from "./pictures.mjs";

const KEY_RE = /^[0-9a-f]{64}$/;
/** Content types kept, and the extension each is stored under. */
export const PICTURE_TYPES = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };
/** A picture larger than this is refused (a 1024px low-quality image is a
 *  few hundred KB at most). */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/** The pictures directory: LINGO_IMAGES_DIR, else <data dir>/images. */
export function imagesDir(env = process.env) {
  if (env.LINGO_IMAGES_DIR) return path.resolve(REPO_ROOT, env.LINGO_IMAGES_DIR);
  const data = env.LINGO_DATA_DIR ? path.resolve(REPO_ROOT, env.LINGO_DATA_DIR) : path.join(REPO_ROOT, "data");
  return path.join(data, "images");
}

/** A new file key: random, so a redraw is a new name (and a new URL). */
export const newPictureKey = () => randomBytes(32).toString("hex");

function fileFor(dir, key, type) {
  if (!KEY_RE.test(String(key))) throw new Error("not a picture key");
  const ext = PICTURE_TYPES[type];
  if (!ext) throw new Error("not a picture type");
  return path.join(dir, `${key}.${ext}`);
}

/** The content type of `bytes` by its magic number, or null: what the
 *  provider sent is checked, not taken on its word. */
export function sniffPicture(bytes) {
  const b = Buffer.from(bytes ?? []);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/** Store a picture under `key`: a temp file, then rename. */
export function writePicture(key, bytes, type, { dir = imagesDir() } = {}) {
  const file = fileFor(dir, key, type);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${key}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** A stored picture's bytes, or null when the file is gone. */
export function readPicture(key, type, { dir = imagesDir() } = {}) {
  try {
    const b = fs.readFileSync(fileFor(dir, key, type));
    return b.length ? b : null;
  } catch {
    return null;
  }
}

/* ---------------------------------- stock ---------------------------------- */

/** The stock folder of `theme` (checked: a theme id is a plain name). */
export function stockDir(theme, { dir = imagesDir() } = {}) {
  if (!THEME_RE.test(String(theme)) || theme.includes("..")) throw new Error("not a theme id");
  return path.join(dir, "stock", theme);
}

function stockFileFor(theme, id, type, dir) {
  if (!STOCK_ID_RE.test(String(id))) throw new Error("not a stock id");
  const ext = PICTURE_TYPES[type];
  if (!ext) throw new Error("not a picture type");
  return path.join(stockDir(theme, { dir }), `${id}.${ext}`);
}

/** The stock picture of concept `id` in `theme` on disk: `{ path, type }`,
 *  or null when it isn't drawn (yet). */
export function stockPicture(theme, id, { dir = imagesDir() } = {}) {
  for (const type of Object.keys(PICTURE_TYPES)) {
    const p = stockFileFor(theme, id, type, dir);
    try {
      if (fs.statSync(p).size > 0) return { path: p, type };
    } catch {
      /* not this type */
    }
  }
  return null;
}

/** A stock picture's bytes and type, or null. */
export function readStockPicture(theme, id, { dir = imagesDir() } = {}) {
  const at = stockPicture(theme, id, { dir });
  if (!at) return null;
  try {
    const bytes = fs.readFileSync(at.path);
    return bytes.length ? { bytes, type: at.type } : null;
  } catch {
    return null;
  }
}

/** Store a stock picture (a temp file, then rename), replacing one of
 *  another type. */
export function writeStockPicture(theme, id, bytes, type, { dir = imagesDir() } = {}) {
  const file = stockFileFor(theme, id, type, dir);
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const tmp = path.join(folder, `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  for (const other of Object.keys(PICTURE_TYPES)) if (other !== type) fs.rmSync(stockFileFor(theme, id, other, dir), { force: true });
}

/** Delete a stock picture (any type); a missing one is fine. Words pointing
 *  at it leave the game until it is drawn again (the server's stock rows
 *  need the file). */
export function deleteStockPicture(theme, id, { dir = imagesDir() } = {}) {
  for (const type of Object.keys(PICTURE_TYPES)) fs.rmSync(stockFileFor(theme, id, type, dir), { force: true });
}

/** Delete a stored picture (any type it may be under); a missing file is
 *  fine. Only ever a file directly inside the pictures directory: the key
 *  is checked (64 hex, so no separator or dot can be in it) and so is the
 *  path made from it, and a name that is a directory there is left alone. */
export function deletePicture(key, { dir = imagesDir() } = {}) {
  if (!KEY_RE.test(String(key))) return;
  const root = path.resolve(dir);
  for (const type of Object.keys(PICTURE_TYPES)) {
    const file = path.resolve(fileFor(dir, key, type));
    // Unreachable today (a 64-hex key plus a fixed extension can't leave
    // the directory): kept as a second guard should the key rule change.
    if (path.dirname(file) !== root) continue;
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
}
