// The word game's pictures on disk (docs/DATA.md §Kids word game), beside
// the phrase audio cache (scripts/audio-cache.mjs) and built the same way:
//
//   <dir>/<64 hex>.<png|webp|jpg>
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

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./content.mjs";

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

/** Delete a stored picture (any type it may be under); a missing file is fine. */
export function deletePicture(key, { dir = imagesDir() } = {}) {
  if (!KEY_RE.test(String(key))) return;
  for (const type of Object.keys(PICTURE_TYPES)) fs.rmSync(fileFor(dir, key, type), { force: true });
}
