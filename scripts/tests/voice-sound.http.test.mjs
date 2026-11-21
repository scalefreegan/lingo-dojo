// The character card's sounds end to end (web/server/voice.ts
// handleVoiceSound, ld-6c8) and the default voice when none is saved
// (ld-zxn): /api/voice/sound takes only a few Han characters (zhuyin is
// heard through example characters, never sent), needs a session and the page's learner, speaks in the narrator's
// voice (or the provider's default) and is served from the on-disk audio
// cache after the first time; /api/voice/speak with every slot Random
// speaks in the default voice too. The real plugin on an in-process PGlite,
// ElevenLabs stubbed in fetch: nothing here reaches a provider. The cache
// lives in a temp dir (LINGO_DATA_DIR), never data/. Every name here is
// made up.
//   node --test scripts/tests/voice-sound.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-sound-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

/* ElevenLabs, stubbed: speech is "MP3:<voice>:<text>"; the account has a
 * cloned Mandarin voice and two premade ones. A line starting "HOLD" waits
 * for `hold.open()` (the paid-slot test holds calls in flight with it), one
 * starting "FAIL" is a 500; speech-to-text hears "你好", the Voice Library
 * finds nothing (and, with `hold.searches`, waits for `hold.open()` or the
 * request's abort, as a real fetch does). */
const synths = [];
const plan = { refuse: false, fail: false };
let lists = 0;
let stts = 0;
let searches = 0;
const hold = {
  entered: 0,
  searches: false,
  gate: Promise.resolve(),
  open() {},
  close() {
    this.gate = new Promise((resolve) => (this.open = resolve));
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  if (url.pathname === "/v2/voices") {
    lists++;
    const voices = [
      { voice_id: "cloned-zh-f", name: "Ana", labels: { language: "zh", gender: "female" }, category: "cloned" },
      { voice_id: "premade-m", name: "Adam", labels: { language: "en", gender: "male" }, category: "premade" },
      { voice_id: "premade-f", name: "Rachel", labels: { language: "en", gender: "female" }, category: "premade" },
    ];
    return new Response(JSON.stringify({ voices }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname.startsWith("/v1/text-to-speech/")) {
    const voice = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const { text } = JSON.parse(init.body);
    synths.push({ voice, text });
    // A library voice the plan refuses (ld-pqy): 402, like ElevenLabs' answer.
    if (voice === "cloned-zh-f" && plan.refuse) return new Response(JSON.stringify({ detail: { message: "library voices need a paid plan" } }), { status: 402 });
    if (plan.fail || text.startsWith("FAIL")) return new Response(JSON.stringify({ detail: { message: "server error" } }), { status: 500 });
    if (text.startsWith("HOLD")) {
      hold.entered++;
      await hold.gate;
    }
    return new Response(`MP3:${voice}:${text}`, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.pathname === "/v1/speech-to-text") {
    stts++;
    return new Response(JSON.stringify({ text: "你好" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/v1/shared-voices") {
    searches++;
    if (hold.searches) {
      hold.entered++;
      await new Promise((resolve, reject) => {
        hold.gate.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    return new Response(JSON.stringify({ voices: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};

const { apiPlugins } = await import("../../web/server/api.ts");
const { clearVoiceLists } = await import("../../web/server/voice.ts");

const testDb = await freshDb();
let base, close;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  globalThis.fetch = realFetch;
  await close();
  await testDb.close();
});

let n = 0;
/** A fresh account, logged in, its first learner picked; ElevenLabs
 *  speaking, with `voices` saved (none: every slot Random). */
async function someone(learners = [ADULT], voices = {}) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  const r = await c.call("PUT", "/api/voice/settings", { tts: "elevenlabs", voices: { elevenlabs: voices } });
  assert.equal(r.status, 200, r.text);
  return c;
}
const sound = (who, text, locale = "zh-TW") => who.call("POST", "/api/voice/sound", { text, locale });

test("a sound needs a session, and the page's own learner", async () => {
  const anon = client(base);
  assert.equal((await sound(anon, "行")).status, 401);
  await addUser(testDb.db, "nopick", undefined, { learners: [ADULT] });
  const unpicked = client(base);
  await unpicked.login("nopick");
  const r = await sound(unpicked, "行");
  assert.deepEqual([r.status, r.body.code], [409, "stale_learner"]);
  // A page still showing another learner.
  const sam = await someone([ADULT, KID]);
  const other = (await sam.call("GET", "/api/auth/me")).body.learners.find((l) => l.name === "Pip");
  const stale = await sam.call("POST", "/api/voice/sound", { text: "行", locale: "zh-TW" }, { "X-Learner-Id": other.id });
  assert.equal(stale.status, 409);
  assert.equal(synths.filter((s) => s.text === "行").length, 0, "nothing said for any of them");
});

test("only 1 to 4 Han characters: anything else is a 400, before any provider call", async () => {
  const sam = await someone();
  const before = synths.length;
  for (const bad of ["", "   ", "行行行行行", "hello", "行a", "ㄅ ㄆ", "ni3", "你好！", "😀", "ㄅㄆㄇㄈㄉ", "1", "ㄇㄚˇ", "ㄅ", "ˊ"]) {
    const r = await sound(sam, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /1 to 4 Chinese characters/);
  }
  for (const body of [{}, { text: 7, locale: "zh-TW" }, { text: ["行"], locale: "zh-TW" }]) {
    assert.equal((await sam.call("POST", "/api/voice/sound", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await sound(sam, "行", "taiwan")).status, 400);
  assert.equal((await sam.call("GET", "/api/voice/sound")).status, 405);
  assert.equal((await sam.call("POST", "/api/voice/sound/x", { text: "行", locale: "zh-TW" })).status, 404);
  assert.equal(synths.length, before);
  // Within the limits: a character, the neutral tone's 媽媽, four.
  for (const ok of ["行", "媽媽", "一二三四"]) {
    const r = await sound(sam, ok);
    assert.equal(r.status, 200, `${ok}: ${r.text}`);
  }
});

test("the same text, voice and locale is said once: later plays come from the cache on disk, per account", async () => {
  const sam = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  const before = synths.length;
  const first = await sound(sam, "杭");
  assert.equal(first.status, 200, first.text);
  assert.equal(first.text, "MP3:saved-voice:杭");
  assert.equal(first.headers.get("content-type"), "audio/mpeg");
  assert.match(first.headers.get("cache-control"), /private, no-store/);
  const again = await sound(sam, "杭");
  assert.deepEqual([again.status, again.text], [200, first.text]);
  assert.equal(synths.length, before + 1, "no second provider call");
  // Another locale or text is another sound.
  await sound(sam, "杭", "zh-CN");
  await sound(sam, "行");
  assert.equal(synths.length, before + 3);
  // Another account with the same voice makes its own (nothing to probe or time).
  const robin = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  assert.equal((await sound(robin, "杭")).status, 200);
  assert.equal(synths.length, before + 4);
  const files = fs.readdirSync(path.join(dataDir, "audio")).filter((f) => f.endsWith(".mp3"));
  assert.ok(files.length >= 4 && files.every((f) => /^[0-9a-f]{64}\.mp3$/.test(f)));
});

test("no voice saved (ld-zxn): the sound and Hear it's /speak use the account's native voice for the language (bug ld-pqy), before any premade one; the list is fetched once", async () => {
  clearVoiceLists();
  const before = lists;
  const pip = await someone([KID]);
  // A kids learner's card plays too.
  const r = await sound(pip, "玻");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text, "MP3:cloned-zh-f:玻", "the native Mandarin voice, never the English premade ones");
  const speak = await pip.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text: "你好", locale: "zh-TW" });
  assert.equal(speak.status, 200, speak.text);
  assert.equal(speak.text, "MP3:cloned-zh-f:你好", "native before gender");
  // A saved voice still wins.
  await pip.call("PUT", "/api/voice/settings", { voices: { elevenlabs: { "zh-TW": { "narrator:male": "picked" } } } });
  assert.equal((await sound(pip, "坡")).text, "MP3:picked:坡");
  assert.equal(lists, before + 1, "one list call for every line above");
});

test("no provider key is still a clear 400: the default voice replaces 'no voice saved', never 'no provider'", async () => {
  const sam = await someone();
  await sam.call("PUT", "/api/voice/settings", { tts: "azure" });
  const r = await sound(sam, "行");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Azure Speech is not set up: add AZURE_SPEECH_KEY/);
  const speak = await sam.call("POST", "/api/voice/speak", { speaker: "narrator", text: "你好", locale: "zh-TW" });
  assert.equal(speak.status, 400);
  assert.match(speak.body.error, /AZURE_SPEECH_KEY/);
});

const speakAs = (who, text) => who.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text, locale: "zh-TW" });

test("one paid-call limit per user across the routes (ld-e6q): two lines in flight, and a third line, a transcription, a voice draw or a sound is a 429 before any provider call; another login isn't held; all free after", async () => {
  const sam = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  const robin = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  const listen = (who) => who.call("POST", "/api/voice/transcribe?locales=zh-TW", new Uint8Array([82, 73, 70, 70, 1, 2, 3]), { "Content-Type": "audio/wav" });
  const draw = (who) => who.call("POST", "/api/voice/cast", { mode: "adult", locale: "zh-TW", units: [] });
  hold.close();
  hold.entered = 0;
  const held = [speakAs(sam, "HOLD 一"), speakAs(sam, "HOLD 二")];
  try {
    for (let i = 0; hold.entered < 2 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(hold.entered, 2, "both lines reached the provider");
    const counts = () => [synths.length, stts, searches, lists];
    const before = counts();
    const third = await speakAs(sam, "三");
    assert.deepEqual([third.status, third.body.error], [429, "too many audio requests at once; try again in a moment"]);
    const heard = await listen(sam);
    assert.deepEqual([heard.status, heard.body.error], [429, "too many transcriptions at once; try again in a moment"]);
    const cast = await draw(sam);
    assert.deepEqual([cast.status, cast.body.error], [429, "too many voice draws at once; try again in a moment"]);
    const card = await sound(sam, "鬱");
    assert.equal(card.status, 429, "the character card's sound shares the slots");
    assert.deepEqual(counts(), before, "nothing reached a provider");
    // Per user: another login speaks meanwhile.
    const theirs = await speakAs(robin, "四");
    assert.deepEqual([theirs.status, theirs.text], [200, "MP3:saved-voice:四"]);
  } finally {
    hold.open();
  }
  assert.deepEqual((await Promise.all(held)).map((r) => r.status), [200, 200]);
  // The slots free up once the held lines are said.
  assert.equal((await speakAs(sam, "三")).status, 200);
  const heard = await listen(sam);
  assert.deepEqual([heard.status, heard.body.text], [200, "你好"]);
  const cast = await draw(sam);
  assert.equal(cast.status, 200, cast.text);
  assert.equal((await sound(sam, "鬱")).status, 200);
});

test("a failed paid call frees its slot: provider errors over and over never lock the user out", async () => {
  const sam = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  for (let i = 0; i < 3; i++) {
    const r = await speakAs(sam, "FAIL 一");
    assert.deepEqual([r.status, r.body.error], [502, "ElevenLabs answered 500: server error"]);
  }
  assert.equal((await speakAs(sam, "一")).status, 200);
});

test("a voice draw the browser gives up on frees its slot at once: its provider calls are aborted, not left to their 30 s timeout (PR #45 review)", async () => {
  const sam = await someone([ADULT], { "zh-TW": { "narrator:female": "saved-voice" } });
  hold.close();
  hold.entered = 0;
  hold.searches = true;
  const gaveUp = new AbortController();
  try {
    const drawn = sam.call("POST", "/api/voice/cast", { mode: "adult", locale: "zh-TW", units: [] }, {}, { signal: gaveUp.signal });
    for (let i = 0; hold.entered < 1 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(hold.entered >= 1, "the draw is searching the library");
    gaveUp.abort();
    await assert.rejects(drawn);
    // One line held in flight takes a slot; a second line needs the other,
    // which the abandoned draw holds until its search ends (the stub's never
    // does on its own: only the abort ends it). The server sees the close
    // within moments, so a few short tries are allowed, never the 30 s.
    const entered = hold.entered;
    const held = speakAs(sam, "HOLD 一");
    for (let i = 0; hold.entered === entered && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(hold.entered, entered + 1, "the first line is at the provider");
    let second;
    for (let i = 0; i < 25; i++) {
      second = await speakAs(sam, "二");
      if (second.status !== 429) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(second.status, 200, "the second line is said while the abandoned search would still be waiting");
    hold.open();
    assert.equal((await held).status, 200);
  } finally {
    hold.searches = false;
    hold.open();
  }
});

test("a native voice the plan refuses (ld-pqy): the clip is made in the premade voice, kept under that voice's key, the refusal is not remembered, a real failure still fails", async () => {
  clearVoiceLists();
  const kim = await someone();
  const warn = [];
  plan.refuse = true;
  const realWarn = console.warn;
  console.warn = (...a) => warn.push(a.join(" "));
  try {
    const n0 = synths.length;
    const r = await sound(kim, "一");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, "MP3:premade-m:一", "said in the premade voice rather than lost");
    assert.deepEqual(synths.slice(n0).map((s) => s.voice), ["cloned-zh-f", "premade-m"], "the native voice was tried first");
    assert.ok(warn.some((w) => /refused the native voice cloned-zh-f for zh-TW \(402\)/.test(w) && !w.includes("一")), "logged, with no text");
    // Cached under the premade voice: a replay makes no premade call (the
    // native voice is asked first each time: its refusal is never cached).
    const n1 = synths.length;
    assert.equal((await sound(kim, "一")).text, "MP3:premade-m:一");
    assert.deepEqual(synths.slice(n1).map((s) => s.voice), ["cloned-zh-f"]);
    const n1b = synths.length;
    // The refusal isn't remembered: the next clip tries the native voice again.
    await sound(kim, "二");
    assert.deepEqual(synths.slice(n1b).map((s) => s.voice), ["cloned-zh-f", "premade-m"]);
    // Anything but a "not this voice" status is not retried (a 500 is a 502).
    const n2 = synths.length;
    plan.refuse = false;
    plan.fail = true;
    const bad = await sound(kim, "五");
    assert.equal(bad.status, 502);
    assert.equal(synths.length, n2 + 1, "one call, no fallback");
    // /speak's default voice falls back the same way.
    plan.fail = false;
    plan.refuse = true;
    const said = await kim.call("POST", "/api/voice/speak", { speaker: "narrator", text: "你好", locale: "zh-TW" });
    assert.equal(said.text, "MP3:premade-m:你好");
    // A saved voice is the learner's choice: no silent swap.
    const lee = await someone([ADULT], { "zh-TW": { "narrator:female": "cloned-zh-f" } });
    const n3 = synths.length;
    assert.equal((await sound(lee, "四")).status, 502);
    assert.equal(synths.length, n3 + 1);
  } finally {
    console.warn = realWarn;
    plan.refuse = false;
    plan.fail = false;
  }
});

test("the default voice is the same one every time for a locale (ld-pqy)", async () => {
  clearVoiceLists();
  const ivy = await someone();
  const used = new Set();
  for (const t of ["一", "二", "三"]) used.add((await sound(ivy, t)).text.split(":")[1]);
  assert.deepEqual([...used], ["cloned-zh-f"]);
});
