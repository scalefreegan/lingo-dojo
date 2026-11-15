// One rule for a phrase left unseen, whichever undo comes last
// (scripts/db/phrases.ts settleUnseen): a dropped reply's (unrecordGlosses)
// and a recap re-run's (scripts/db/extraction.ts). A phrase both a gloss and
// a recap sighted goes when the second of the two undoes leaves it with no
// sighting, no reviewed card and nothing the learner set, in either order.
// In-process PGlite; every name here is made up.
//   node --test scripts/tests/extraction-undo.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createLearner, createUser } from "../db/accounts.ts";
import { applyExtraction, claimExtraction } from "../db/extraction.ts";
import { recordGlosses, unrecordGlosses, updatePhrase } from "../db/phrases.ts";
import { normKey } from "../match.mjs";
import { ADULT } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const { db, query: q, close } = await freshDb();
test.after(() => close());

let n = 0;
async function profileOf() {
  const user = await createUser(db, { username: `undo${++n}`, passwordHash: "x" });
  const l = await createLearner(db, user.id, ADULT);
  const [{ id }] = await q("select id from language_profiles where learner_id = $1", [l.id]);
  return { id, learnerId: l.id };
}

/** A conversation with a master turn whose line is `line` and a learner turn. */
async function conversation(profile, line, { open = false } = {}) {
  const id = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await q(
    `insert into conversations (id, learner_id, language_profile_id, pack_snapshot, title, mode, target_language, target_variant, ended_at)
     values ($1, $2, $3, '{}', 'Undo', 'adult', 'Spanish', 'Mexican Spanish', ${open ? "null" : "now()"})`,
    [id, profile.learnerId, profile.id],
  );
  await q("insert into turns (id, conversation_id, learner_id, language_profile_id, idx, role, lines) values ($1, $2, $3, $4, 0, 'master', $5)", [
    turnId, id, profile.learnerId, profile.id, JSON.stringify([{ speaker: "character", gender: null, text: line, segments: [] }]),
  ]);
  await q("insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, 1, 'learner', 'Sí.')", [id, profile.learnerId, profile.id]);
  return { id, turnId };
}

const gloss = (profile, conv, text, meaning) =>
  db.transaction((tx) => recordGlosses(tx, profile, { lang: "es-MX", conversationId: conv.id, turnId: conv.turnId, items: [{ text, norm: normKey(text), meaning, meaningNorm: normKey(meaning), example: null }] }));
const dropReply = (profile, conv) => db.transaction((tx) => unrecordGlosses(tx, profile, { turnIds: [conv.turnId] }));
async function recap(profile, conv, value) {
  const { claim } = await claimExtraction(db, profile, conv.id, { from: ["none", "done"], live: [] });
  return applyExtraction(db, profile, { conversationId: conv.id, claim, value: { summary: "", keep: [], events: [], corrections: [], ...value }, dropped: 0, bankLocale: "es-MX", turns: [] });
}
const phraseOf = async (profile, text) => (await q("select * from phrases where language_profile_id = $1 and norm = $2", [profile.id, normKey(text)]))[0];

test("the recap made it, a reply glossed it: the re-run, then the dropped reply, leave nothing behind", async () => {
  const p = await profileOf();
  const a = await conversation(p, "la cuenta, por favor");
  const b = await conversation(p, "la cuenta", { open: true });
  await recap(p, a, { keep: [{ text: "la cuenta", meaning: "the bill", why: "" }], events: [{ phrase: "la cuenta", kind: "understood" }] });
  await gloss(p, b, "la cuenta", "the bill");
  await recap(p, a, {});
  assert.ok(await phraseOf(p, "la cuenta"), "the gloss still holds it");
  await dropReply(p, b);
  assert.equal(await phraseOf(p, "la cuenta"), undefined, "provenance extraction, unseen, nothing set: gone");
});

test("a reply glossed it, the recap named it: the dropped reply, then the re-run, leave nothing behind", async () => {
  const p = await profileOf();
  const b = await conversation(p, "el cambio", { open: true });
  const a = await conversation(p, "el cambio");
  await gloss(p, b, "el cambio", "the change");
  await recap(p, a, { events: [{ phrase: "el cambio", kind: "understood" }] });
  await dropReply(p, b);
  assert.ok(await phraseOf(p, "el cambio"), "the recap's sighting still holds it");
  await recap(p, a, {});
  assert.equal(await phraseOf(p, "el cambio"), undefined, "provenance gloss, unseen, its card back to unreviewed: gone");
});

test("either order: a phrase the learner starred, or practised, stays, unseen", async () => {
  const p = await profileOf();
  const b = await conversation(p, "de nada", { open: true });
  const a = await conversation(p, "de nada");
  await gloss(p, b, "de nada", "you're welcome");
  await recap(p, a, { events: [{ phrase: "de nada", kind: "produced" }] });
  await updatePhrase(db, p, (await phraseOf(p, "de nada")).id, { starred: true });
  await dropReply(p, b);
  await recap(p, a, {});
  const row = await phraseOf(p, "de nada");
  assert.ok(row, "starred: kept");
  assert.equal(row.seen_count, 0);
  assert.deepEqual(await q("select skill from cards where phrase_id = $1", [row.id]), [], "without its unreviewed cards");
});
