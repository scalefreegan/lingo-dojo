// Saying the settled reading end to end (ld-0mn, docs/VOICE.md §Saying the
// settled reading): once a learner settles a word, /api/voice/speak and the
// cached outside-a-session clips (/api/voice/sound; Practice and the
// picture game go through the same outsideClip) send the voice stand-in
// characters for it, the cache key follows what was sent (a clip made
// before the word was settled is never served for it), and nothing the
// learner sees changes. ElevenLabs stubbed in fetch; every name made up.
//   node --test scripts/tests/voice-settled.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-settled-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const synths = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  if (url.pathname.startsWith("/v1/text-to-speech/")) {
    const { text } = JSON.parse(init.body);
    synths.push(text);
    return new Response(`MP3:${text}`, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  return new Response(JSON.stringify({ voices: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { apiPlugins } = await import("../../web/server/api.ts");
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

const CN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin (Putonghua)" };
let n = 0;
async function someone(learner = CN) {
  const name = `settled${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  const r = await c.call("PUT", "/api/voice/settings", { tts: "elevenlabs", voices: { elevenlabs: { "zh-CN": { "narrator:female": "v1" } } } });
  assert.equal(r.status, 200, r.text);
  return c;
}
const speak = (c, text, extra = {}) => c.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text, locale: "zh-CN", ...extra });

test("a line is sent as written until the learner settles a word; then the word goes as stand-ins, and only the target-language text", async () => {
  const lin = await someone();
  let r = await speak(lin, "我明天还钱。");
  assert.equal(r.status, 200, r.text);
  assert.equal(synths.at(-1), "我明天还钱。", "the reader's own reading is never forced on the voice");
  const fix = await lin.call("POST", "/api/readings", { word: "还钱", reading: "hái qián", kind: "corrected" });
  assert.equal(fix.status, 200, fix.text);
  r = await speak(lin, "我明天还钱。");
  assert.equal(synths.at(-1), "我明天孩钱。");
  // The learner's text is not the target language: never touched.
  r = await speak(lin, "还钱", { lang: "native", nativeLocale: "en-US" });
  assert.equal(synths.at(-1), "还钱");
  // Inside a longer word: as written.
  await speak(lin, "我还钱包。");
  assert.equal(synths.at(-1), "我还钱包。");
  // What the page reads back is the learner's own words.
  assert.deepEqual((await lin.call("GET", "/api/readings")).body.readings.map((x) => x.word), ["还钱"]);
});

test("another learner's settled word changes nothing for this one", async () => {
  const a = await someone({ ...CN, name: "Ana" });
  const b = await someone({ ...CN, name: "Ben" });
  assert.equal((await a.call("POST", "/api/readings", { word: "长着", reading: "cháng zhe", kind: "corrected" })).status, 200);
  await speak(b, "小狗长着大耳朵。");
  assert.equal(synths.at(-1), "小狗长着大耳朵。");
  await speak(a, "小狗长着大耳朵。");
  assert.equal(synths.at(-1), "小狗常着大耳朵。");
});

test("the cache key follows what the voice is given: a clip made before the word was settled is not served after", async () => {
  const lin = await someone();
  const first = await lin.call("POST", "/api/voice/sound", { text: "还钱", locale: "zh-CN" });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.text, "MP3:还钱");
  const calls = synths.length;
  assert.equal((await lin.call("POST", "/api/voice/sound", { text: "还钱", locale: "zh-CN" })).text, "MP3:还钱");
  assert.equal(synths.length, calls, "a cache hit");
  assert.equal((await lin.call("POST", "/api/readings", { word: "还钱", reading: "hái qián", kind: "corrected" })).status, 200);
  const after = await lin.call("POST", "/api/voice/sound", { text: "还钱", locale: "zh-CN" });
  assert.equal(after.text, "MP3:孩钱");
  assert.equal(synths.length, calls + 1, "said again, not the old clip");
  assert.equal((await lin.call("POST", "/api/voice/sound", { text: "还钱", locale: "zh-CN" })).text, "MP3:孩钱");
  assert.equal(synths.length, calls + 1, "and cached under its own key");
});
