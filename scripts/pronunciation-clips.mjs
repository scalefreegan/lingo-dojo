// Flagged clips on disk (stage 2 of pronunciation feedback, ld-ne0.3;
// docs/DATA.md §Pronunciation in sessions): the audio of an adult's Go-tab
// turn whose tone check flagged a syllable, kept on this Mac beside the
// audio cache and the pictures, and nothing else of anyone's voice:
//
//   <dir>/<conversation uuid>/<check uuid>.wav
//
// The directory is LINGO_CLIPS_DIR, else <LINGO_DATA_DIR or data/>/clips
// (data/ is gitignored), read per call so a test can point it at a temp dir.
//
// A file is named only by ids this app made (the conversation's and the
// pronunciation_checks row's, both uuids, checked here): nothing a client
// sends becomes a path. The route that serves one takes a check id the
// active language profile owns (scripts/db/pronunciation.ts clipOf), so a
// clip is its own learner's alone. Writes are atomic (a temp file in the
// same directory, then rename), mode 0600 in 0700 directories. Deleting a
// conversation removes its folder (web/server/conversations.ts remove). A
// clip offered but not kept (past the per-session cap, or the turn not
// saved) is removed by the turn route at once (livePronunciation.ts
// dropClip).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./content.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;

/** The clips directory: LINGO_CLIPS_DIR, else <data dir>/clips. */
export function clipsDir(env = process.env) {
  if (env.LINGO_CLIPS_DIR) return path.resolve(REPO_ROOT, env.LINGO_CLIPS_DIR);
  const data = env.LINGO_DATA_DIR ? path.resolve(REPO_ROOT, env.LINGO_DATA_DIR) : path.join(REPO_ROOT, "data");
  return path.join(data, "clips");
}

function folderOf(dir, conversationId) {
  if (!UUID_RE.test(String(conversationId))) throw new Error("not a conversation id");
  return path.join(dir, conversationId);
}

function fileOf(dir, conversationId, file) {
  if (!FILE_RE.test(String(file))) throw new Error("not a clip file name");
  return path.join(folderOf(dir, conversationId), file);
}

/** Store a clip as `<id>.wav`; → the file name (what the row keeps). */
export function writeClip(conversationId, id, bytes, { dir = clipsDir() } = {}) {
  const name = `${id}.wav`;
  const file = fileOf(dir, conversationId, name);
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
  return name;
}

/** A clip's bytes, or null when the file isn't there. */
export function readClip(conversationId, file, { dir = clipsDir() } = {}) {
  try {
    return fs.readFileSync(fileOf(dir, conversationId, file));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/** Remove one clip (gone already: nothing to do). */
export function removeClip(conversationId, file, { dir = clipsDir() } = {}) {
  fs.rmSync(fileOf(dir, conversationId, file), { force: true });
}

/** Remove a conversation's clip folder and everything in it. */
export function removeConversationClips(conversationId, { dir = clipsDir() } = {}) {
  fs.rmSync(folderOf(dir, conversationId), { recursive: true, force: true });
}
