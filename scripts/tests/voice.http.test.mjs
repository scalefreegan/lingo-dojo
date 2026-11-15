// The voice routes end to end over HTTP (web/server/voice.ts on the real
// plugin), with no provider configured: LINGO_ENV_FILE points at nothing and
// the key variables are cleared, so nothing here can reach ElevenLabs or
// Azure. What it pins is the part that must hold with or without keys — the
// settings file, locale resolution, input validation, the setup hints, and
// that no reply ever carries a key. Logged in (an in-process PGlite), since
// every voice route is behind a session and the settings are per user.
//   node --test scripts/tests/voice.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { updateVoiceSettings } from "../db/accounts.ts";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");

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
  await close();
  await testDb.close();
});

const call = (...args) => session.call(...args);

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

test("PUT settings: merges, normalizes, and lands in the user's settings row, not data/voice.json", async () => {
  const r = await call("PUT", "/api/voice/settings", {
    turn: "pause",
    silenceMs: 50,
    voices: { elevenlabs: { "es-MX": { "narrator:female": "abc", wizard: "x" } } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.turn, "pause");
  assert.equal(r.body.settings.silenceMs, r.body.silence.min, "clamped");
  assert.deepEqual(r.body.settings.voices, { elevenlabs: { "es-MX": { "narrator:female": "abc" } } });
  const [row] = await testDb.query("select s.voice from user_settings s join users u on u.id = s.user_id where u.username = 'robin'");
  assert.equal(row.voice.turn, "pause");
  assert.ok(!fs.existsSync(path.join(dataDir, "voice.json")), "nothing written under data/");
  const again = await call("PUT", "/api/voice/settings", { review: false });
  assert.equal(again.body.settings.turn, "pause", "a partial PUT keeps the rest");
  assert.equal(again.body.settings.review, false);
  assert.equal((await call("PUT", "/api/voice/settings", [1])).status, 400);
});

test("PUT settings: the last session length merges per mode; the choices come with the reply", async () => {
  const first = await call("PUT", "/api/voice/settings", { sessionMinutes: { kids: 5 } });
  assert.deepEqual(first.body.minuteChoices, { adult: [5, 10, 15, 20, 30], kids: [3, 5, 10] });
  const r = await call("PUT", "/api/voice/settings", { sessionMinutes: { adult: 15 } });
  assert.deepEqual(r.body.settings.sessionMinutes, { adult: 15, kids: 5 }, "the other mode's choice is kept");
  const cleared = await call("PUT", "/api/voice/settings", { sessionMinutes: { adult: null } });
  assert.deepEqual(cleared.body.settings.sessionMinutes, { adult: null, kids: 5 }, "null is No limit");
  const junk = await call("PUT", "/api/voice/settings", { sessionMinutes: { kids: 30 } });
  assert.deepEqual(junk.body.settings.sessionMinutes, { adult: null, kids: null }, "not a kids length");
});

test("POST /api/voice/turn honors the mode: a kids pack with minutes gets the kids Time budget and kids clock line", async () => {
  // A stand-in `claude` first on PATH: it records its arguments (the system
  // prompt and the turn prompt) and answers with one line, so the route runs
  // end to end without spawning the real CLI.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-fake-claude-"));
  const log = path.join(bin, "args.json");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "result", result: "NARRATOR-F: Hola.\\nSTAGE: beat:1" }));\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  // Kids mode is the kids learner's.
  await session.pick("Pip");
  try {
    const pack = { title: "k", created: "", scenario: "farm", quick_scenario: "", units: ["intro-game", "story-quest", "game-echo"], overrides: { minutes: 5 }, notes: "" };
    const history = [{ role: "learner", text: "[session start]" }, { role: "master", lines: [{ speaker: "narrator", gender: "female", text: "Hi", segments: [] }], stage: "beat:1" }];
    const r = await call("POST", "/api/voice/turn", { mode: "kids", pack, history, message: "moo", elapsedMs: 4.5 * 60_000 });
    assert.equal(r.status, 200, r.text);
    const sent = JSON.parse(fs.readFileSync(log, "utf8")).join("\n");
    assert.match(sent, /## Time budget\n\nThe learner has \*\*5 minutes\*\*/);
    assert.match(sent, /- Story: [^\n]*Echo game/, "the kids plan, not the adult one");
    assert.match(sent, /CLOCK \(from the app, not the learner\): 4 of 5 minutes used, 1 left; current part: beat:1 [^\n]*Start bringing the story to its end now/);
    // No limit: neither the section nor the line.
    const none = await call("POST", "/api/voice/turn", { mode: "kids", pack: { ...pack, overrides: {} }, history, message: "moo", elapsedMs: 4.5 * 60_000 });
    assert.equal(none.status, 200, none.text);
    assert.doesNotMatch(JSON.parse(fs.readFileSync(log, "utf8")).join("\n"), /Time budget|CLOCK/);
  } finally {
    await session.pick("Sam");
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

/** A stand-in `claude` first on PATH that answers one line after `delayMs`,
 *  touching `ran` so a test can tell whether a turn reached it. */
function fakeClaude(delayMs) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-fake-claude-"));
  const ran = path.join(bin, "ran");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(ran)}, "x");\nsetTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "NARRATOR-F: Hola." })), ${delayMs});\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  return {
    runs: () => (fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").length : 0),
    restore() {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

const adultPack = { title: "a", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };

test("a turn or cast from a page showing another learner than the session's is a 409 stale_learner, and nothing runs", async () => {
  const fake = fakeClaude(0);
  // A second adult learner for robin, picked in a second tab: the mode
  // alone can't tell the two pages apart.
  const made = await call("POST", "/api/learners", { name: "Ana", mode: "adult", target_language: "French" });
  const other = tab(base, session);
  try {
    await other.pick("Ana");
    const turn = { mode: "adult", pack: adultPack, history: [], message: "" };
    const stale = await call("POST", "/api/voice/turn", turn);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_learner");
    const cast = await call("POST", "/api/voice/cast", { mode: "adult", locale: "es-MX", units: [] });
    assert.equal(cast.status, 409);
    assert.equal(cast.body.code, "stale_learner");
    assert.equal(fake.runs(), 0, "the stale tab's turn never reached claude");
    // A page that names no learner is refused the same way.
    const none = await other.call("POST", "/api/voice/turn", turn, { "X-Learner-Id": "" });
    assert.equal(none.body.code, "stale_learner");
    // The current tab's turn runs, with Ana's profile.
    const ok = await other.call("POST", "/api/voice/turn", turn);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(fake.runs(), 1);
  } finally {
    await session.pick("Sam");
    await call("POST", `/api/learners/${made.body.learner.id}/archive`, {});
    fake.restore();
  }
});

test("the turn lock is per login session: two devices on one account don't block each other; one session can't overlap", async () => {
  const fake = fakeClaude(400);
  const device2 = client(base);
  await device2.login("robin");
  await device2.pick("Sam");
  try {
    const turn = { mode: "adult", pack: adultPack, history: [], message: "" };
    const [a, b] = await Promise.all([call("POST", "/api/voice/turn", turn), device2.call("POST", "/api/voice/turn", turn)]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    const [c, d] = await Promise.all([call("POST", "/api/voice/turn", turn), tab(base, session).call("POST", "/api/voice/turn", turn)]);
    assert.deepEqual([c.status, d.status].sort(), [200, 409], "two tabs share a session, and its lock");
    const locked = c.status === 409 ? c : d;
    assert.match(locked.body.error, /still answering/);
    assert.equal(locked.body.code, undefined, "an ordinary 409, not stale_learner");
  } finally {
    fake.restore();
  }
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
  // Adding a library voice changes the owner's ElevenLabs account: admins
  // only, so robin (not one) is refused before anything is checked.
  const add = await call("POST", "/api/voice/library/add", { ownerId: "x", voiceId: "y", name: "z" });
  assert.equal(add.status, 403);
  assert.equal(add.body.error, "only an admin can do that");
  assert.equal((await call("GET", "/api/voice/cast")).status, 405);
  assert.equal((await call("POST", "/api/voice/cast", { mode: "adult", locale: "spanish", units: [] })).status, 400);
  assert.equal((await call("POST", "/api/voice/cast", { mode: "teen", locale: "es-MX", units: [] })).status, 400);
  // The mode is the active learner's (Sam, adult): a body naming kids is a
  // 400 before anything runs.
  const turnKids = await call("POST", "/api/voice/turn", { mode: "kids", pack: {}, history: [], message: "" });
  assert.equal(turnKids.status, 400);
  assert.match(turnKids.body.error, /adult mode, not kids/);
  const castKids = await call("POST", "/api/voice/cast", { mode: "kids", locale: "es-MX", units: [] });
  assert.equal(castKids.status, 400);
  assert.match(castKids.body.error, /adult mode, not kids/);
});

test("speak with the saved provider unconfigured says so; cross-origin is refused", async () => {
  await call("PUT", "/api/voice/settings", { tts: "elevenlabs" });
  const r = await call("POST", "/api/voice/speak", { speaker: "narrator", text: "hola", locale: "es-MX" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ElevenLabs is not set up/);
  const x = await call("GET", "/api/voice/settings", undefined, { Origin: "https://evil.example" });
  assert.equal(x.status, 403);
});

test("overlapping settings saves for one account all land: none reads the row before another's write and undoes it", async () => {
  // The route end to end: each save is a merge, and together they all land.
  // (Whether these requests overlap inside the database depends on timing;
  // the next test forces the interleaving.) A user with no settings row yet,
  // so the first saves also race to make it.
  await addUser(testDb.db, "noor", undefined, { learners: [ADULT] });
  const noor = client(base);
  await noor.login("noor");
  // What the panel can send at once: the speaking provider, the listening
  // provider, turn-taking, review, and each mode's session length.
  const puts = [{ tts: "system" }, { stt: "azure" }, { turn: "pause" }, { review: true }, { sessionMinutes: { adult: 15 } }, { sessionMinutes: { kids: 5 } }];
  for (let round = 0; round < 3; round++) {
    await testDb.query("delete from user_settings using users where users.id = user_settings.user_id and users.username = 'noor'");
    const replies = await Promise.all(puts.map((p) => noor.call("PUT", "/api/voice/settings", p)));
    for (const r of replies) assert.equal(r.status, 200, r.text);
    const { settings } = (await noor.call("GET", "/api/voice/settings")).body;
    assert.equal(settings.tts, "system", `round ${round}`);
    assert.equal(settings.stt, "azure", `round ${round}`);
    assert.equal(settings.turn, "pause", `round ${round}`);
    assert.equal(settings.review, true, `round ${round}`);
    assert.deepEqual(settings.sessionMinutes, { adult: 15, kids: 5 }, `round ${round}`);
  }
});

// The HTTP test above can pass even without the lock: each request does a
// few queries before its read, which staggers them. This one starts every
// read before any write, which is exactly the interleaving that loses an
// update without the transaction (verified by putting the old read-then-
// upsert back). On PGlite the fix holds because the transactions run one at
// a time; first-run.pg.test.mjs checks the row lock on a real Postgres.
test("updateVoiceSettings: eight overlapping read-merge-writes for one user, all kept, row made by the first", async () => {
  const { user } = await addUser(testDb.db, "ines");
  const changes = await Promise.all(
    Array.from({ length: 8 }, (_, i) => updateVoiceSettings(testDb.db, user.id, (stored) => ({ ...(stored ?? {}), [`k${i}`]: i }))),
  );
  assert.equal(changes.length, 8);
  const [row] = await testDb.query("select voice from user_settings where user_id = $1", [user.id]);
  assert.deepEqual(Object.keys(row.voice).sort(), ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
});

test("voice settings are per user: a second account starts from the defaults and never sees or changes the first's", async () => {
  await addUser(testDb.db, "lee", undefined, { learners: [KID] });
  const lee = client(base);
  await lee.login("lee");
  await call("PUT", "/api/voice/settings", { turn: "pause", voices: { system: { "es-MX": { "narrator:female": "Paulina" } } } });
  const fresh = await lee.call("GET", "/api/voice/settings");
  assert.equal(fresh.status, 200, "no learner needed for settings");
  assert.equal(fresh.body.settings.turn, "tap", "the default, not robin's");
  assert.deepEqual(fresh.body.settings.voices, {});
  await lee.call("PUT", "/api/voice/settings", { turn: "tap", review: true, voices: {} });
  const mine = await call("GET", "/api/voice/settings");
  assert.equal(mine.body.settings.turn, "pause", "lee's PUT left robin's alone");
  assert.deepEqual(mine.body.settings.voices, { system: { "es-MX": { "narrator:female": "Paulina" } } });
  // Logged out, there are no settings to read.
  assert.equal((await client(base).call("GET", "/api/voice/settings")).status, 401);
});
