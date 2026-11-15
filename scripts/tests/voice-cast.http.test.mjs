// /api/voice/cast end to end with ElevenLabs stubbed (ld-tvs): a Mandarin
// session once got German and Spanish voices, because the Voice Library
// answers 400 to the locale "zh-TW" and the failure was swallowed. The stub
// answers the way the real API does; nothing here reaches the network.
//   node --test scripts/tests/voice-cast.http.test.mjs

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-cast-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");

// The account: no Mandarin voice; German, Spanish and premade English ones.
const ACCOUNT = {
  voices: [
    ...["male", "female"].flatMap((g) => [
      { voice_id: `de_${g}`, name: `German ${g}`, labels: { language: "de", gender: g }, category: "professional" },
      { voice_id: `es_${g}`, name: `Spanish ${g}`, labels: { language: "es", gender: g }, category: "professional" },
      { voice_id: `en_${g}`, name: `English ${g}`, labels: { language: "en", gender: g }, category: "premade" },
    ]),
  ],
};
const lib = (prefix, n, gender) => ({ voices: Array.from({ length: n }, (_, i) => ({ voice_id: `${prefix}_${gender}_${i}`, public_owner_id: "o", name: `${prefix} ${gender} ${i}`, gender })) });

/** What the stubbed library does with a search. */
let library = () => ({ status: 200, body: { voices: [] } });
const searches = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v2/voices") return json(200, ACCOUNT);
  if (url.pathname === "/v1/shared-voices") {
    searches.push(url.search);
    const r = library(url.searchParams);
    return json(r.status, r.body);
  }
  return json(404, { detail: "not stubbed" });
};

const testDb = await freshDb();
let base, close, session;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
  await addUser(testDb.db, "robin", undefined, { learners: [ADULT, KID] });
  session = client(base);
  await session.login("robin");
  await session.pick("Sam");
});
after(async () => {
  globalThis.fetch = realFetch;
  await close();
  await testDb.close();
});

const cast = async (locale, extra = {}) => {
  searches.length = 0;
  const r = await session.call("POST", "/api/voice/cast", { mode: "adult", locale, units: [], ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const ids = (c) => Object.values(c.cast).map((v) => v.id);

test("zh-TW searches the library as cmn-TW and casts its voices", async () => {
  // The real API: 400 for the BCP-47 spelling, voices for its own.
  library = (q) => (q.get("locale") === "zh-TW" || q.get("locale") === "zh-CN" ? { status: 400, body: { detail: { message: "Invalid locale received" } } } : { status: 200, body: lib("tw", 6, q.get("gender")) });
  const c = await cast("zh-TW");
  assert.ok(searches.length > 0 && searches.every((s) => s.includes("locale=cmn-TW") && s.includes("language=zh")), searches.join(" "));
  assert.ok(ids(c).length === 4 && ids(c).every((id) => id.startsWith("tw_")), ids(c).join(","));
});

test("a thin locale widens to the language: the Taiwanese voices first, then other Mandarin, never German", async () => {
  library = (q) => ({ status: 200, body: q.get("locale") ? lib("tw", 1, q.get("gender")) : lib("cn", 10, q.get("gender")) });
  for (let n = 0; n < 5; n++) {
    const c = await cast("zh-TW");
    const got = ids(c);
    assert.ok(got.every((id) => /^(tw|cn)_/.test(id)), got.join(","));
    assert.equal(got.filter((id) => id.startsWith("tw_")).length, 2, "the one Taiwanese voice of each gender is always drawn");
  }
  assert.ok(searches.some((s) => !s.includes("locale=")), "a second, language-only search");
});

test("a library that refuses or fails leaves only the learner's own language, not German or Spanish", async () => {
  for (const status of [400, 500]) {
    library = () => ({ status, body: { detail: { message: "no" } } });
    for (let n = 0; n < 5; n++) {
      // No nativeLocale in the body (an old tab): the learner's is used.
      const c = await cast("zh-TW");
      assert.ok(ids(c).length > 0 && ids(c).every((id) => id.startsWith("en_")), `${status}: ${ids(c).join(",")}`);
      assert.ok(Object.values(c.fallbacks ?? {}).every((id) => id.startsWith("en_")));
    }
  }
  // A failure that isn't about the locale isn't asked again wider.
  assert.ok(searches.every((s) => s.includes("locale=cmn-TW")), searches.join(" "));
});

test("Cantonese is never searched as zh (that returns Mandarin voices)", async () => {
  library = (q) => ({ status: 200, body: lib("cn", 10, q.get("gender")) });
  const c = await cast("zh-HK");
  assert.equal(searches.length, 0);
  assert.ok(ids(c).every((id) => id.startsWith("en_")), ids(c).join(","));
});
