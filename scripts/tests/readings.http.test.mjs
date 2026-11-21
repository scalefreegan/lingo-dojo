// Readings settled by people over HTTP (ld-4i2, docs/DATA.md §Reading
// corrections and §Shared readings): a learner's correction is theirs alone
// and rereads their bank; a non-admin's goes to the shared list as a
// suggestion, an admin's in active; the admin view, its writes (403 for
// anyone else), its count and its export (no personal data); every
// reading checked; a kids learner can't write; a stale page is a 409. The
// real plugin on an in-process PGlite. Every name here is made up.
//   node --test scripts/tests/readings.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { propose, recordUses } from "../db/sharedReadings.ts";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");

const { apiPlugins } = await import("../../web/server/api.ts");

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await close();
  await testDb.close();
});

const TW = { ...ADULT, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Taiwanese Mandarin" };
const CN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin (Putonghua)" };
const KID_ZH = { ...KID, name: "Bo", targetLanguage: "Mandarin Chinese", targetVariant: "Taiwanese Mandarin" };
let n = 0;
async function someone(learner, { admin = false } = {}) {
  const name = `user${++n}`;
  const made = await addUser(testDb.db, name, undefined, { admin, learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return Object.assign(c, { username: name, userId: made.user.id, made });
}
const addPhrase = async (who, text) => {
  const lang = who.made.learners[0];
  const [row] = await q(
    `insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, meaning_norm, source) values ($1, $2, 'zh-TW', $3, $3, 'x', 'x', 'gloss') returning id`,
    [lang.id, who.languageId, text],
  );
  return row.id;
};

test("a learner's correction: checked, theirs alone, rereads their bank, and goes to the shared list as a suggestion", async () => {
  const mei = await someone(TW);
  const lin = await someone(CN);
  const phrase = await addPhrase(mei, "你得去");
  const other = await addPhrase(lin, "你得去");

  // Every reading is checked before anything keeps it.
  for (const [body, why] of [
    [{ word: "得", reading: "děi", kind: "corrected" }, /two to eight/],
    [{ word: "得去", reading: "děi", kind: "corrected" }, /one syllable/],
    [{ word: "得去", reading: "dǎi qù", kind: "corrected" }, /reading its character has/],
    [{ word: "得去", reading: "děi qù", kind: "wrong" }, /kind/],
    [{ word: "<b>得去</b>", reading: "děi qù", kind: "corrected" }, /two to eight/],
  ]) {
    const r = await mei.call("POST", "/api/readings", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.deepEqual((await q(`select * from reading_corrections`)).length, 0, "nothing kept");

  const r = await mei.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { reading: { word: "得去", reading: "děi qù", kind: "corrected", source: "user" }, shared: "suggested", phrases: 1 });
  // Her bank phrase holds the reading now; Lin's does not.
  assert.deepEqual((await q(`select reading from phrases where id = $1`, [phrase]))[0], { reading: "nǐ děi qù" });
  assert.deepEqual((await q(`select reading from phrases where id = $1`, [other]))[0], { reading: null });
  // Hers to read back; Lin has none.
  assert.deepEqual((await mei.call("GET", "/api/readings")).body, { readings: [{ word: "得去", reading: "děi qù", kind: "corrected", source: "user" }] });
  assert.deepEqual((await lin.call("GET", "/api/readings")).body, { readings: [] });
  // The bank's reply carries it.
  const bank = await mei.call("GET", "/api/phrases?q=%E5%BE%97");
  assert.equal(bank.body.phrases.find((p) => p.id === phrase)?.reading, "nǐ děi qù");
  // A suggestion: not in what browsers get.
  assert.deepEqual((await mei.call("GET", "/api/readings/shared")).body.entries, []);
  const [row] = await q(`select word, key, reading, scope, status, source, by_user, by_recap, suggested_by from shared_readings`);
  assert.deepEqual(row, { word: "得去", key: "得去", reading: "děi qù", scope: "all", status: "suggested", source: "user", by_user: true, by_recap: false, suggested_by: mei.userId });

  // "This is right": hers, nothing shared.
  const ok = await lin.call("POST", "/api/readings", { word: "銀行", reading: "yín háng", kind: "confirmed" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.shared, null);
  assert.equal((await q(`select count(*)::int as n from shared_readings`))[0].n, 1);
});

test("the shared list: an admin's correction is active at once, a suggestion is confirmed by an admin or by two different users; only an admin writes", async () => {
  const ada = await someone(CN, { admin: true });
  const sam = await someone(TW);
  // Sam's suggestion; not an admin: the admin routes are a 403.
  assert.equal((await sam.call("POST", "/api/readings", { word: "倒車", reading: "dào chē", kind: "corrected" })).body.shared, "suggested");
  assert.equal((await sam.call("GET", "/api/readings/admin")).status, 403);
  const [{ id }] = await q(`select id from shared_readings where key = '倒车'`);
  assert.equal((await sam.call("POST", `/api/readings/admin/${id}/confirm`)).status, 403);
  assert.equal((await sam.call("DELETE", `/api/readings/admin/${id}`)).status, 403);
  assert.equal((await sam.call("GET", "/api/readings/admin/export")).status, 403);

  // The admin sees who suggested it, and confirms it.
  const view = await ada.call("GET", "/api/readings/admin");
  assert.equal(view.status, 200);
  const mine = view.body.rows.find((r) => r.id === id);
  assert.equal(mine.suggestedBy, sam.username);
  const before = await ada.call("GET", "/api/readings/shared");
  const conf = await ada.call("POST", `/api/readings/admin/${id}/confirm`);
  assert.equal(conf.status, 200);
  assert.equal(conf.body.rows.find((r) => r.id === id).status, "active");
  const after = await ada.call("GET", "/api/readings/shared");
  assert.deepEqual(after.body.entries.find((e) => e.key === "倒车"), { word: "倒車", key: "倒车", reading: "dào chē", scope: "all" });
  assert.notEqual(after.body.version, before.body.version);
  // Revalidated by its ETag: 304 while unchanged.
  const etag = after.headers.get("etag");
  assert.equal((await ada.call("GET", "/api/readings/shared", undefined, { "If-None-Match": etag })).status, 304);

  // An admin's own correction: active at once, replacing the active reading.
  assert.equal((await ada.call("POST", "/api/readings", { word: "倒车", reading: "dǎo chē", kind: "corrected" })).body.shared, "active");
  const rows = await q(`select reading, status from shared_readings where key = '倒车' order by reading`);
  assert.deepEqual(rows, [{ reading: "dào chē", status: "suggested" }, { reading: "dǎo chē", status: "active" }]);

  // Sam's own recap and Sam agreeing: one person, one vote: still a suggestion.
  const yixiu = { word: "一宿", key: "一宿", reading: "yī xiǔ", scope: "all" };
  assert.equal(await propose(testDb.db, yixiu, "recap", sam.userId), "suggested");
  assert.equal((await sam.call("POST", "/api/readings", { word: "一宿", reading: "yī xiǔ", kind: "corrected" })).body.shared, "suggested");
  assert.equal((await sam.call("POST", "/api/readings", { word: "一宿", reading: "yī xiǔ", kind: "confirmed" })).body.shared, "suggested");
  // A recap with no owner is no one's vote.
  assert.equal(await propose(testDb.db, yixiu, "recap", null), "suggested");
  // A second, different user: active with no admin.
  const kai = await someone(CN);
  assert.equal((await kai.call("POST", "/api/readings", { word: "一宿", reading: "yī xiǔ", kind: "corrected" })).body.shared, "active");
  assert.equal(((await ada.call("GET", "/api/readings/admin")).body.rows.find((r) => r.key === "一宿")).votes, 2);
  // Disagreeing users: both readings stay suggestions.
  assert.equal(await propose(testDb.db, { word: "长着", key: "长着", reading: "zhǎng zhe", scope: "all" }, "recap", kai.userId), "suggested");
  assert.equal((await sam.call("POST", "/api/readings", { word: "長著", reading: "cháng zhe", kind: "corrected" })).body.shared, "suggested");
  // Proposing an active reading again leaves it as it was: the browsers'
  // cache version does not move.
  const v1 = (await sam.call("GET", "/api/readings/shared")).body.version;
  assert.equal(await propose(testDb.db, yixiu, "recap", sam.userId), "active");
  assert.equal(await propose(testDb.db, { word: "倒车", key: "倒车", reading: "dǎo chē", scope: "all" }, "admin", ada.userId), "active");
  assert.equal((await sam.call("GET", "/api/readings/shared")).body.version, v1);

  // Remove.
  const del = await ada.call("DELETE", `/api/readings/admin/${id}`);
  assert.equal(del.status, 200);
  assert.ok(!del.body.rows.some((r) => r.id === id));
  assert.equal((await ada.call("DELETE", `/api/readings/admin/${id}`)).status, 404);
  assert.equal((await ada.call("POST", "/api/readings/admin/not-an-id/confirm")).status, 404);
});

test("one user adds at most MAX_DAILY_VOTES votes a day, by hand or by their recaps; a vote they already gave is not counted again", async () => {
  const sol = await someone(TW);
  const { MAX_DAILY_VOTES, SharedLimitError } = await import("../db/sharedReadings.ts");
  // Fill today's votes straight into the table (one entry each).
  for (let i = 0; i < MAX_DAILY_VOTES; i++) {
    const [row] = await q(`insert into shared_readings (key, word, reading, status, source, suggested_by) values ($1, $1, 'x y', 'suggested', 'user', $2) returning id`, [`测${String.fromCodePoint(0x4e00 + i)}`, sol.userId]);
    await q(`insert into shared_reading_votes (shared_reading_id, user_id, source) values ($1, $2, 'user')`, [row.id, sol.userId]);
  }
  // Her correction is still hers, but adds nothing to the shared list.
  const r = await sol.call("POST", "/api/readings", { word: "倒車", reading: "dǎo chē", kind: "corrected" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.shared, null);
  assert.equal(r.body.reading.reading, "dǎo chē");
  await assert.rejects(propose(testDb.db, { word: "一行", key: "一行", reading: "yī háng", scope: "all" }, "recap", sol.userId), SharedLimitError);
  // Another user is not limited by her.
  const tom = await someone(TW);
  assert.equal((await tom.call("POST", "/api/readings", { word: "抽空", reading: "chōu kòng", kind: "corrected" })).body.shared, "suggested");
  // A vote older than a day doesn't count.
  await q(`update shared_reading_votes set created_at = now() - interval '25 hours' where user_id = $1`, [sol.userId]);
  assert.equal((await sol.call("POST", "/api/readings", { word: "抽空", reading: "chōu kòng", kind: "corrected" })).body.shared, "active", "hers and Tom’s");
});

test("the export: active words and readings only, YAML or JSON, nothing personal; the 30-day count", async () => {
  const ada = await someone(CN, { admin: true });
  await ada.call("POST", "/api/readings", { word: "还书", reading: "huán shū", kind: "corrected" });
  const yaml = await ada.call("GET", "/api/readings/admin/export?format=yaml");
  assert.equal(yaml.status, 200);
  assert.match(yaml.headers.get("content-disposition"), /attachment; filename="shared-readings.yaml"/);
  assert.match(yaml.text, /- \{ word: "还书", reading: "huán shū" \}/);
  const json = JSON.parse((await ada.call("GET", "/api/readings/admin/export?format=json")).text);
  assert.ok(json.readings.some((e) => e.word === "还书" && e.reading === "huán shū"));
  // No user, learner or row id anywhere, and no suggestion.
  const users = await q(`select id, username from users`);
  const learners = await q(`select id, name from learners`);
  for (const text of [yaml.text, JSON.stringify(json)]) {
    for (const u of users) assert.ok(!text.includes(u.id) && !text.includes(u.username), `no ${u.username}`);
    for (const l of learners) assert.ok(!text.includes(l.id) && !text.includes(`"${l.name}"`), `no learner ${l.name}`);
    for (const r of await q(`select id from shared_readings`)) assert.ok(!text.includes(r.id));
    assert.ok(!text.includes("dào chē"), "a suggestion is not exported");
  }
  for (const key of Object.keys(json.readings[0])) assert.ok(["word", "simplified", "reading", "scope"].includes(key), key);

  // The count: sessions recapped in the last 30 days.
  const conv = await q(
    `insert into conversations (learner_id, language_profile_id, mode, target_language, target_variant, native_language, pack_snapshot) select learner_id, id, 'adult', 'Mandarin Chinese', '', 'English', '{}'::jsonb from language_profiles limit 1 returning id`,
  );
  await recordUses(testDb.db, conv[0].id, 3);
  await recordUses(testDb.db, conv[0].id, 4);
  const view = await ada.call("GET", "/api/readings/admin");
  assert.deepEqual(view.body.changed30d, { changed: 4, sessions: 1 }, "a recap made again replaces its count");
});

test("a kids learner can't correct; a language that isn't Mandarin can't; a stale page is a 409", async () => {
  const bo = await someone(KID_ZH);
  const r = await bo.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" });
  assert.equal(r.status, 403);
  assert.deepEqual((await bo.call("GET", "/api/readings")).body, { readings: [] });
  const sam = await someone(ADULT);
  assert.equal((await sam.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" })).status, 400);
  const mei = await someone(TW);
  const real = mei.languageId;
  mei.languageId = "00000000-0000-4000-8000-000000000000";
  const stale = await mei.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale_learner");
  assert.equal((await mei.call("GET", "/api/readings")).status, 409);
  mei.languageId = real;
  // Logged out: 401 for the shared list too.
  assert.equal((await client(base).call("GET", "/api/readings/shared")).status, 401);
});
