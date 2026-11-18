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
 * cloned Mandarin voice and two premade ones. */
const synths = [];
let lists = 0;
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
    return new Response(`MP3:${voice}:${text}`, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
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

test("no voice saved (ld-zxn): the sound and Hear it's /speak use a premade account voice, of the narrator's gender when /speak names one; the list is fetched once", async () => {
  clearVoiceLists();
  const before = lists;
  const pip = await someone([KID]);
  // A kids learner's card plays too.
  const r = await sound(pip, "玻");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text, "MP3:premade-m:玻", "a premade voice (any plan), never the cloned one; no gender: the first");
  const speak = await pip.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text: "你好", locale: "zh-TW" });
  assert.equal(speak.status, 200, speak.text);
  assert.equal(speak.text, "MP3:premade-f:你好");
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
