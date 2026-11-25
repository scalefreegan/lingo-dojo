// A message sent while its page's last reply is still streaming (ld-x8l):
// the page drops the old request and sends the new one at once, before the
// server has let go of the turn. The page's own rule (web/src/turnResend.ts)
// on the real routes, with a stand-in `claude`.
//   node --test scripts/tests/turn-resend.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { resendTurn } from "../../web/src/turnResend.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = copyFixture();
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");

const fake = fakeClaude();
const testDb = await freshDb();
let base, close, sam;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
  await addUser(testDb.db, "robin", undefined, { learners: [ADULT] });
  sam = client(base);
  await sam.login("robin");
  await sam.pick("Sam");
});
after(async () => {
  fake.restore();
  await close();
  await testDb.close();
});

const pack = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };
const body = (id, message) => ({ mode: "adult", pack, history: [], message, elapsedMs: 0, conversationId: id });
const start = async () => (await sam.call("POST", "/api/conversations", { mode: "adult", pack, title: "" })).body.conversation.id;

/** A turn that is running (its model has started), and the way to drop it. */
async function running(id) {
  const before = fake.runs();
  fake.answer("NARRATOR-F: Hola.", 5000);
  const ctrl = new AbortController();
  const gone = sam.call("POST", "/api/voice/turn", body(id, "uno"), {}, { signal: ctrl.signal }).catch((e) => e.name);
  while (fake.runs() === before) await new Promise((r) => setTimeout(r, 10));
  fake.answer("NARRATOR-F: Adiós.");
  return { ctrl, gone };
}

test("the race: a turn sent as the last one is dropped is refused, naming why", async () => {
  const id = await start();
  const { ctrl, gone } = await running(id);
  ctrl.abort();
  const r = await sam.call("POST", "/api/voice/turn", body(id, "dos"));
  await gone;
  assert.deepEqual([r.status, r.body.code], [409, "turn_running"], r.text);
});

/** A turn as the page's api.ts sends it: a refusal is an error with a code. */
const sender = (who, id, message, tries) => async () => {
  tries.n++;
  const r = await who.call("POST", "/api/voice/turn", body(id, message));
  if (r.status !== 200) throw Object.assign(new Error(r.text), { status: r.status, code: r.body?.code });
  return r;
};

test("the page that dropped the turn gets its answer, and only the new turn is stored", async () => {
  for (let i = 0; i < 5; i++) {
    const id = await start();
    const { ctrl, gone } = await running(id);
    ctrl.abort();
    const tries = { n: 0 };
    const r = await resendTurn(sender(sam, id, "dos", tries), Date.now(), new AbortController().signal);
    await gone;
    assert.equal(r.status, 200);
    assert.ok(tries.n > 1, "it was refused first");
    const rows = await testDb.query("select role, text from turns where conversation_id = $1 order by idx", [id]);
    assert.deepEqual(rows.map((t) => t.role), ["learner", "master"]);
    assert.equal(rows[0].text, "dos");
  }
});

test("another tab's running turn is refused at once, never waited for", async () => {
  const id = await start();
  const { ctrl, gone } = await running(id);
  const tries = { n: 0 };
  await assert.rejects(resendTurn(sender(tab(base, sam), id, "dos", tries), null, new AbortController().signal), { code: "turn_running" });
  assert.equal(tries.n, 1);
  ctrl.abort();
  await gone;
});

test("it gives up with the refusal when the time is over; other errors and a drop of its own end it", async () => {
  const no = (code) => async () => { throw Object.assign(new Error("x"), { code }); };
  const live = new AbortController().signal;
  await assert.rejects(resendTurn(no("turn_running"), Date.now(), live, 400), { code: "turn_running" });
  await assert.rejects(resendTurn(no("conversation_ended"), Date.now(), live), { code: "conversation_ended" });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(resendTurn(no("turn_running"), Date.now(), ctrl.signal), { name: "AbortError" });
});
