// The pace mark end to end over HTTP (ld-9gz, docs/VOICE.md §Pace): a
// reply's <slow> part comes back on its segment, is stored with the turn,
// and is put back in the next turn's prompt; /api/voice/speak asks the
// provider for its slow setting for a slow piece and for nothing otherwise,
// tells the browser to slow the playback where the voice can't, and refuses
// any pace that isn't one of the two words; the character card's sound
// stays at the normal pace. The real plugin on an in-process PGlite, a
// stand-in `claude`, ElevenLabs and Azure stubbed in fetch and recording
// what they were asked: nothing here reaches a provider. Every name is
// made up.
//   node --test scripts/tests/voice-pace.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-pace-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\nAZURE_SPEECH_KEY=az-key\nAZURE_SPEECH_REGION=eastus\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

/* Both speech providers, stubbed: each call's body is kept as it was sent. */
const eleven = [];
const azure = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.elevenlabs.io" && url.pathname.startsWith("/v1/text-to-speech/")) {
    eleven.push({ raw: init.body, body: JSON.parse(init.body) });
    return new Response("MP3", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.hostname === "eastus.tts.speech.microsoft.com") {
    azure.push(String(init.body));
    return new Response("MP3", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.hostname === "api.elevenlabs.io" || url.hostname.endsWith(".microsoft.com")) return new Response("{}", { status: 404 });
  return realFetch(input, init);
};

const { apiPlugins } = await import("../../web/server/api.ts");
const { sayArgs } = await import("../../web/server/voice.ts");
const { PLAYBACK_RATE_HEADER } = await import("../../web/shared/wire.ts");
const { SAY_SLOW_WPM, SLOW_RATE } = await import("../voice.mjs");

const fake = fakeClaude();
const testDb = await freshDb();
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  globalThis.fetch = realFetch;
  fake.restore();
  await close();
  await testDb.close();
});

let n = 0;
async function someone(settings) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [ADULT] });
  const c = client(base);
  await c.login(name);
  await c.pick(ADULT.name);
  const r = await c.call("PUT", "/api/voice/settings", settings);
  assert.equal(r.status, 200, r.text);
  return c;
}
const ELEVEN_VOICES = { elevenlabs: { "es-MX": { "narrator:female": "voice-f" }, "zh-TW": { "narrator:female": "voice-f" } } };
const say = (who, extra = {}) => who.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text: "por favor", locale: "es-MX", ...extra });

test("speak, ElevenLabs on a model with speed control: a slow piece is sent voice_settings.speed, a normal one the request it always was", async () => {
  const sam = await someone({ tts: "elevenlabs", elevenModel: "eleven_flash_v2_5", voices: ELEVEN_VOICES });
  eleven.length = 0;
  const normal = await say(sam);
  assert.equal(normal.status, 200, normal.text);
  const absent = await say(sam, { pace: "normal" });
  const slow = await say(sam, { pace: "slow" });
  assert.equal(slow.status, 200, slow.text);
  assert.equal(eleven.length, 3);
  assert.equal(eleven[0].body.voice_settings, undefined);
  assert.equal(eleven[1].raw, eleven[0].raw, "pace: normal is the same request as no pace");
  assert.deepEqual(eleven[2].body.voice_settings, { speed: SLOW_RATE });
  assert.deepEqual({ ...eleven[2].body, voice_settings: undefined }, { ...eleven[0].body, voice_settings: undefined }, "nothing else changes");
  // The provider slowed it: the browser is told nothing.
  for (const r of [normal, absent, slow]) assert.equal(r.headers.get(PLAYBACK_RATE_HEADER), null);
});

test("speak, ElevenLabs v4 (no speed control): nothing is sent to the provider, and the reply tells the browser to play the clip slower", async () => {
  const sam = await someone({ tts: "elevenlabs", elevenModel: "eleven_v4", voices: ELEVEN_VOICES });
  eleven.length = 0;
  const normal = await say(sam);
  const slow = await say(sam, { pace: "slow" });
  assert.deepEqual([normal.status, slow.status], [200, 200]);
  assert.equal(eleven[1].raw, eleven[0].raw, "the same request: v4 is never sent a speed");
  assert.equal(normal.headers.get(PLAYBACK_RATE_HEADER), null);
  assert.equal(slow.headers.get(PLAYBACK_RATE_HEADER), String(SLOW_RATE));
});

test("speak, Azure: <prosody rate> for a slow piece only; an HD voice gets none and the browser slows it", async () => {
  const sam = await someone({ tts: "azure", voices: { azure: { "es-MX": { "narrator:female": "es-MX-DaliaNeural" } } } });
  azure.length = 0;
  const normal = await say(sam);
  assert.equal(normal.status, 200, normal.text);
  const slow = await say(sam, { pace: "slow" });
  assert.ok(!azure[0].includes("prosody"));
  assert.match(azure[1], /<voice name="es-MX-DaliaNeural"><prosody rate="0\.8">por favor<\/prosody><\/voice>/);
  assert.equal(slow.headers.get(PLAYBACK_RATE_HEADER), null);
  const hd = await someone({ tts: "azure", voices: { azure: { "es-MX": { "narrator:female": "es-MX-Dalia:DragonHDLatestNeural" } } } });
  azure.length = 0;
  const hdSlow = await say(hd, { pace: "slow" });
  assert.equal(hdSlow.status, 200, hdSlow.text);
  assert.ok(!azure[0].includes("prosody"));
  assert.equal(hdSlow.headers.get(PLAYBACK_RATE_HEADER), String(SLOW_RATE));
});

test("speak, macOS: a slow piece is `say -r` at the fixed rate; a normal one passes no rate", () => {
  assert.deepEqual(sayArgs("Paulina", "/tmp/x.wav", SLOW_RATE).slice(0, 4), ["-v", "Paulina", "-r", String(SAY_SLOW_WPM)]);
  assert.ok(!sayArgs("Paulina", "/tmp/x.wav").includes("-r"));
  assert.ok(!sayArgs("Paulina", "/tmp/x.wav", 1).includes("-r"));
  assert.ok(!sayArgs("", "/tmp/x.wav").includes("-v"));
});

test("speak: a pace that isn't one of the two words is a 400 before any provider call (a raw number is never trusted)", async () => {
  const sam = await someone({ tts: "elevenlabs", elevenModel: "eleven_flash_v2_5", voices: ELEVEN_VOICES });
  eleven.length = 0;
  for (const pace of [0.1, 0.8, 5, "0.5", "fast", "SLOW", true, { speed: 0.1 }]) {
    const r = await say(sam, { pace });
    assert.equal(r.status, 400, JSON.stringify(pace));
    assert.match(r.body.error, /pace must be normal or slow/);
  }
  assert.equal(eleven.length, 0);
});

test("the character card's sound stays at the normal pace, whatever the client adds", async () => {
  const sam = await someone({ tts: "elevenlabs", elevenModel: "eleven_flash_v2_5", voices: ELEVEN_VOICES });
  eleven.length = 0;
  const r = await sam.call("POST", "/api/voice/sound", { text: "杭", locale: "zh-TW", pace: "slow" });
  assert.equal(r.status, 200, r.text);
  assert.equal(eleven.length, 1);
  assert.equal(eleven[0].body.voice_settings, undefined);
  assert.equal(r.headers.get(PLAYBACK_RATE_HEADER), null);
});

test("a turn: the slow part is on the reply's segment, in the stored turn, and back in the next turn's prompt", async () => {
  const sam = await someone({ tts: "elevenlabs", voices: ELEVEN_VOICES });
  const pack = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: { minutes: 10 }, notes: "" };
  const made = await sam.call("POST", "/api/conversations", { mode: "adult", pack, title: "At the market" });
  assert.equal(made.status, 201, made.text);
  const id = made.body.conversation.id;
  fake.answer("NARRATOR-F: One more time, slowly: <slow><t>por favor</t></slow>. Now you.\nGLOSS: por favor = please");
  const r0 = await sam.call("POST", "/api/voice/turn", { mode: "adult", pack, history: [], message: "", elapsedMs: 0, conversationId: id });
  assert.equal(r0.status, 200, r0.text);
  const want = [{ lang: "native", text: "One more time, slowly:" }, { lang: "target", text: "por favor.", slow: true }, { lang: "native", text: "Now you." }];
  assert.deepEqual(r0.body.lines[0].segments, want);
  assert.equal(r0.body.lines[0].text, "One more time, slowly: por favor. Now you.");
  const [row] = await testDb.query("select lines from turns where conversation_id = $1 and role = 'master' order by idx", [id]);
  assert.deepEqual(row.lines[0].segments, want, "stored as it was spoken");
  // The browser replays its history; a slow flag that isn't `true` is dropped.
  const history = [{ role: "master", lines: r0.body.lines, glosses: r0.body.glosses }];
  const r1 = await sam.call("POST", "/api/voice/turn", { mode: "adult", pack, history, message: "[direct] slow down", elapsedMs: 0, conversationId: id });
  assert.equal(r1.status, 200, r1.text);
  const prompt = fake.lastArgs().join("\n");
  assert.match(prompt, /NARRATOR-F: One more time, slowly: <slow><t>por favor\.<\/t><\/slow> Now you\./);
  // The system prompt carries the rule that makes the mark mean something.
  assert.match(prompt, /only the text inside it is spoken slower/);
});
