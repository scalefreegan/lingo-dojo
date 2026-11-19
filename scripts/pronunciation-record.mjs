#!/usr/bin/env node
// A small local page for recording real pronunciation clips for the proof
// (docs/pronunciation-proof.md §Real recordings):
//
//   npm run pron:record        → http://127.0.0.1:38410
//
// It is not part of the app: no app routes, no database, no login, and it
// never touches port 38400. It listens on 127.0.0.1 only, answers only
// requests addressed to that loopback host, and takes a POST only from its
// own page. Nothing leaves this machine: the page is one file with every
// asset inline and a Content-Security-Policy that forbids anything else,
// the model clips are the proof's cached ones (no new paid calls), and the
// scorer that prints the test readout is the local one.
//
// Recordings are a person's voice. They go to
// data/pronunciation-proof/recordings/ (gitignored; the tool refuses to
// start if git would track that folder) under generated names, with one
// line each in labels.tsv, the file the proof harness reads. What is done
// is derived from that file, so a session can stop and resume.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expectedSyllables, parseWav, scoreTones, speakerRange, trackPitch } from "./pronunciation.mjs";
import {
  GROUPS, LABELS_HEADER, MAX_UPLOAD_BYTES, MODEL_VOICES, PAGE_FUNCTIONS, PROCESSING, buildPrompts, checkWav, cleanSpeaker, doneKeys, findSpeaker, formatLabel, isRecordingName, newFileName, parseLabels, promptKey, readout,
} from "./pronunciation-recordings.mjs";
import { readCodePoints } from "../web/src/script/zh.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
export const DEFAULT_PORT = 38410;
/** A speaker's range is used for the readout only once this many of their
 *  other clips exist; before that the height rules stay silent. */
const RANGE_FROM_CLIPS = 5;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The cached model clip for a text: the first voice that has it. Only
 *  texts from the fixed prompt list are ever looked up. */
function modelFinder(clipsDir) {
  let voices = [...MODEL_VOICES];
  try {
    const rest = fs.readdirSync(clipsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "recordings" && !d.name.startsWith(".") && !voices.includes(d.name)).map((d) => d.name).sort();
    voices = [...voices, ...rest];
  } catch {
    // No cache at all: every prompt is left out and the page says so.
  }
  return (text) => {
    for (const v of voices) {
      const file = path.join(clipsDir, v, `${text}.wav`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };
}

/** Is this request addressed to the loopback host it arrived on? A page on
 *  another site that resolves its own name to 127.0.0.1 (DNS rebinding)
 *  still sends its own name in Host. */
export function loopbackHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * The tool as a request handler, so a test can mount it on any port.
 *   dir       where recordings and labels.tsv go
 *   clipsDir  the proof's clip cache (model audio)
 *   parse     how labels.tsv is read (a test puts a failing reader here)
 */
export function createRecorder({ dir, clipsDir, parse = parseLabels }) {
  const findModel = modelFinder(clipsDir);
  const prompts = buildPrompts((text) => Boolean(findModel(text)));
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const labelsFile = path.join(dir, "labels.tsv");
  const template = fs.readFileSync(path.join(HERE, "pronunciation-record.html"), "utf8");
  // Pitch tracks of clips already kept, so a speaker's range doesn't mean
  // re-reading every file on every clip.
  const tracks = new Map();

  const readRows = () => (fs.existsSync(labelsFile) ? parse(fs.readFileSync(labelsFile, "utf8")).rows : []);

  function page() {
    const nonce = crypto.randomBytes(16).toString("base64");
    const data = JSON.stringify({ prompts, groups: GROUPS }).replace(/</g, "\\u003c");
    return { nonce, html: template.replaceAll("__NONCE__", nonce).replace("__SHARED__", () => PAGE_FUNCTIONS).replace("__DATA__", () => data) };
  }

  function speakers() {
    const rows = readRows();
    // One entry per person: names that differ only in capitals are one.
    const names = [...new Set(rows.map((r) => findSpeaker(rows, r.speaker).name))];
    const same = (r, name) => r.speaker.toLowerCase() === name.toLowerCase();
    return names.map((name) => ({ name, group: rows.find((r) => same(r, name) && r.group)?.group ?? "", done: [...done(rows, name)].filter((k) => prompts.some((p) => promptKey(p) === k)).length }));
  }

  /** What this person has kept, under any capitals of their name. */
  function done(rows, name) {
    const out = new Set();
    for (const r of rows) if (r.speaker.toLowerCase() === name.toLowerCase()) for (const k of doneKeys(rows, r.speaker)) out.add(k);
    return out;
  }

  function trackOf(file) {
    if (!tracks.has(file)) {
      const { samples, sampleRate } = parseWav(fs.readFileSync(path.join(dir, file)));
      tracks.set(file, trackPitch(samples, sampleRate));
    }
    return tracks.get(file);
  }

  /** The test readout for a clip just kept: the local scorer against the
   *  reference text, read in the range of this speaker's other clips. */
  function score(prompt, wav, file, speaker, rows) {
    const { samples, sampleRate } = parseWav(wav);
    const track = trackPitch(samples, sampleRate);
    tracks.set(file, track);
    const others = [];
    for (const r of rows) {
      if (r.speaker.toLowerCase() !== speaker.toLowerCase() || r.file === file || !isRecordingName(r.file)) continue;
      try {
        others.push(trackOf(r.file));
      } catch {
        // A clip deleted by hand: the range goes without it.
      }
    }
    const syllables = expectedSyllables(prompt.text, readCodePoints(prompt.text, "zh-CN"));
    const result = scoreTones({ samples, sampleRate, syllables, track, speaker: others.length >= RANGE_FROM_CLIPS ? speakerRange(others) : null });
    return readout(result);
  }

  async function body(req) {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, "the recording is too long");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "the recording is too long");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** One line onto labels.tsv, on a line of its own whatever the file
   *  ended with: a hand-edited file whose last line has no newline would
   *  otherwise swallow the new row and lose both. `size` is the file's
   *  size now (labelsSize). */
  function appendLabel(line, size) {
    let glue = "";
    if (size > 0) {
      const fd = fs.openSync(labelsFile, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) glue = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.appendFileSync(labelsFile, `${glue}${line}\n`);
  }

  /** labels.tsv's size, made with its header first if it isn't there:
   *  taken before a line is added, it is where to cut the file back to
   *  if the line doesn't go in whole. */
  function labelsSize() {
    if (!fs.existsSync(labelsFile)) fs.writeFileSync(labelsFile, `${LABELS_HEADER}\n`, { flag: "wx", mode: 0o600 });
    return fs.statSync(labelsFile).size;
  }

  async function keep(req, url) {
    const q = url.searchParams;
    // The prompt is named by its text and what was asked, not by its id
    // alone: a tab left open across a restart may hold a list this server
    // no longer has, and a clip must never be filed under another text.
    const text = q.get("text");
    const said = q.get("said") ?? "";
    const prompt = text === null ? null : prompts.find((p) => p.text === text && p.said === said);
    if (!prompt || prompt.id !== q.get("prompt")) throw new HttpError(409, "This page is out of date with the recorder. Reload the page and record this one again.");
    const typed = cleanSpeaker(q.get("speaker"));
    if (!typed) throw new HttpError(400, "pick a speaker name first");
    const group = q.get("group") ?? "";
    if (!GROUPS.includes(group)) throw new HttpError(400, "the speaker is an adult or a child");
    const processing = q.get("processing") ?? "";
    if (!PROCESSING.includes(processing)) throw new HttpError(409, "This page is out of date with the recorder. Reload the page and record this one again.");
    // A name already in the labels is that person, whatever its capitals,
    // and stays in the group it was first given.
    const who = () => {
      let rows;
      try {
        rows = readRows();
      } catch (e) {
        console.error(`labels.tsv can't be read: ${e.message}`);
        throw new HttpError(500, "labels.tsv could not be read, so the clip was not kept. The terminal has the details.");
      }
      const known = findSpeaker(rows, typed);
      if (known?.group && known.group !== group) throw new HttpError(409, `${known.name} is already recorded as ${known.group === "child" ? "a child" : "an adult"}. Go back to the start and pick that name, or use a different one.`);
      return known?.name ?? typed;
    };
    // Asked before the upload is read, to refuse early…
    who();
    if (!/^audio\/(wav|x-wav|wave)$/.test(String(req.headers["content-type"] ?? "").split(";")[0].trim())) throw new HttpError(415, "send the recording as audio/wav");
    const wav = await body(req);
    const check = checkWav(wav);
    if (!check.ok) throw new HttpError(400, check.error);
    // …and again now that it has arrived: another tab may have kept a clip
    // under the same name, in other capitals or the other group, while
    // this one was uploading. Nothing below waits, so this answer holds
    // until the label is written.
    const speaker = who();

    // Saved first; the readout below can fail without losing the clip.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = newFileName();
    fs.writeFileSync(path.join(dir, file), wav, { flag: "wx", mode: 0o600 });
    const label = { file, text: prompt.text, said: prompt.said, speaker, group, unsure: q.get("unsure") === "1", processing };
    let rows;
    let sizeBefore = null;
    try {
      sizeBefore = labelsSize();
      appendLabel(formatLabel(label), sizeBefore);
      // Saved means the row reads back: nothing is answered on trust.
      rows = readRows();
      const back = rows.find((r) => r.file === file);
      if (!back || back.text !== label.text || back.said !== label.said || back.speaker !== label.speaker) throw new Error("the new row does not read back");
    } catch (e) {
      // A clip without its label is a file nobody can score: take it away
      // again (it is this request's own file) and say so. And a label
      // without its clip would show the prompt as done: the line, or
      // whatever part of it was written, comes off again.
      fs.rmSync(path.join(dir, file), { force: true });
      try {
        if (sizeBefore !== null) fs.truncateSync(labelsFile, sizeBefore);
      } catch (e2) {
        console.error(`labels.tsv could not be cut back after ${file}: ${e2.message}. Remove its line by hand.`);
      }
      console.error(`label not written for ${file}: ${e.message}`);
      throw new HttpError(500, "The clip could not be added to labels.tsv, so it was not kept. The terminal has the details.");
    }

    let heard = null;
    try {
      heard = score(prompt, wav, file, speaker, rows);
    } catch (e) {
      console.error(`readout failed for ${file}: ${e.message}`);
    }
    return { saved: true, readout: heard, done: [...done(rows, speaker)] };
  }

  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };

  async function route(req, res) {
    const port = req.socket.localPort;
    const host = req.headers.host ?? "";
    if (!loopbackHost(host, port)) throw new HttpError(403, "this tool answers on 127.0.0.1 only");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "POST") {
      // A browser always names the Origin of a POST; only this page's own
      // counts. Another site's form or fetch is refused before any work.
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, "cross-origin request refused");
      if (url.pathname === "/api/keep") return json(res, 200, await keep(req, url));
      throw new HttpError(404, "not found");
    }
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    if (url.pathname === "/") {
      const { nonce, html } = page();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // Nothing from anywhere else, and nothing sent anywhere else.
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.end(html);
    }
    if (url.pathname === "/api/speakers") return json(res, 200, { speakers: speakers() });
    if (url.pathname === "/api/progress") {
      const speaker = cleanSpeaker(url.searchParams.get("speaker"));
      if (!speaker) throw new HttpError(400, "type a name or nickname");
      // `existing` is the person already under that name (any capitals),
      // with the group they were first given: the page asks before it
      // carries on as them.
      const rows = readRows();
      const existing = findSpeaker(rows, speaker);
      return json(res, 200, { speaker: existing?.name ?? speaker, existing, done: [...done(rows, speaker)] });
    }
    const model = url.pathname.match(/^\/model\/([rw]\d{2})$/);
    if (model) {
      const prompt = byId.get(model[1]);
      const file = prompt && findModel(prompt.model);
      if (!file) throw new HttpError(404, "no model clip");
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(fs.readFileSync(file));
    }
    throw new HttpError(404, "not found");
  }

  const handler = (req, res) => {
    route(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error(e);
      // An upload refused part-way leaves unread bytes on the socket.
      if (!res.headersSent) res.setHeader("Connection", "close");
      json(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : "something went wrong; the terminal has the details" });
    });
  };
  return { handler, prompts };
}

/** Could git commit anything in this folder? Yes when a new file there
 *  would not be ignored, and yes when a file under it is tracked already
 *  (an ignore rule added later does not untrack it). Outside the
 *  repository, or with no git at all: no. */
export function trackedByGit(dir, repo = REPO) {
  const rel = path.relative(repo, path.resolve(dir));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    if (execFileSync("git", ["-C", repo, "ls-files", "--", rel || "."], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) return true;
  } catch {
    // No git, or not a repository: nothing here can be committed.
    return false;
  }
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "-q", path.join(rel, "probe.wav")], { stdio: "ignore" });
    return false;
  } catch (e) {
    // Exit 1 is "not ignored".
    return e.status === 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clipsDir = process.env.LINGO_PROOF_DIR ? path.resolve(process.env.LINGO_PROOF_DIR) : path.join(REPO, "data", "pronunciation-proof");
  const dir = process.env.LINGO_RECORDINGS_DIR ? path.resolve(process.env.LINGO_RECORDINGS_DIR) : path.join(clipsDir, "recordings");
  const port = Number(process.env.LINGO_RECORD_PORT || DEFAULT_PORT);
  if (trackedByGit(dir)) {
    console.error(`${dir} is inside the repository and not gitignored (or already holds tracked files): recordings could be committed. Refusing to start.`);
    process.exit(1);
  }
  const { handler, prompts } = createRecorder({ dir, clipsDir });
  if (!prompts.length) {
    console.error(`No model clips in ${clipsDir}. Run \`node scripts/pronunciation-proof.mjs --say --quick\` first (free, macOS voices).`);
    process.exit(1);
  }
  const server = http.createServer(handler);
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use: is the recorder already running?` : e.message);
    process.exit(1);
  });
  // Loopback only: never reachable from another machine.
  server.listen(port, "127.0.0.1", () => {
    console.log(`Recording page: http://127.0.0.1:${port}`);
    console.log(`${prompts.filter((p) => p.part === "right").length} prompts to say as shown, ${prompts.filter((p) => p.part === "wrong").length} to say wrong on purpose.`);
    console.log(`Clips are saved in ${dir} and stay on this machine. Ctrl-C to stop.`);
  });
}
