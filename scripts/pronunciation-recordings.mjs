// The pure half of the recording tool (scripts/pronunciation-record.mjs)
// and of the proof's "Real recordings" section: the prompt list, the
// labels.tsv format, generated file names, the check on an uploaded WAV,
// and the per-speaker tally. No server, no network; node --test covers it
// directly (scripts/tests/pronunciation-record.test.mjs).
//
// Recordings are a person's voice: they live only under the gitignored
// data/pronunciation-proof/recordings/, and nothing a user typed ever
// becomes part of a path.

import { expectedSyllables, parsePinyin, withTone } from "./pronunciation.mjs";
import { readCodePoints } from "../web/src/script/zh.ts";

const LOCALE = "zh-CN";

/** The proof's clips: four syllables in each of the four tones, in tone
 *  order within each group of four (妈 mā, 麻 má, 马 mǎ, 骂 mà), and short
 *  phrases. The proof harness scores these; the recorder asks for them. */
export const SINGLES = [..."妈麻马骂诗十使是衣姨椅意八拔把爸"];
export const PHRASES = ["你好", "不是", "一个", "很好", "谢谢", "我很好", "不客气", "一起去", "你叫什么", "我想喝水", "明天见", "今天很热", "我是学生", "他不来", "再见"];

/** English for the prompt card. A lone syllable has many meanings; this is
 *  the one for the character shown. */
export const GLOSS = {
  妈: "mum", 麻: "hemp; numb", 马: "horse", 骂: "to scold",
  诗: "poem", 十: "ten", 使: "to make; to use", 是: "to be; yes",
  衣: "clothes", 姨: "aunt", 椅: "chair", 意: "meaning; idea",
  八: "eight", 拔: "to pull out", 把: "to hold; a handful", 爸: "dad",
  你好: "hello", 不是: "is not; no", 一个: "one (of something)", 很好: "very good", 谢谢: "thank you",
  我很好: "I'm fine", 不客气: "you're welcome", 一起去: "go together", 你叫什么: "what's your name?",
  我想喝水: "I'd like some water", 明天见: "see you tomorrow", 今天很热: "it's hot today",
  我是学生: "I'm a student", 他不来: "he isn't coming", 再见: "goodbye",
};

/** Which cached voice models a prompt: the macOS Mandarin voices first
 *  (native voices), then whatever else the proof cached, by name. */
export const MODEL_VOICES = ["say-tingting", "say-reed"];

/** Part two: which tone to say instead. Each of the twelve ordered pairs
 *  of different tones once, three per syllable group, so the proof sees
 *  every confusion and no group is asked for the same swap twice. Index i
 *  goes to group i % 4: [reference tone, tone to say]. */
const SWAPS = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 3], [2, 4], [3, 4], [4, 1], [3, 1], [3, 2], [4, 2], [4, 3]];

const strip = (pinyin) => parsePinyin(pinyin).base;

function card(text) {
  const syllables = expectedSyllables(text, readCodePoints(text, LOCALE));
  if (!syllables.length || syllables.length !== [...text].length) return null;
  return syllables.map((s) => ({
    char: s.char,
    // As written in a dictionary, and as said here: 你 is nǐ, but ní
    // before 好. The page shows the second large and explains the first.
    written: s.pinyin,
    tone: s.baseTone,
    pinyin: s.expectedTone === s.baseTone ? s.pinyin : withTone(s.pinyin, s.expectedTone),
    spoken: s.expectedTone,
  }));
}

/**
 * The prompt list, in order: part "right" (say it as shown: the singles,
 * then the phrases), then part "wrong" (the same syllable in another tone,
 * on purpose). `hasClip(text)` says whether a model clip is cached; a
 * prompt without one is left out, since a beginner can't be asked to say
 * what they haven't heard.
 *
 * A prompt: { id, part, text, syllables, gloss, said, model }. `said` is
 * "" for part one and the labels' `said` for part two ("ma2": what the
 * speaker was asked to say); `model` is the text whose clip is the model
 * (for part two, the character that really has that tone).
 */
export function buildPrompts(hasClip = () => true) {
  const prompts = [];
  for (const text of [...SINGLES, ...PHRASES]) {
    const syllables = card(text);
    if (!syllables || !hasClip(text)) continue;
    prompts.push({ part: "right", text, syllables, gloss: GLOSS[text] ?? "", said: "", model: text });
  }
  SWAPS.forEach(([from, to], i) => {
    const group = SINGLES.slice((i % 4) * 4, (i % 4) * 4 + 4);
    const text = group[from - 1];
    const model = group[to - 1];
    const ref = card(text);
    const other = card(model);
    if (!ref || !other || !hasClip(model)) return;
    prompts.push({
      part: "wrong", text, syllables: ref, gloss: GLOSS[text] ?? "", said: `${strip(ref[0].written)}${to}`, model,
      ask: { pinyin: other[0].pinyin, tone: to },
    });
  });
  let right = 0;
  let wrong = 0;
  return prompts.map((p) => ({ id: p.part === "right" ? `r${String(++right).padStart(2, "0")}` : `w${String(++wrong).padStart(2, "0")}`, ...p }));
}

/* ---------------------------------- labels ---------------------------------- */

export const GROUPS = ["adult", "child"];
export const LABELS_HEADER = "# file\ttext\tsaid\tspeaker\tgroup\tunsure";

/** A speaker's name as stored: letters, digits, spaces, - and _, at most
 *  24 characters. Null when nothing usable is left. It goes into a TSV
 *  cell and onto the report, never into a path. */
export function cleanSpeaker(name) {
  const s = String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N} _-]/gu, " ").replace(/\s+/g, " ").trim();
  const cut = [...s].slice(0, 24).join("").trim();
  return cut || null;
}

/** One cell: no tabs or line breaks can survive, whatever came in. */
const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

/** A row → its labels.tsv line. */
export function formatLabel({ file, text, said = "", speaker = "", group = "", unsure = false }) {
  return [cell(file), cell(text), cell(said), cell(speaker), GROUPS.includes(group) ? group : "", unsure ? "unsure" : ""].join("\t");
}

/**
 * labels.tsv → rows. Tab-separated, `#` lines and blank lines skipped:
 *
 *   file  text  said  speaker  group  unsure
 *
 * Only the first two are required, so a hand-written file from before the
 * recorder (file, text, said, speaker) still reads. `said` is what the
 * speaker was asked to say when that isn't the text: one pinyin syllable
 * per character with the tone as a digit. `group` is adult or child;
 * `unsure` is the speaker's own "not sure I said it right" (any of unsure,
 * yes, 1, true, x). A line that can't be used is reported, never guessed.
 */
export function parseLabels(tsv) {
  const rows = [];
  const problems = [];
  String(tsv ?? "").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const [file = "", text = "", said = "", speaker = "", group = "", unsure = ""] = line.split("\t").map((x) => x.trim());
    if (!file || !text) return problems.push(`line ${i + 1}: needs a file and a text`);
    if (group && !GROUPS.includes(group)) return problems.push(`line ${i + 1}: group must be adult or child`);
    rows.push({ file, text, said, speaker: speaker || "speaker", group, unsure: /^(unsure|yes|1|true|x)$/i.test(unsure) });
  });
  return { rows, problems };
}

/** `said` → one tone per syllable (0 for neutral), or null when it is
 *  empty. Throws when a syllable carries no readable tone. */
export function saidTones(said) {
  if (!String(said ?? "").trim()) return null;
  return said.trim().split(/\s+/).map((x) => {
    const digit = x.match(/([0-5])$/);
    return digit ? Number(digit[1]) % 5 : parsePinyin(x).tone;
  });
}

/** What makes a prompt done for a speaker: the text and what was asked. */
export const promptKey = ({ text, said = "" }) => `${text}\t${said}`;

/** The prompts a speaker has already kept, from the labels alone, so a
 *  session can stop and resume with no other state. */
export function doneKeys(rows, speaker) {
  return new Set(rows.filter((r) => r.speaker === speaker).map(promptKey));
}

/* ----------------------------------- files ---------------------------------- */

const FILE_RE = /^rec-\d{8}-\d{6}-[0-9a-f]{8}\.wav$/;

/** A recording's file name, from the clock and random bytes only. */
export function newFileName(now = new Date(), randomHex = "") {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const hex = /^[0-9a-f]{8}$/.test(randomHex) ? randomHex : [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rec-${stamp}-${hex}.wav`;
}
export const isRecordingName = (name) => FILE_RE.test(String(name));

/** The longest clip the recorder keeps: the page stops at 12 seconds. */
export const MAX_CLIP_SECONDS = 15;
export const MIN_CLIP_SECONDS = 0.3;
export const CLIP_RATE = 16_000;
export const MAX_UPLOAD_BYTES = 44 + MAX_CLIP_SECONDS * CLIP_RATE * 2;

/**
 * Is this the WAV the page writes (web/src/recorder.ts toWav, copied into
 * the page): a 44-byte header, PCM, mono, 16 kHz, 16 bits, and between
 * 0.3 and 15 seconds of samples? Returns { ok, seconds } or { ok: false,
 * error }. Stricter than the engine's parseWav on purpose: only one
 * writer ever posts here, so anything else is a mistake or not ours.
 */
export function checkWav(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? []);
  const fail = (error) => ({ ok: false, error });
  if (u8.length > MAX_UPLOAD_BYTES) return fail("the recording is too long");
  if (u8.length < 44) return fail("not a WAV file");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") return fail("not a WAV file");
  if (view.getUint16(20, true) !== 1 || view.getUint16(34, true) !== 16) return fail("the WAV must be 16-bit PCM");
  if (view.getUint16(22, true) !== 1) return fail("the WAV must be mono");
  if (view.getUint32(24, true) !== CLIP_RATE) return fail("the WAV must be 16 kHz");
  const bytes = u8.length - 44;
  if (view.getUint32(40, true) !== bytes || bytes % 2) return fail("the WAV's length doesn't match its header");
  const seconds = bytes / 2 / CLIP_RATE;
  if (seconds < MIN_CLIP_SECONDS) return fail("the recording is too short");
  return { ok: true, seconds };
}

/* ---------------------------------- readout --------------------------------- */

/** The scorer's result in plain words, one piece per syllable, for the
 *  page's test readout. Not a grade: the wording stays with what was
 *  measured ("heard tone 2, expected tone 1", "not sure"). */
export function readout(result) {
  if (!result?.syllables?.length) return "no result";
  const one = (s) => {
    if (s.reason === "neutral") return "neutral tone, not judged";
    const expected = `expected tone ${s.accept?.filter((t) => t > 0).join(" or ") || s.expectedTone}`;
    if (s.verdict === "ok") return `heard tone ${s.heardTone}, ${expected}: matches`;
    if (s.verdict === "off") return `heard tone ${s.heardTone}, ${expected}: flagged`;
    return s.heardTone ? `not sure (closest: tone ${s.heardTone}, ${expected})` : `not sure (${s.reason === "unvoiced" || s.reason === "short" ? "too little voice to read" : "couldn't find the syllable"})`;
  };
  return result.syllables.length === 1 ? one(result.syllables[0]) : result.syllables.map((s) => `${s.char} ${one(s)}`).join("; ");
}

/* ----------------------------------- tally ---------------------------------- */

const cellTally = () => ({ ok: 0, unsure: 0, off: 0 });

/**
 * Per speaker, from scored syllables: `marks` is one entry per judged
 * syllable, { speaker, group, unsure, wrong, verdict }. `wrong` means the
 * speaker was asked for a tone the text doesn't accept, so an "off" there
 * is a catch; on any other syllable an "off" is a false alarm. Syllables
 * from clips the speaker marked "not sure I said it right" are counted
 * apart (`doubted`): their label is the aim, and the aim may have missed.
 * Every syllable is in exactly one of the two, so the table's counts add up
 * to the totals only when both halves are added.
 */
export function speakerTally(marks) {
  const by = new Map();
  for (const m of marks) {
    if (!by.has(m.speaker)) by.set(m.speaker, { speaker: m.speaker, group: m.group || "", sure: { right: cellTally(), wrong: cellTally() }, doubted: { right: cellTally(), wrong: cellTally() } });
    const s = by.get(m.speaker);
    if (!s.group && m.group) s.group = m.group;
    s[m.unsure ? "doubted" : "sure"][m.wrong ? "wrong" : "right"][m.verdict]++;
  }
  return [...by.values()];
}

const total = (c) => c.ok + c.unsure + c.off;
const share = (k, n) => (n ? `${k} of ${n} (${((100 * k) / n).toFixed(0)}%)` : "none recorded");

/** The per-speaker section as markdown table lines. */
export function speakerTable(tally) {
  const rows = tally.map((s) => `| ${s.speaker} | ${s.group || "–"} | ${share(s.sure.wrong.off, total(s.sure.wrong))} | ${share(s.sure.right.off, total(s.sure.right))} | ${share(s.sure.right.unsure, total(s.sure.right))} | ${share(s.doubted.wrong.off, total(s.doubted.wrong))} | ${share(s.doubted.right.off, total(s.doubted.right))} |`);
  return [
    "| Speaker | Group | Clips kept without doubt, wrong on purpose: caught | Clips kept without doubt, said as shown: flagged (false alarms) | Clips kept without doubt, said as shown: scorer not sure | Clips marked \"not sure\", wrong on purpose: caught | Clips marked \"not sure\", said as shown: flagged |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];
}
