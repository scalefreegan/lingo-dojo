// Compile-time tests for owned.ts, checked by `(cd web && npx tsc -b)`
// (web/tsconfig.node.json includes scripts/db/*.ts) and never run. Each
// expect-error directive below promises that its line does NOT compile; if
// one ever starts compiling, tsc fails on the unused directive. The runtime
// half is scripts/tests/db.test.mjs.

import { eq, sql } from "drizzle-orm";
import { forLanguageProfile, forLearner, forUser, type Db } from "./owned.ts";
import { authSessions, cards, conversations, languageProfiles, learners, packFolders, packs, phrases, turns, users } from "./schema.ts";

export async function ownedRowTypes(db: Db, learnerId: string, userId: string, profileId: string) {
  const mine = forLearner(db, learnerId);
  const german = forLanguageProfile(db, { id: profileId, learnerId });

  // Rows come back typed as the table's own row.
  const rows = await german.list(phrases, eq(phrases.lang, "de-DE"));
  const text: string | null | undefined = rows[0]?.text;
  const card = await german.get(cards, eq(cards.skill, "produce"));
  const due: Date | undefined = card?.due;

  // Insert takes the row without its owners; the scope supplies them.
  await german.insert(phrases, { lang: "de-DE", text: "Wie viel?", norm: "wie viel", source: "gloss" });
  // @ts-expect-error the owner is the scope's to set, not the caller's
  await german.insert(phrases, { learnerId, lang: "de-DE", norm: "x", source: "gloss" });
  // @ts-expect-error a required column is still required
  await german.insert(phrases, { lang: "de-DE", norm: "x" });
  // @ts-expect-error nor can an update move a row to another owner
  await german.update(phrases, { learnerId: "someone-else" }, eq(phrases.norm, "x"));
  // @ts-expect-error update and remove need a condition
  await german.remove(phrases);

  // Upsert: the owner is added to the conflict target, and SET takes SQL.
  await german.upsert(phrases, { lang: "de-DE", text: "hallo", norm: "hallo", source: "gloss" }, {
    target: [phrases.norm],
    targetWhere: sql`${phrases.text} is not null`,
    set: { seenCount: sql`${phrases.seenCount} + 1`, lastSeenAt: new Date() },
  });
  await german.upsert(phrases, { lang: "de-DE", norm: "x", text: "x", source: "gloss" }, {
    target: [phrases.norm],
    // @ts-expect-error nor can an upsert's SET
    set: { languageProfileId: "elsewhere" },
  });

  // Insert-or-ignore: the same values as insert, the owner in the target.
  await german.insertOrIgnore(phrases, { lang: "de-DE", text: "hallo", norm: "hallo", source: "gloss" }, { target: [phrases.norm] });
  // @ts-expect-error nor through insertOrIgnore
  await german.insertOrIgnore(phrases, { learnerId, lang: "de-DE", norm: "x", source: "gloss" });

  // A table without learner_id cannot be queried through a learner scope…
  // @ts-expect-error users has no learner_id
  await mine.list(users);
  // @ts-expect-error learners are owned by a user, not a learner
  await mine.list(learners);
  // …and learner-owned rows not through a user scope.
  // @ts-expect-error turns have no user_id
  await forUser(db, userId).list(turns);
  await forUser(db, userId).list(authSessions);

  // A scope cannot be made without an owner.
  // @ts-expect-error missing learnerId
  forLearner(db);

  // A language's rows go through a language-profile scope, which stamps both
  // owners; a learner scope can't reach them (it would see every language).
  const live = await german.list(packs, eq(packs.folder, "trips"));
  const slug: string | undefined = live[0]?.slug;
  await german.insert(conversations, { packSnapshot: {}, mode: "adult" });
  await german.insertOrIgnore(packFolders, { name: "trips" });
  // @ts-expect-error packs belong to a language profile, not a learner scope
  await mine.list(packs);
  // @ts-expect-error nor conversations
  await mine.insert(conversations, { packSnapshot: {}, mode: "adult" });
  // @ts-expect-error nor turns
  await mine.get(turns, eq(turns.idx, 0));
  // @ts-expect-error nor the phrase bank (migration 0003): each language has its own
  await mine.list(phrases);
  // @ts-expect-error nor a phrase's cards
  await mine.get(cards, eq(cards.skill, "produce"));
  // @ts-expect-error neither owner can be passed
  await german.insert(packFolders, { name: "x", learnerId });
  // @ts-expect-error nor the profile
  await german.update(packs, { languageProfileId: "elsewhere" }, eq(packs.slug, "x"));
  // @ts-expect-error a language scope needs its learner too
  forLanguageProfile(db, { id: profileId });
  // The learner's languages themselves are the learner's rows…
  await mine.list(languageProfiles);
  // @ts-expect-error …and not one language's
  await german.list(languageProfiles);

  return { text, due, slug };
}
