// The recording tool for the pronunciation proof: its pure rules
// (scripts/pronunciation-recordings.mjs) and its HTTP handler
// (scripts/pronunciation-record.mjs) mounted on a throwaway loopback port,
// with synthesized audio and temporary folders. No microphone, no real
// recordings folder, no network beyond 127.0.0.1.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { encodeWav } from "../pronunciation.mjs";
import {
  LABELS_HEADER, MAX_UPLOAD_BYTES, PAGE_FUNCTIONS, PHRASES, SINGLES, buildPrompts, checkWav, cleanSpeaker, doneKeys, findSpeaker, formatLabel, isRecordingName, keyAction, newFileName, parseLabels,
  processingOf, promptKey, readout, recordingsReport, saidTones, speakerTable, speakerTally,
} from "../pronunciation-recordings.mjs";
import { createRecorder, loopbackHost, trackedByGit } from "../pronunciation-record.mjs";

/** A voiced syllable: a glide from one pitch to another with a few
 *  harmonics, 16 kHz. */
function tone(fromHz, toHz, seconds = 0.5, rate = 16_000) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = fromHz + ((toHz - fromHz) * i) / n;
    phase += (2 * Math.PI * f) / rate;
    const env = Math.min(1, i / 400, (n - i) / 400);
    out[i] = 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
  }
  return out;
}
const wav = (fromHz = 200, toHz = 200, seconds = 0.5) => Buffer.from(encodeWav(tone(fromHz, toHz, seconds), 16_000));

describe("the prompt list", () => {
  const prompts = buildPrompts();

  it("asks for every single syllable and phrase as shown, then twelve wrong on purpose", () => {
    const right = prompts.filter((p) => p.part === "right");
    const wrong = prompts.filter((p) => p.part === "wrong");
    assert.deepEqual(right.map((p) => p.text), [...SINGLES, ...PHRASES]);
    assert.equal(wrong.length, 12);
    // Part two comes after all of part one.
    assert.equal(prompts.findIndex((p) => p.part === "wrong"), right.length);
    assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length);
    assert.equal(new Set(prompts.map(promptKey)).size, prompts.length);
    for (const p of prompts) assert.match(p.id, /^[rw]\d{2}$/);
    for (const p of right) assert.ok(p.gloss, `${p.text} has an English meaning`);
  });

  it("shows pinyin, tone numbers and the tone as said in the phrase", () => {
    const ma = prompts.find((p) => p.text === "妈" && p.part === "right");
    assert.deepEqual(ma.syllables, [{ char: "妈", written: "mā", tone: 1, pinyin: "mā", spoken: 1 }]);
    assert.equal(ma.said, "");
    // 你 is a third tone that is said as a second before another third.
    const nihao = prompts.find((p) => p.text === "你好");
    assert.deepEqual(nihao.syllables.map((s) => [s.written, s.tone, s.pinyin, s.spoken]), [["nǐ", 3, "ní", 2], ["hǎo", 3, "hǎo", 3]]);
  });

  it("a wrong-on-purpose prompt names the reference word, the tone to say and that tone's model clip", () => {
    const wrong = prompts.filter((p) => p.part === "wrong");
    const pairs = new Set();
    for (const p of wrong) {
      const group = SINGLES.slice(Math.floor(SINGLES.indexOf(p.text) / 4) * 4).slice(0, 4);
      const from = group.indexOf(p.text) + 1;
      const to = group.indexOf(p.model) + 1;
      assert.ok(to >= 1 && to !== from, `${p.text} is modelled by another tone of the same syllable`);
      assert.equal(p.syllables[0].tone, from);
      assert.equal(p.ask.tone, to);
      assert.match(p.said, new RegExp(`^(ma|shi|yi|ba)${to}$`));
      assert.deepEqual(saidTones(p.said), [to]);
      pairs.add(`${from}>${to}`);
    }
    // Every confusion of two tones, once.
    assert.equal(pairs.size, 12);
    const first = wrong.find((p) => p.text === "妈");
    assert.deepEqual([first.said, first.model, first.ask.pinyin], ["ma2", "麻", "má"]);
  });

  it("leaves out a prompt with no cached model clip", () => {
    const some = buildPrompts((text) => text !== "麻" && text !== "你好");
    assert.ok(!some.some((p) => p.part === "right" && (p.text === "麻" || p.text === "你好")));
    assert.ok(!some.some((p) => p.model === "麻"));
    assert.ok(some.some((p) => p.part === "wrong" && p.text === "麻"), "麻 can still be the reference of a prompt modelled by another clip");
    assert.equal(some.filter((p) => p.part === "right").length, 29);
    // An id names the same prompt whatever was left out: it is the place
    // in the whole list, not in what remains.
    const whole = new Map(buildPrompts().map((p) => [p.id, promptKey(p)]));
    for (const p of some) assert.equal(promptKey(p), whole.get(p.id), p.id);
    assert.deepEqual(buildPrompts(() => false), []);
  });
});

describe("labels.tsv", () => {
  it("writes a row and reads it back", () => {
    const rows = [
      { file: "rec-20261118-153012-ab12cd34.wav", text: "妈", said: "ma2", speaker: "Sam", group: "adult", unsure: false, processing: "raw" },
      { file: "rec-20261118-153140-0f3e9a71.wav", text: "我是学生", said: "", speaker: "小明", group: "child", unsure: true, processing: "processed" },
    ];
    const tsv = [LABELS_HEADER, ...rows.map(formatLabel), ""].join("\n");
    assert.deepEqual(parseLabels(tsv), { rows, problems: [] });
  });

  it("reads the hand-written format from before the recorder", () => {
    const { rows, problems } = parseLabels("# file\ttext\tsaid\tspeaker\r\nnihao-1.wav\t你好\n\nma-wrong.wav\t妈\tma3\nx.m4a\t我是学生\two3 shi4 xue2 sheng2\tsam\n");
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, [
      { file: "nihao-1.wav", text: "你好", said: "", speaker: "speaker", group: "", unsure: false, processing: "processed" },
      { file: "ma-wrong.wav", text: "妈", said: "ma3", speaker: "speaker", group: "", unsure: false, processing: "processed" },
      { file: "x.m4a", text: "我是学生", said: "wo3 shi4 xue2 sheng2", speaker: "sam", group: "", unsure: false, processing: "processed" },
    ]);
    // The recorder's first files had six columns and no `processing`:
    // those clips were recorded with the browser's processing on.
    const six = parseLabels("# file\ttext\tsaid\tspeaker\tgroup\tunsure\nrec-20261118-153012-ab12cd34.wav\t妈\t\tsam\tadult\t\nrec-20261118-153140-0f3e9a71.wav\t妈\tma2\tsam\tadult\tunsure\n");
    assert.deepEqual(six.problems, []);
    assert.deepEqual(six.rows.map((r) => [r.said, r.unsure, r.processing]), [["", false, "processed"], ["ma2", true, "processed"]]);
    assert.deepEqual(parseLabels("a.wav\t妈\t\tsam\tadult\t\traw").rows[0].processing, "raw");
    assert.equal(parseLabels("a.wav\t妈\t\tsam\tadult\t\tloud").problems.length, 1);
    assert.deepEqual(saidTones(rows[2].said), [3, 4, 2, 2]);
    assert.deepEqual(saidTones("ma5 mǎ"), [0, 3]);
    assert.equal(saidTones(""), null);
  });

  it("reports a line it can't use and never lets a cell break the table", () => {
    const { rows, problems } = parseLabels("only-a-file.wav\na.wav\t妈\t\tsam\tteenager\n");
    assert.deepEqual(rows, []);
    assert.equal(problems.length, 2);
    const line = formatLabel({ file: "a.wav", text: "妈", said: "", speaker: "sam\tadult\nb.wav\t马", group: "pirate", unsure: 1 });
    assert.equal(line.split("\n").length, 1);
    assert.equal(line.split("\t").length, 7);
    assert.deepEqual(parseLabels(line).rows, [{ file: "a.wav", text: "妈", said: "", speaker: "sam adult b.wav 马", group: "", unsure: true, processing: "processed" }]);
  });

  it("derives what a speaker has done from the rows alone", () => {
    const { rows } = parseLabels(["a.wav\t妈\t\tsam", "b.wav\t妈\tma2\tsam", "c.wav\t马\t\tkim"].join("\n"));
    const done = doneKeys(rows, "sam");
    assert.ok(done.has(promptKey({ text: "妈", said: "" })));
    assert.ok(done.has(promptKey({ text: "妈", said: "ma2" })));
    assert.ok(!done.has(promptKey({ text: "马", said: "" })));
    assert.equal(doneKeys(rows, "nobody").size, 0);
  });

  it("knows a speaker under any capitals, with the group first given", () => {
    const { rows } = parseLabels(["a.wav\t妈\t\tSam\tadult", "b.wav\t马\t\tsam\tadult", "c.wav\t马\t\tKim"].join("\n"));
    assert.deepEqual(findSpeaker(rows, "SAM"), { name: "Sam", group: "adult" });
    assert.deepEqual(findSpeaker(rows, "kim"), { name: "Kim", group: "" });
    assert.equal(findSpeaker(rows, "sa"), null);
  });
});

describe("names", () => {
  it("a speaker's name is plain text of at most 24 characters, or nothing", () => {
    assert.equal(cleanSpeaker("  Sam  "), "Sam");
    assert.equal(cleanSpeaker("小明"), "小明");
    assert.equal(cleanSpeaker("../../etc/passwd"), "etc passwd");
    assert.equal(cleanSpeaker("# sam\tadult\n"), "sam adult");
    assert.equal(cleanSpeaker("<script>"), "script");
    assert.equal([...cleanSpeaker("x".repeat(100))].length, 24);
    for (const empty of ["", "   ", "../", "\t\n", null, undefined]) assert.equal(cleanSpeaker(empty), null);
  });

  it("a recording's file name comes from the clock and random bytes only", () => {
    const name = newFileName(new Date("2026-11-18T15:30:12Z"), "ab12cd34");
    assert.equal(name, "rec-20261118-153012-ab12cd34.wav");
    assert.ok(isRecordingName(name));
    assert.ok(isRecordingName(newFileName()));
    assert.notEqual(newFileName(), newFileName());
    // Random bytes that aren't eight hex digits are not trusted.
    assert.ok(isRecordingName(newFileName(new Date(), "../../x")));
    for (const bad of ["../rec-20261118-153012-ab12cd34.wav", "rec-20261118-153012-ab12cd34.wav/..", "rec-20261118-153012-AB12CD34.wav", "sam.wav", "rec-20261118-153012-ab12cd34.mp3", ""]) assert.ok(!isRecordingName(bad), bad);
  });
});

describe("the uploaded WAV", () => {
  it("is 16 kHz mono 16-bit PCM of a sensible length", () => {
    const ok = checkWav(wav());
    assert.equal(ok.ok, true);
    assert.ok(Math.abs(ok.seconds - 0.5) < 0.01);
    assert.equal(checkWav(new Uint8Array(wav())).ok, true);
  });

  it("refuses anything else, with a reason", () => {
    const patched = (at, bytes, value) => {
      const b = Buffer.from(wav());
      if (bytes === 2) b.writeUInt16LE(value, at);
      else b.writeUInt32LE(value, at);
      return b;
    };
    assert.match(checkWav(Buffer.from(encodeWav(tone(200, 200, 0.5, 44_100), 44_100))).error, /16 kHz/);
    assert.match(checkWav(patched(22, 2, 2)).error, /mono/);
    assert.match(checkWav(patched(20, 2, 3)).error, /16-bit PCM/);
    assert.match(checkWav(patched(34, 2, 8)).error, /16-bit PCM/);
    assert.match(checkWav(wav(200, 200, 0.1)).error, /too short/);
    assert.match(checkWav(wav().subarray(0, 4000)).error, /length/);
    assert.match(checkWav(Buffer.concat([wav(), Buffer.alloc(2)])).error, /length/);
    // The sizes the header states: the RIFF chunk and the fmt chunk.
    assert.match(checkWav(patched(4, 4, 12)).error, /length/);
    assert.match(checkWav(patched(16, 4, 18)).error, /not a WAV/);
    assert.match(checkWav(Buffer.alloc(MAX_UPLOAD_BYTES + 2)).error, /too long/);
    assert.match(checkWav(Buffer.from("ID3 this is an mp3, honestly, with more than forty-four bytes in it")).error, /not a WAV/);
    assert.match(checkWav(Buffer.alloc(10)).error, /not a WAV/);
    assert.match(checkWav(null).error, /not a WAV/);
  });
});

describe("the readout and the per-speaker tally", () => {
  it("says what was heard in plain words", () => {
    assert.equal(readout({ syllables: [{ char: "妈", verdict: "off", heardTone: 2, expectedTone: 1, accept: [1] }] }), "heard tone 2, expected tone 1: flagged");
    assert.equal(readout({ syllables: [{ char: "妈", verdict: "ok", heardTone: 1, expectedTone: 1, accept: [1] }] }), "heard tone 1, expected tone 1: matches");
    assert.equal(readout({ syllables: [{ char: "妈", verdict: "unsure", reason: "unvoiced", expectedTone: 1, accept: [1] }] }), "not sure (too little voice to read)");
    assert.equal(
      readout({ syllables: [{ char: "我", verdict: "unsure", reason: "unclear", heardTone: 3, expectedTone: 2, accept: [2, 3] }, { char: "么", verdict: "unsure", reason: "neutral", expectedTone: 0, accept: [0] }] }),
      "我 not sure (closest: tone 3, expected tone 2 or 3); 么 neutral tone, not judged",
    );
    assert.equal(readout(null), "no result");
  });

  it("counts catches and false alarms per speaker, the doubted clips apart", () => {
    const m = (speaker, group, unsure, wrong, verdict) => ({ speaker, group, unsure, wrong, verdict });
    const tally = speakerTally([
      m("sam", "adult", false, true, "off"), m("sam", "adult", false, true, "ok"), m("sam", "adult", false, true, "unsure"), m("sam", "adult", false, true, "off"),
      m("sam", "adult", false, false, "ok"), m("sam", "adult", false, false, "off"), m("sam", "adult", false, false, "unsure"),
      m("sam", "adult", true, false, "off"), m("sam", "adult", true, false, "ok"),
      m("kim", "child", false, false, "ok"),
    ]);
    assert.deepEqual(tally.map((s) => [s.speaker, s.group]), [["sam", "adult"], ["kim", "child"]]);
    assert.deepEqual(tally[0].sure, { right: { ok: 1, unsure: 1, off: 1 }, wrong: { ok: 1, unsure: 1, off: 2 } });
    assert.deepEqual(tally[0].doubted, { right: { ok: 1, unsure: 0, off: 1 }, wrong: { ok: 0, unsure: 0, off: 0 } });
    const table = speakerTable(tally);
    assert.equal(table.length, 4);
    assert.equal(table[2], "| sam | adult | 2 of 4 (50%) | 1 of 3 (33%) | 1 of 3 (33%) | none recorded | 1 of 2 (50%) |");
    assert.equal(table[3], "| kim | child | none recorded | 0 of 1 (0%) | 0 of 1 (0%) | none recorded | none recorded |");
  });
});

describe("the recordings report", () => {
  const m = (speaker, unsure, wrong, verdict, processing = "processed") => ({ speaker, group: "adult", unsure, wrong, verdict, processing });
  const marks = [
    m("sam", false, false, "ok"), m("sam", false, false, "ok"), m("sam", false, false, "off"), m("sam", false, false, "unsure"),
    m("sam", false, true, "off"), m("sam", false, true, "unsure"),
    m("sam", true, false, "ok"), m("sam", true, true, "ok"),
  ];

  it("gives the sure clips and the doubted ones as the same split its table uses", () => {
    const rep = recordingsReport({ clips: 6, marks, detail: ["| a.wav | sam | 妈 | as shown |  | processed | 妈 ok |"], problems: ["b.wav: not a WAV file"], date: "2026-11-18" });
    for (const text of [rep.markdown, rep.console]) {
      assert.ok(text.includes("6 recordings from `labels.tsv`, 1 speaker(s), 8 judged syllables."));
      assert.ok(text.includes("In clips kept without doubt: said as shown 4 (ok 2, flagged 1, scorer not sure 1); said wrong on purpose 2 (caught 1, passed as ok 0, scorer not sure 1)."));
      assert.ok(text.includes("counted apart: said as shown 1 (ok 1, flagged 0, scorer not sure 0); said wrong on purpose 1 (caught 0, passed as ok 1, scorer not sure 0)."));
      // The table's denominators are the summary's numbers.
      assert.ok(text.includes("| sam | adult | 1 of 2 (50%) | 1 of 4 (25%) | 1 of 4 (25%) | 0 of 1 (0%) | 0 of 1 (0%) |"));
      assert.ok(text.includes("Not scored: b.wav: not a WAV file."));
      assert.ok(!text.includes("recording setting"), "one setting: no second table");
    }
    assert.ok(rep.markdown.includes("| a.wav | sam | 妈 | as shown |  | processed | 妈 ok |"));
    assert.ok(rep.markdown.includes("on 2026-11-18"));
    assert.ok(recordingsReport({ clips: 1, marks: marks.slice(0, 2), date: "2026-11-18" }).markdown.includes("No clip was marked"));
  });

  it("splits each speaker by recording setting once both exist", () => {
    const both = [...marks, m("sam", false, false, "ok", "raw"), m("sam", false, true, "off", "raw")];
    const rep = recordingsReport({ clips: 8, marks: both, date: "2026-11-18" });
    for (const text of [rep.markdown, rep.console]) {
      assert.ok(text.includes("| Speaker, recording setting |"));
      assert.ok(text.includes("| sam, processed | adult | 1 of 2 (50%) | 1 of 4 (25%) | 1 of 4 (25%) | 0 of 1 (0%) | 0 of 1 (0%) |"));
      assert.ok(text.includes("| sam, raw | adult | 1 of 1 (100%) | 0 of 1 (0%) | 0 of 1 (0%) | none recorded | none recorded |"));
    }
    assert.ok(rep.markdown.includes("## By recording setting"));
  });
});

describe("the page's keys", () => {
  const act = (code, focus, state) => keyAction({ code, key: code === "Space" ? " " : code === "Enter" ? "Enter" : code.replace("Key", "").toLowerCase(), focus, state });

  it("space records and stops, over a focused button too; only the checkbox keeps it", () => {
    for (const focus of ["none", "button"]) {
      assert.deepEqual(act("Space", focus, "idle"), { action: "record", prevent: true }, focus);
      assert.deepEqual(act("Space", focus, "review"), { action: "record", prevent: true }, focus);
      assert.deepEqual(act("Space", focus, "recording"), { action: "stop", prevent: true }, focus);
      // Busy: nothing happens, and above all the focused button (Skip,
      // after a mouse click) is not pressed.
      for (const state of ["working", "saving"]) assert.deepEqual(act("Space", focus, state), { action: null, prevent: true }, `${focus} ${state}`);
    }
    for (const state of ["idle", "recording", "working", "review", "saving"]) {
      assert.deepEqual(act("Space", "checkbox", state), { action: null, prevent: false }, state);
      assert.deepEqual(act("Space", "text", state), { action: null, prevent: false }, state);
    }
  });

  it("enter keeps a take, except over a button, which it presses", () => {
    assert.deepEqual(act("Enter", "none", "review"), { action: "keep", prevent: true });
    assert.deepEqual(act("Enter", "checkbox", "review"), { action: "keep", prevent: true });
    assert.deepEqual(act("Enter", "button", "review"), { action: null, prevent: false });
    for (const state of ["idle", "recording", "working", "saving"]) assert.equal(act("Enter", "none", state).action, null, state);
  });

  it("the model is never played while the microphone records, the tail after Stop included", () => {
    assert.equal(act("KeyL", "none", "idle").action, "listen");
    assert.equal(act("KeyL", "button", "review").action, "listen");
    for (const state of ["recording", "working", "saving"]) assert.equal(act("KeyL", "none", state).action, null, state);
    assert.equal(act("KeyP", "none", "review").action, "play");
    assert.equal(act("KeyP", "none", "idle").action, null);
    assert.equal(act("KeyN", "none", "review").action, "unsure");
    assert.equal(act("KeyN", "none", "recording").action, null);
    assert.equal(act("KeyL", "text", "idle").action, null);
    assert.equal(act("KeyX", "none", "review").action, null);
  });

  it("a clip is raw only when the browser says all three kinds of processing are off", () => {
    assert.equal(processingOf({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }), "raw");
    assert.equal(processingOf({ echoCancellation: false, noiseSuppression: true, autoGainControl: false }), "processed");
    assert.equal(processingOf({ echoCancellation: false, noiseSuppression: false }), "processed");
    assert.equal(processingOf({}), "processed");
    assert.equal(processingOf(null), "processed");
  });

  it("the page gets these functions' own source", () => {
    assert.ok(PAGE_FUNCTIONS.includes(String(keyAction)) && PAGE_FUNCTIONS.includes(String(processingOf)));
    // What the page runs is what was tested: the source evaluates to a
    // function that answers the same.
    const again = new Function(`${PAGE_FUNCTIONS}; return { keyAction, processingOf };`)();
    assert.deepEqual(again.keyAction({ code: "Space", key: " ", focus: "button", state: "idle" }), { action: "record", prevent: true });
    assert.equal(again.processingOf({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }), "raw");
  });
});

describe("the recorder's HTTP handler", () => {
  let tmp;
  let dir;
  let server;
  let port;
  let recorder;

  /** A raw request, so the test controls Host and Origin. */
  function call({ method = "GET", url = "/", headers = {}, body = null, host = null, at = port }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: at, method, path: url, headers: { Host: host ?? `127.0.0.1:${at}`, ...headers, ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            // Not JSON: the page or a clip.
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      });
      // A refused upload may be answered and closed before it is all sent:
      // the write then fails (EPIPE) a moment before the answer is read,
      // so an error only counts if no answer follows it.
      req.on("error", (e) => setTimeout(() => reject(e), 500));
      req.end(body ?? undefined);
    });
  }
  /** A keep as the page posts it: the prompt's id with its text and what
   *  was asked, and how the microphone was recorded. */
  const keep = (query, body = wav(180, 260), headers = {}, at = port) => {
    const prompt = recorder.prompts.find((p) => p.id === query.prompt);
    const q = { ...(prompt ? { text: prompt.text, said: prompt.said } : {}), processing: "raw", ...query };
    for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
    return call({ method: "POST", url: `/api/keep?${new URLSearchParams(q)}`, headers: { Origin: `http://127.0.0.1:${at}`, "Content-Type": "audio/wav", ...headers }, body, at });
  };
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  let clipsDir;
  const others = [];
  /** A second recorder over the same clips with a recordings folder of
   *  its own, for tests that prepare labels.tsv by hand. */
  async function mount(name, options = {}) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    const srv = http.createServer(createRecorder({ dir: d, clipsDir, ...options }).handler);
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    others.push(srv);
    return { dir: d, at: srv.address().port };
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-record-"));
    dir = path.join(tmp, "recordings");
    // A clip cache with one voice that lacks 你好, and a second that has
    // only 麻: the finder falls through the voices in order.
    const clips = path.join(tmp, "clips");
    fs.mkdirSync(path.join(clips, "say-tingting"), { recursive: true });
    fs.mkdirSync(path.join(clips, "say-reed"), { recursive: true });
    for (const text of [...SINGLES, ...PHRASES]) {
      if (text === "你好" || text === "麻") continue;
      fs.writeFileSync(path.join(clips, "say-tingting", `${text}.wav`), wav(220, 220));
    }
    fs.writeFileSync(path.join(clips, "say-reed", "麻.wav"), wav(110, 160));
    clipsDir = clips;
    recorder = createRecorder({ dir, clipsDir: clips });
    server = http.createServer(recorder.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const srv of others) await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("knows a loopback host from any other", () => {
    assert.ok(loopbackHost("127.0.0.1:38410", 38410));
    assert.ok(loopbackHost("localhost:38410", 38410));
    for (const host of ["127.0.0.1:38400", "evil.example:38410", "127.0.0.1.evil.example:38410", "192.168.1.5:38410", "", "127.0.0.1"]) assert.ok(!loopbackHost(host, 38410), host);
  });

  it("serves one self-contained page that may load nothing from elsewhere", async () => {
    const res = await call({});
    assert.equal(res.status, 200);
    const html = res.raw.toString("utf8");
    const csp = res.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.ok(!html.includes("__NONCE__") && !html.includes("__DATA__") && !html.includes("__SHARED__"));
    // The key handling and the label's recording setting are the tested
    // functions, and the page uses them.
    assert.ok(html.includes(PAGE_FUNCTIONS));
    assert.match(html, /keyAction\(\{ code: e\.code, key: e\.key, focus: focusKind\(\), state: state \}\)/);
    assert.match(html, /processing = processingOf\(/);
    // Listen plays only when nothing is being recorded; Skip gives the
    // focus back after a click.
    assert.match(html, /function listen\(\) \{ if \(current && \(state === "idle" \|\| state === "review"\)\)/);
    assert.match(html, /\$\("skip"\)\.addEventListener\("click", function \(\) \{ this\.blur\(\);/);
    // No link, script, image, font or stylesheet from another origin: the
    // only URL in the page is the SVG namespace, which is never fetched.
    assert.deepEqual([...new Set(html.match(/https?:\/\/[^\s"'<)]+/g))], ["http://www.w3.org/2000/svg"]);
    assert.ok(!/<(link|img|iframe)\b/.test(html) && !/\ssrc=/.test(html));
    const data = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
    assert.deepEqual(data.prompts, recorder.prompts);
    // 你好 has no clip in any voice; 麻 has one in the second voice.
    assert.ok(!data.prompts.some((p) => p.text === "你好"));
    assert.ok(data.prompts.some((p) => p.text === "麻" && p.part === "right"));
    assert.equal(data.prompts.length, 30 + 12);
    // A second load gets its own nonce.
    assert.notEqual((await call({})).headers["content-security-policy"], csp);
  });

  it("answers only to its loopback name", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
      assert.equal((await call({ host })).status, 403, host);
      assert.equal((await call({ url: "/api/speakers", host })).status, 403, host);
    }
    assert.equal((await call({ host: `localhost:${port}` })).status, 200);
  });

  it("plays the cached model clip of a prompt, and of the other tone for a wrong-on-purpose one", async () => {
    const wrongMa = recorder.prompts.find((p) => p.part === "wrong" && p.text === "妈");
    const res = await call({ url: `/model/${wrongMa.id}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "audio/wav");
    // 麻's clip, which only the second voice has.
    assert.ok(res.raw.equals(wav(110, 160)));
    for (const url of ["/model/r99", "/model/..%2f..%2fpackage.json", "/model/妈", "/package.json", "/recordings/labels.tsv"]) assert.equal((await call({ url: encodeURI(url) })).status, 404, url);
    assert.equal((await call({ method: "DELETE", url: "/" })).status, 405);
  });

  it("takes a POST from its own page only", async () => {
    const q = { prompt: "r01", speaker: "sam", group: "adult" };
    assert.equal((await keep(q, wav(), { Origin: "http://evil.example" })).status, 403);
    assert.equal((await keep(q, wav(), { Origin: `http://127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await keep(q, wav(), { Origin: "null" })).status, 403);
    // No Origin at all: not a browser's POST from this page.
    assert.equal((await call({ method: "POST", url: `/api/keep?${new URLSearchParams(q)}`, headers: { "Content-Type": "audio/wav" }, body: wav() })).status, 403);
    assert.equal((await call({ method: "POST", url: "/api/other", headers: { Origin: `http://127.0.0.1:${port}` } })).status, 404);
    assert.deepEqual(files(), []);
  });

  it("refuses a bad upload without writing anything", async () => {
    const q = { prompt: "r01", speaker: "sam", group: "adult" };
    assert.equal((await keep({ ...q, prompt: "r99", text: "妈", said: "" })).status, 409);
    assert.equal((await keep({ ...q, prompt: "../x", text: "妈", said: "" })).status, 409);
    assert.equal((await keep({ ...q, speaker: "../" })).status, 400);
    assert.equal((await keep({ ...q, group: "robot" })).status, 400);
    assert.equal((await keep(q, wav(), { "Content-Type": "text/plain" })).status, 415);
    const short = await keep(q, wav(200, 200, 0.1));
    assert.deepEqual([short.status, short.json.error], [400, "the recording is too short"]);
    assert.equal((await keep(q, Buffer.from(encodeWav(tone(200, 200, 0.5, 44_100), 44_100)))).status, 400);
    assert.equal((await keep(q, Buffer.from("not audio at all, just some text that is longer than a header"))).status, 400);
    assert.equal((await keep(q, Buffer.alloc(MAX_UPLOAD_BYTES + 2))).status, 413);
    assert.deepEqual(files(), []);
  });

  it("keeps a clip: a generated file, a label, the progress, and a readout", async () => {
    const first = recorder.prompts[0];
    assert.equal(first.text, "妈");
    const before = await call({ url: "/api/progress?speaker=%20Sam%20" });
    assert.deepEqual(before.json, { speaker: "Sam", existing: null, done: [] });

    const res = await keep({ prompt: first.id, speaker: "Sam", group: "adult" }, wav(220, 222));
    assert.equal(res.status, 200);
    assert.equal(res.json.saved, true);
    assert.deepEqual(res.json.done, [promptKey(first)]);
    // The readout is the scorer's own words on a level tone for 妈 (tone 1).
    assert.equal(res.json.readout, "heard tone 1, expected tone 1: matches");

    const saved = files().filter((f) => f.endsWith(".wav"));
    assert.equal(saved.length, 1);
    assert.ok(isRecordingName(saved[0]));
    assert.ok(fs.readFileSync(path.join(dir, saved[0])).equals(wav(220, 222)));
    assert.equal(fs.statSync(path.join(dir, saved[0])).mode & 0o777, 0o600);
    const text = fs.readFileSync(path.join(dir, "labels.tsv"), "utf8");
    assert.equal(text, `${LABELS_HEADER}\n${saved[0]}\t妈\t\tSam\tadult\t\traw\n`);

    // A wrong-on-purpose clip from a child, marked not sure, with a name
    // that tries to be a path and a second row.
    const wrongMa = recorder.prompts.find((p) => p.part === "wrong" && p.text === "妈");
    const second = await keep({ prompt: wrongMa.id, speaker: "../kim\tchild\nx.wav\t马", group: "child", unsure: "1" }, wav(160, 260));
    assert.equal(second.status, 200);
    const { rows, problems } = parseLabels(fs.readFileSync(path.join(dir, "labels.tsv"), "utf8"));
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[1], file: "" }, { file: "", text: "妈", said: "ma2", speaker: "kim child x wav 马", group: "child", unsure: true, processing: "raw" });
    assert.ok(isRecordingName(rows[1].file));
    // Everything written is in the recordings folder, under generated names.
    assert.deepEqual(files().filter((f) => f !== "labels.tsv").every(isRecordingName), true);
    assert.deepEqual(fs.readdirSync(tmp).filter((f) => !f.startsWith("extra-")).sort(), ["clips", "recordings"]);

    const speakers = await call({ url: "/api/speakers" });
    assert.deepEqual(speakers.json.speakers, [{ name: "Sam", group: "adult", done: 1 }, { name: "kim child x wav 马", group: "child", done: 1 }]);
    const again = await call({ url: `/api/progress?speaker=${encodeURIComponent("Sam")}` });
    assert.deepEqual(again.json.done, [promptKey(first)]);
  });

  it("saves a clip the scorer can't read", async () => {
    // Half a second of silence: nothing voiced to read.
    const res = await keep({ prompt: "r02", speaker: "Sam", group: "adult" }, Buffer.from(encodeWav(new Float32Array(8000), 16_000)));
    assert.equal(res.status, 200);
    assert.equal(res.json.saved, true);
    assert.match(res.json.readout, /not sure/);
    assert.equal(res.json.done.length, 2);
  });

  it("files a clip under what the page says it is, or not at all", async () => {
    const q = { speaker: "Kay", group: "adult" };
    const stale = "This page is out of date with the recorder. Reload the page and record this one again.";
    const count = files().length;
    // The id is 妈's; the page thinks it was showing 马 (its list is from
    // before a restart with a different cache).
    const wrongText = await keep({ ...q, prompt: "r01", text: "马", said: "" });
    assert.deepEqual([wrongText.status, wrongText.json.error], [409, stale]);
    // The right text under another prompt's id, and the asked tone changed.
    assert.equal((await keep({ ...q, prompt: "r03", text: "妈", said: "" })).status, 409);
    assert.equal((await keep({ ...q, prompt: "w01", text: "妈", said: "ma3" })).status, 409);
    // A page from before the text was posted, or the recording setting.
    assert.equal((await keep({ ...q, prompt: "r01", text: undefined, said: undefined })).status, 409);
    assert.equal((await keep({ ...q, prompt: "r01", processing: undefined })).status, 409);
    assert.equal((await keep({ ...q, prompt: "r01", processing: "studio" })).status, 409);
    assert.equal(files().length, count);
    assert.deepEqual((await call({ url: "/api/progress?speaker=Kay" })).json, { speaker: "Kay", existing: null, done: [] });
  });

  it("a name already recorded is that person under any capitals, in the group first given", async () => {
    // "Sam" (adult) is in the labels from the test above.
    const asked = await call({ url: "/api/progress?speaker=sAM" });
    assert.deepEqual([asked.json.speaker, asked.json.existing], ["Sam", { name: "Sam", group: "adult" }]);
    assert.ok(asked.json.done.length >= 1);
    // Never moved to another group…
    const moved = await keep({ prompt: "r03", speaker: "sam", group: "child" });
    assert.equal(moved.status, 409);
    assert.match(moved.json.error, /Sam is already recorded as an adult/);
    // …and a clip kept under other capitals is stored under the first name.
    const kept = await keep({ prompt: "r03", speaker: "SAM", group: "adult" }, wav(120, 121));
    assert.equal(kept.status, 200);
    const { rows } = parseLabels(fs.readFileSync(path.join(dir, "labels.tsv"), "utf8"));
    assert.equal(rows[rows.length - 1].speaker, "Sam");
    assert.ok(!rows.some((r) => r.speaker === "SAM" || r.speaker === "sam"));
    const names = (await call({ url: "/api/speakers" })).json.speakers.map((x) => x.name);
    assert.equal(names.filter((n) => n.toLowerCase() === "sam").length, 1);
  });

  it("reads the readout against the speaker's range once there are five other clips", async () => {
    // A low, level 妈: with no range to place it a level pitch may be a
    // first tone; in the range of this speaker's other clips it is low,
    // and a first tone is high.
    const low = () => wav(100, 100);
    const early = await keep({ prompt: "r01", speaker: "Ranger", group: "adult" }, low());
    assert.equal(early.json.readout, "heard tone 1, expected tone 1: matches");
    // Four more clips across an octave: a range from 100 to 200 Hz.
    for (const [id, from, to] of [["r02", 110, 200], ["r04", 200, 105], ["r05", 190, 195], ["r06", 105, 190]]) assert.equal((await keep({ prompt: id, speaker: "Ranger", group: "adult" }, wav(from, to))).status, 200);
    const later = await keep({ prompt: "r01", speaker: "ranger", group: "adult" }, low());
    assert.equal(later.json.readout, "heard tone 3, expected tone 1: flagged");
  });

  it("adds a label on a line of its own, whatever the file ended with", async () => {
    const hand = "old-1.wav\t你好\t\tPat\tadult";
    for (const [name, existing] of [["extra-no-newline", hand], ["extra-newline", `${hand}\n`], ["extra-crlf", `${hand}\r\n`], ["extra-empty", ""]]) {
      const other = await mount(name);
      fs.writeFileSync(path.join(other.dir, "labels.tsv"), existing);
      const res = await keep({ prompt: "r01", speaker: "Pat", group: "adult" }, wav(220, 222), {}, other.at);
      assert.equal(res.status, 200, name);
      const text = fs.readFileSync(path.join(other.dir, "labels.tsv"), "utf8");
      // What was there is untouched, byte for byte.
      assert.ok(text.startsWith(existing), name);
      const { rows, problems } = parseLabels(text);
      assert.deepEqual(problems, [], name);
      assert.deepEqual(rows.map((r) => [r.text, r.speaker]), existing ? [["你好", "Pat"], ["妈", "Pat"]] : [["妈", "Pat"]], name);
      assert.ok(isRecordingName(rows[rows.length - 1].file));
      assert.deepEqual(res.json.done.sort(), existing ? [promptKey({ text: "你好" }), promptKey({ text: "妈" })].sort() : [promptKey({ text: "妈" })], name);
    }
  });

  it("says so, and keeps nothing, when the label can't be written", async () => {
    const other = await mount("extra-broken");
    // labels.tsv is a folder: nothing can be appended to it.
    fs.mkdirSync(path.join(other.dir, "labels.tsv"));
    const res = await keep({ prompt: "r01", speaker: "Pat", group: "adult" }, wav(220, 222), {}, other.at);
    assert.equal(res.status, 500);
    assert.match(res.json.error, /not kept/);
    assert.notEqual(res.json.saved, true);
    // No clip left behind without its label.
    assert.deepEqual(fs.readdirSync(other.dir), ["labels.tsv"]);

    // It reads but can't be added to: the clip written a moment before
    // is taken away again, and the speaker's progress doesn't move.
    // (Root writes through a read-only mode: nothing to see there.)
    if (process.getuid?.() === 0) return;
    const locked = await mount("extra-locked");
    fs.writeFileSync(path.join(locked.dir, "labels.tsv"), "old-1.wav\t你好\t\tPat\tadult\n", { mode: 0o400 });
    const res2 = await keep({ prompt: "r01", speaker: "Pat", group: "adult" }, wav(220, 222), {}, locked.at);
    assert.equal(res2.status, 500);
    assert.match(res2.json.error, /could not be added to labels.tsv, so it was not kept/);
    assert.deepEqual(fs.readdirSync(locked.dir), ["labels.tsv"]);
    assert.deepEqual((await call({ url: "/api/progress?speaker=Pat", at: locked.at })).json.done, [promptKey({ text: "你好" })]);
  });

  it("takes the line off again when it was written but doesn't read back", async () => {
    // A reader that loses the newest row once the file has two: the append
    // succeeds and the check after it fails.
    const existing = `${LABELS_HEADER}\nold-1.wav\t你好\t\tPat\tadult\t\traw\n`;
    const other = await mount("extra-readback", { parse: (text) => { const all = parseLabels(text); return all.rows.length > 1 ? { ...all, rows: all.rows.slice(0, -1) } : all; } });
    fs.writeFileSync(path.join(other.dir, "labels.tsv"), existing);
    const res = await keep({ prompt: "r01", speaker: "Pat", group: "adult" }, wav(220, 222), {}, other.at);
    assert.equal(res.status, 500);
    assert.match(res.json.error, /could not be added to labels.tsv, so it was not kept/);
    // Neither the clip nor its line is left: the file is byte for byte
    // what it was, so the prompt is not "done" on resume.
    assert.deepEqual(fs.readdirSync(other.dir), ["labels.tsv"]);
    assert.equal(fs.readFileSync(path.join(other.dir, "labels.tsv"), "utf8"), existing);

    // The same with no trailing newline before: the glue goes too.
    const bare = await mount("extra-readback-bare", { parse: (text) => { const all = parseLabels(text); return all.rows.length > 1 ? { ...all, rows: all.rows.slice(0, -1) } : all; } });
    fs.writeFileSync(path.join(bare.dir, "labels.tsv"), existing.trimEnd());
    assert.equal((await keep({ prompt: "r01", speaker: "Pat", group: "adult" }, wav(220, 222), {}, bare.at)).status, 500);
    assert.equal(fs.readFileSync(path.join(bare.dir, "labels.tsv"), "utf8"), existing.trimEnd());
  });

  it("checks the name again once the upload has arrived", async () => {
    // Two tabs: "Lee" as an adult starts a slow upload; "lee" as a child
    // keeps a clip meanwhile. The first must not land in the other group.
    const other = await mount("extra-race");
    const body = wav(220, 222);
    const q = new URLSearchParams({ prompt: "r01", text: "妈", said: "", speaker: "Lee", group: "adult", processing: "raw" });
    const slow = http.request({ host: "127.0.0.1", port: other.at, method: "POST", path: `/api/keep?${q}`, headers: { Host: `127.0.0.1:${other.at}`, Origin: `http://127.0.0.1:${other.at}`, "Content-Type": "audio/wav", "Content-Length": body.length } });
    const answer = new Promise((resolve, reject) => {
      slow.on("error", reject);
      slow.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
    });
    slow.write(body.subarray(0, 2000));
    // The server has the headers and half the clip; the other tab finishes first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await keep({ prompt: "r03", speaker: "lee", group: "child" }, wav(180, 260), {}, other.at)).status, 200);
    slow.end(body.subarray(2000));
    const late = await answer;
    assert.equal(late.status, 409);
    assert.match(late.json.error, /lee is already recorded as a child/);
    const { rows } = parseLabels(fs.readFileSync(path.join(other.dir, "labels.tsv"), "utf8"));
    assert.deepEqual(rows.map((r) => [r.speaker, r.group]), [["lee", "child"]]);
    assert.equal(fs.readdirSync(other.dir).filter(isRecordingName).length, 1);
  });
});

describe("the proof and the recordings folder", () => {
  const repo = path.resolve(import.meta.dirname, "..", "..");
  const proof = (dir) => spawnSync(process.execPath, [path.join(repo, "scripts", "pronunciation-proof.mjs"), "--recordings"], { cwd: repo, encoding: "utf8", env: { ...process.env, LINGO_PROOF_DIR: dir, LINGO_PROOF_REPORT: path.join(dir, "never-written.md") } });
  const tone = (from, to) => Buffer.from(encodeWav(Float32Array.from({ length: 8000 }, (_, i) => {
    const x = (2 * Math.PI * (from + ((to - from) * i) / 8000) * i) / 16_000;
    return 0.3 * (Math.sin(x) + Math.sin(2 * x) / 2 + Math.sin(3 * x) / 3);
  }), 16_000));

  it("writes nothing where git would track it: asked before a clip is converted", () => {
    // A folder inside the repository that no ignore rule covers, holding a
    // clip that would have to be converted (into .wav16k/, a voice).
    const dir = fs.mkdtempSync(path.join(repo, "scripts", "tests", ".tmp-proof-"));
    try {
      const rec = path.join(dir, "recordings");
      fs.mkdirSync(rec);
      assert.equal(trackedByGit(rec, repo), true);
      fs.writeFileSync(path.join(rec, "a.m4a"), "not audio");
      fs.writeFileSync(path.join(rec, "labels.tsv"), "a.m4a\t妈\t\tsam\tadult\n");
      const run = proof(dir);
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, /Not scoring the recordings: .* nothing is written there/);
      assert.deepEqual(fs.readdirSync(rec).sort(), ["a.m4a", "labels.tsv"]);
      assert.deepEqual(fs.readdirSync(dir), ["recordings"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scores recordings outside the repository, one person per name whatever its capitals", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-proof-rec-"));
    try {
      const rec = path.join(dir, "recordings");
      fs.mkdirSync(rec);
      const lines = [];
      for (const [k, name] of ["Mia", "mia", "MIA"].entries()) {
        fs.writeFileSync(path.join(rec, `c${k}.wav`), tone(180 + 10 * k, 181 + 10 * k));
        lines.push(`c${k}.wav\t妈\t\t${name}\tadult`);
      }
      fs.writeFileSync(path.join(rec, "labels.tsv"), `${lines.join("\n")}\n`);
      const run = proof(dir);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /3 recordings from `labels.tsv`, 1 speaker\(s\), 3 judged syllables\./);
      const report = fs.readFileSync(path.join(rec, "report.md"), "utf8");
      assert.equal(report.split("\n").filter((l) => /^\| Mia \| adult \|/.test(l)).length, 1);
      assert.ok(!/\| (mia|MIA) \|/.test(report));
      assert.ok(!fs.existsSync(path.join(dir, "never-written.md")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the recordings folder and git", () => {
  it("is refused when a file under it is already tracked, ignored or not", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-record-git-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      git("init", "-q");
      fs.mkdirSync(path.join(repo, "data", "recordings"), { recursive: true });
      fs.mkdirSync(path.join(repo, "data", "clean"), { recursive: true });
      fs.writeFileSync(path.join(repo, "data", "recordings", "old.wav"), "x");
      git("add", "data/recordings/old.wav");
      // Ignored only after a file was added: the rule doesn't untrack it.
      fs.writeFileSync(path.join(repo, ".gitignore"), "data/\n");
      assert.equal(trackedByGit(path.join(repo, "data", "recordings"), repo), true);
      assert.equal(trackedByGit(path.join(repo, "data", "clean"), repo), false);
      assert.equal(trackedByGit(path.join(repo, "src"), repo), true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is safe outside the repository or under an ignored folder, and refused where git would track it", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..");
    assert.equal(trackedByGit(os.tmpdir(), repo), false);
    assert.equal(trackedByGit(path.join(repo, "data", "pronunciation-proof", "recordings"), repo), false);
    assert.equal(trackedByGit(path.join(repo, "scripts"), repo), true);
  });
});
