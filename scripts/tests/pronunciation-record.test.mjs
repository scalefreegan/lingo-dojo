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
import { after, before, describe, it } from "node:test";
import { encodeWav } from "../pronunciation.mjs";
import {
  LABELS_HEADER, MAX_UPLOAD_BYTES, PHRASES, SINGLES, buildPrompts, checkWav, cleanSpeaker, doneKeys, formatLabel, isRecordingName, newFileName, parseLabels, promptKey, readout, saidTones, speakerTable,
  speakerTally,
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
    assert.deepEqual(buildPrompts(() => false), []);
  });
});

describe("labels.tsv", () => {
  it("writes a row and reads it back", () => {
    const rows = [
      { file: "rec-20261118-153012-ab12cd34.wav", text: "妈", said: "ma2", speaker: "Sam", group: "adult", unsure: false },
      { file: "rec-20261118-153140-0f3e9a71.wav", text: "我是学生", said: "", speaker: "小明", group: "child", unsure: true },
    ];
    const tsv = [LABELS_HEADER, ...rows.map(formatLabel), ""].join("\n");
    assert.deepEqual(parseLabels(tsv), { rows, problems: [] });
  });

  it("reads the hand-written format from before the recorder", () => {
    const { rows, problems } = parseLabels("# file\ttext\tsaid\tspeaker\r\nnihao-1.wav\t你好\n\nma-wrong.wav\t妈\tma3\nx.m4a\t我是学生\two3 shi4 xue2 sheng2\tsam\n");
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, [
      { file: "nihao-1.wav", text: "你好", said: "", speaker: "speaker", group: "", unsure: false },
      { file: "ma-wrong.wav", text: "妈", said: "ma3", speaker: "speaker", group: "", unsure: false },
      { file: "x.m4a", text: "我是学生", said: "wo3 shi4 xue2 sheng2", speaker: "sam", group: "", unsure: false },
    ]);
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
    assert.equal(line.split("\t").length, 6);
    assert.deepEqual(parseLabels(line).rows, [{ file: "a.wav", text: "妈", said: "", speaker: "sam adult b.wav 马", group: "", unsure: true }]);
  });

  it("derives what a speaker has done from the rows alone", () => {
    const { rows } = parseLabels(["a.wav\t妈\t\tsam", "b.wav\t妈\tma2\tsam", "c.wav\t马\t\tkim"].join("\n"));
    const done = doneKeys(rows, "sam");
    assert.ok(done.has(promptKey({ text: "妈", said: "" })));
    assert.ok(done.has(promptKey({ text: "妈", said: "ma2" })));
    assert.ok(!done.has(promptKey({ text: "马", said: "" })));
    assert.equal(doneKeys(rows, "nobody").size, 0);
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

describe("the recorder's HTTP handler", () => {
  let tmp;
  let dir;
  let server;
  let port;
  let recorder;

  /** A raw request, so the test controls Host and Origin. */
  function call({ method = "GET", url = "/", headers = {}, body = null, host = null }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers, ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
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
      req.on("error", reject);
      // A refused upload may be answered and closed before it is all sent.
      req.end(body ?? undefined);
    });
  }
  const keep = (query, body = wav(180, 260), headers = {}) => call({ method: "POST", url: `/api/keep?${new URLSearchParams(query)}`, headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "audio/wav", ...headers }, body });
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

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
    recorder = createRecorder({ dir, clipsDir: clips });
    server = http.createServer(recorder.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
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
    assert.ok(!html.includes("__NONCE__") && !html.includes("__DATA__"));
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
    assert.equal((await keep({ ...q, prompt: "r99" })).status, 400);
    assert.equal((await keep({ ...q, prompt: "../x" })).status, 400);
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
    assert.deepEqual(before.json, { speaker: "Sam", done: [] });

    const res = await keep({ prompt: first.id, speaker: "Sam", group: "adult" }, wav(220, 222));
    assert.equal(res.status, 200);
    assert.equal(res.json.saved, true);
    assert.deepEqual(res.json.done, [promptKey(first)]);
    // The readout is the scorer's own words on a level tone for 妈 (tone 1).
    assert.match(res.json.readout, /expected tone 1|not sure/);

    const saved = files().filter((f) => f.endsWith(".wav"));
    assert.equal(saved.length, 1);
    assert.ok(isRecordingName(saved[0]));
    assert.ok(fs.readFileSync(path.join(dir, saved[0])).equals(wav(220, 222)));
    assert.equal(fs.statSync(path.join(dir, saved[0])).mode & 0o777, 0o600);
    const text = fs.readFileSync(path.join(dir, "labels.tsv"), "utf8");
    assert.equal(text, `${LABELS_HEADER}\n${saved[0]}\t妈\t\tSam\tadult\t\n`);

    // A wrong-on-purpose clip from a child, marked not sure, with a name
    // that tries to be a path and a second row.
    const wrongMa = recorder.prompts.find((p) => p.part === "wrong" && p.text === "妈");
    const second = await keep({ prompt: wrongMa.id, speaker: "../kim\tchild\nx.wav\t马", group: "child", unsure: "1" }, wav(160, 260));
    assert.equal(second.status, 200);
    const { rows, problems } = parseLabels(fs.readFileSync(path.join(dir, "labels.tsv"), "utf8"));
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[1], file: "" }, { file: "", text: "妈", said: "ma2", speaker: "kim child x wav 马", group: "child", unsure: true });
    assert.ok(isRecordingName(rows[1].file));
    // Everything written is in the recordings folder, under generated names.
    assert.deepEqual(files().filter((f) => f !== "labels.tsv").every(isRecordingName), true);
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["clips", "recordings"]);

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
});

describe("the recordings folder and git", () => {
  it("is safe outside the repository or under an ignored folder, and refused where git would track it", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..");
    assert.equal(trackedByGit(os.tmpdir(), repo), false);
    assert.equal(trackedByGit(path.join(repo, "data", "pronunciation-proof", "recordings"), repo), false);
    assert.equal(trackedByGit(path.join(repo, "scripts"), repo), true);
  });
});
