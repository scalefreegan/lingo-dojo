// The voice routes end to end over HTTP (web/server/voice.ts on the real
// plugin), with no provider configured: LINGO_ENV_FILE points at nothing and
// the key variables are cleared, so nothing here can reach ElevenLabs or
// Azure. What it pins is the part that must hold with or without keys — the
// settings file, locale resolution, input validation, the setup hints, and
// that no reply ever carries a key.
//   node --test scripts/tests/voice.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");

let base, close;
before(async () => ({ base, close } = await serveApi(apiPlugins)));
after(() => close());

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* audio or empty */
  }
  return { status: res.status, body: json, text };
};

test("GET settings: defaults, nothing configured, locales from the query", async () => {
  const r = await call("GET", "/api/voice/settings?target=Mandarin+Chinese&variant=Taiwanese+Mandarin&native=English");
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.tts, "elevenlabs");
  assert.equal(r.body.configured.elevenlabs, false);
  assert.equal(r.body.configured.azure, false);
  assert.deepEqual(r.body.locales, { target: "zh-TW", native: "en-US" });
  assert.deepEqual(r.body.speakers.kids, ["narrator", "sidekick", "character"]);
  assert.deepEqual(r.body.slots.adult, ["narrator:female", "narrator:male", "character:female", "character:male"]);
  assert.ok(r.body.models.some((m) => m.id === r.body.settings.model));
  const bare = await call("GET", "/api/voice/settings");
  assert.deepEqual(bare.body.locales, { target: null, native: null });
});

test("PUT settings: merges, normalizes, and lands in data/voice.json", async () => {
  const r = await call("PUT", "/api/voice/settings", {
    turn: "pause",
    silenceMs: 50,
    voices: { elevenlabs: { "es-MX": { "narrator:female": "abc", wizard: "x" } } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.turn, "pause");
  assert.equal(r.body.settings.silenceMs, r.body.silence.min, "clamped");
  assert.deepEqual(r.body.settings.voices, { elevenlabs: { "es-MX": { "narrator:female": "abc" } } });
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, "voice.json"), "utf8"));
  assert.equal(disk.turn, "pause");
  const again = await call("PUT", "/api/voice/settings", { review: false });
  assert.equal(again.body.settings.turn, "pause", "a partial PUT keeps the rest");
  assert.equal(again.body.settings.review, false);
  assert.equal((await call("PUT", "/api/voice/settings", [1])).status, 400);
});

test("unconfigured providers answer 400 with where the key goes", async () => {
  const v = await call("GET", "/api/voice/voices?provider=elevenlabs&locale=es-MX");
  assert.equal(v.status, 400);
  assert.match(v.body.error, /ELEVENLABS_API_KEY/);
  const az = await call("GET", "/api/voice/voices?provider=azure&locale=es-MX");
  assert.match(az.body.error, /AZURE_SPEECH_KEY and AZURE_SPEECH_REGION/);
  const lib = await call("GET", "/api/voice/library?locale=es-MX");
  assert.equal(lib.status, 400);
  assert.match(lib.body.error, /ELEVENLABS_API_KEY/);
  const t = await call("POST", "/api/voice/transcribe?locales=es-MX,en-US", new Uint8Array([1, 2, 3]), { "Content-Type": "audio/wav" });
  assert.equal(t.status, 400);
  assert.match(t.body.error, /not set up/);
});

test("input validation", async () => {
  assert.equal((await call("GET", "/api/voice/voices?provider=nope&locale=es-MX")).status, 400);
  assert.equal((await call("GET", "/api/voice/voices?provider=system&locale=spanish")).status, 400);
  assert.equal((await call("POST", "/api/voice/transcribe", "", { "Content-Type": "audio/wav" })).status, 400);
  assert.equal((await call("POST", "/api/voice/speak", { speaker: "narrator", text: "", locale: "es-MX" })).status, 400);
  assert.equal((await call("POST", "/api/voice/speak", { speaker: "wizard", text: "hola", locale: "es-MX" })).status, 400);
  assert.equal((await call("POST", "/api/voice/speak", { speaker: "narrator", text: "hola", locale: "xx" })).status, 400);
  assert.equal((await call("POST", "/api/voice/speak", { speaker: "narrator", text: "x".repeat(2001), locale: "es-MX" })).status, 413);
  assert.equal((await call("POST", "/api/voice/turn", { mode: "teen", pack: {} })).status, 400);
  assert.equal((await call("POST", "/api/voice/turn", { mode: "adult" })).status, 400);
  assert.equal((await call("GET", "/api/voice/turn")).status, 405);
  assert.equal((await call("GET", "/api/voice/nope")).status, 404);
  assert.equal((await call("GET", "/api/voice/library?locale=spanish")).status, 400);
  assert.equal((await call("GET", "/api/voice/library/add")).status, 405);
});

test("speak with the saved provider unconfigured says so; cross-origin is refused", async () => {
  await call("PUT", "/api/voice/settings", { tts: "elevenlabs" });
  const r = await call("POST", "/api/voice/speak", { speaker: "narrator", text: "hola", locale: "es-MX" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ElevenLabs is not set up/);
  const x = await call("GET", "/api/voice/settings", undefined, { Origin: "https://evil.example" });
  assert.equal(x.status, 403);
});
