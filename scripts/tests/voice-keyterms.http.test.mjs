// Scribe keyterms on the Go tab's /api/voice/transcribe (ld-7q4), end to end:
// a transcription that names a conversation is told the scene's own vocab
// (read server-side from the conversation's scenario) and the learner's
// recent phrases besides the master's last phrases; no conversation, no
// scene terms; another learner's conversation id gives nothing; Practice's
// speak-it still sends none. ElevenLabs is stubbed in fetch: nothing here
// reaches a provider. Every name here is made up.
//   node --test scripts/tests/voice-keyterms.http.test.mjs

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-keyterms-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
delete process.env.LINGO_AUDIO_DIR;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const forms = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  if (url.pathname === "/v1/speech-to-text") {
    forms.push({ keyterms: init.body.getAll("keyterms"), language: init.body.get("language_code") });
    return new Response(JSON.stringify({ text: "hola" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};

const { apiPlugins } = await import("../../web/server/api.ts");
const fake = fakeClaude();
const testDb = await freshDb();
let base, close, sam, ana;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
  await addUser(testDb.db, "robin", undefined, { learners: [ADULT, { ...ADULT, name: "Ana" }] });
  sam = client(base);
  await sam.login("robin");
  await sam.pick("Sam");
  ana = client(base);
  await ana.login("robin");
  await ana.pick("Ana");
});
after(async () => {
  fake.restore();
  await close();
  await testDb.close();
});

const pack = () => ({ title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: { minutes: 10 }, notes: "", random_scene: null });
const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
const listen = (who, query) => who.call("POST", `/api/voice/transcribe?locales=es-MX,en-US${query}`, wav, { "Content-Type": "audio/wav" });

test("a transcription naming its conversation carries the scene's vocab and recent phrases, never more than the server read", async () => {
  const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: pack(), title: "At the market" });
  assert.equal(c.status, 201, c.text);
  // Starting the session put the scene's vocab into the bank too; clear it
  // so the vocab can only come from the scenario.
  await testDb.query("delete from phrases");
  await sam.call("POST", "/api/phrases", { text: "la vuelta", meaning: "the change" });
  forms.length = 0;
  const r = await listen(sam, `&conversation=${c.body.conversation.id}&term=${encodeURIComponent("¡Buenas tardes!")}`);
  assert.equal(r.status, 200, r.text);
  const terms = forms[0].keyterms;
  assert.equal(forms[0].language, "es");
  assert.deepEqual(terms.slice(0, 1), ["Buenas tardes"], "the master's last phrase first");
  for (const want of ["Cuánto cuesta", "kilo | medio", "la vuelta"]) assert.ok(terms.includes(want), `${want} in ${JSON.stringify(terms)}`);
  assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, terms.length, "no duplicates");
  assert.ok(terms.length <= 100);
});

test("no conversation: only what the page heard; a stranger's or malformed id: no scene terms; a learner not on the page is refused", async () => {
  const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: pack(), title: "At the market" });
  forms.length = 0;
  await listen(sam, "");
  await listen(sam, `&term=${encodeURIComponent("buen día")}`);
  await listen(ana, `&conversation=${c.body.conversation.id}`);
  await listen(sam, "&conversation=not-an-id");
  assert.deepEqual(forms.map((f) => f.keyterms), [[], ["buen día"], [], []]);
  const stale = await sam.call("POST", "/api/voice/transcribe?locales=es-MX", wav, { "Content-Type": "audio/wav", "X-Learner-Id": "00000000-0000-0000-0000-000000000000" });
  assert.equal(stale.status, 409);
});

const freeze = (id, key, value) =>
  testDb.query("update conversations set pack_snapshot = jsonb_set(pack_snapshot, $2, $3::jsonb) where id = $1", [id, `{${key}}`, JSON.stringify(value)]);

test("a phrase in the conversation's frozen review is never hinted, from any source (it would hear a near miss into the right recall)", async () => {
  const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: pack(), title: "At the market" });
  await sam.call("POST", "/api/phrases", { text: "la vuelta", meaning: "the change" });
  // "kilo | medio" is both the scene's vocab and in the bank (starting the
  // session put it there); freeze it as this session's review.
  const [row] = await testDb.query("select id from phrases where text = 'kilo | medio' limit 1");
  await freeze(c.body.conversation.id, "review", { phraseIds: [row.id] });
  forms.length = 0;
  // ...and the master having just said it (a term= the page sends) too.
  const r = await listen(sam, `&conversation=${c.body.conversation.id}&term=${encodeURIComponent("kilo | medio")}&term=${encodeURIComponent("buen día")}`);
  assert.equal(r.status, 200, r.text);
  const terms = forms[0].keyterms;
  assert.ok(!terms.includes("kilo | medio"), JSON.stringify(terms));
  for (const want of ["buen día", "Cuánto cuesta", "la vuelta"]) assert.ok(terms.includes(want), `${want} in ${JSON.stringify(terms)}`);
});

test("a revisit's kept phrases are never hinted either", async () => {
  const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: pack(), title: "At the market" });
  await freeze(c.body.conversation.id, "revisit", {
    from: "x", startedAt: new Date().toISOString(), title: "t", summary: "s", kept: [{ text: "Cuánto cuesta", meaning: "how much" }], corrections: [], events: [],
  });
  forms.length = 0;
  await listen(sam, `&conversation=${c.body.conversation.id}`);
  assert.ok(!forms[0].keyterms.includes("Cuánto cuesta"), JSON.stringify(forms[0].keyterms));
  assert.ok(forms[0].keyterms.includes("kilo | medio"));
});

test("a First steps drill gets no keyterms at all: not the scene, the bank or the master's phrases", async () => {
  fs.writeFileSync(
    path.join(root, "scenarios", "drill-market.md"),
    ["---", "id: drill-market", "title: Market words", "summary: Drill a few market words.", "language: es-MX", "format: drill", "beats:", "  - Round one", "vocab:", '  - { term: "mango", gloss: "mango" }', "---", "Drill the words.", ""].join("\n"),
  );
  const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: { ...pack(), scenario: "drill-market" }, title: "Drill" });
  assert.equal(c.status, 201, c.text);
  await sam.call("POST", "/api/phrases", { text: "la vuelta", meaning: "the change" });
  forms.length = 0;
  await listen(sam, `&conversation=${c.body.conversation.id}&term=mango`);
  assert.deepEqual(forms[0].keyterms, []);
});
