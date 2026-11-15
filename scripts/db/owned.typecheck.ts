// Compile-time tests for owned.ts, checked by `(cd web && npx tsc -b)`
// (web/tsconfig.node.json includes scripts/db/*.ts) and never run. Each
// expect-error directive below promises that its line does NOT compile; if
// one ever starts compiling, tsc fails on the unused directive. The runtime
// half is scripts/tests/db.test.mjs.

import { eq, sql } from "drizzle-orm";
import { forLearner, forUser, type Db } from "./owned.ts";
import { authSessions, cards, learners, phrases, turns, users } from "./schema.ts";

export async function ownedRowTypes(db: Db, learnerId: string, userId: string) {
  const mine = forLearner(db, learnerId);

  // Rows come back typed as the table's own row.
  const rows = await mine.list(phrases, eq(phrases.lang, "es-MX"));
  const text: string | null | undefined = rows[0]?.text;
  const card = await mine.get(cards, eq(cards.skill, "produce"));
  const due: Date | undefined = card?.due;

  // Insert takes the row without its owner; the scope supplies it.
  await mine.insert(phrases, { lang: "es-MX", text: "¿A cómo?", norm: "a como", source: "gloss" });
  // @ts-expect-error the owner is the scope's to set, not the caller's
  await mine.insert(phrases, { learnerId, lang: "es-MX", norm: "x", source: "gloss" });
  // @ts-expect-error a required column is still required
  await mine.insert(phrases, { lang: "es-MX", norm: "x" });
  // @ts-expect-error nor can an update move a row to another owner
  await mine.update(phrases, { learnerId: "someone-else" }, eq(phrases.norm, "x"));
  // @ts-expect-error update and remove need a condition
  await mine.remove(phrases);

  // Upsert: the owner is added to the conflict target, and SET takes SQL.
  await mine.upsert(phrases, { lang: "es-MX", text: "hola", norm: "hola", source: "gloss" }, {
    target: [phrases.lang, phrases.norm],
    targetWhere: sql`${phrases.text} is not null`,
    set: { seenCount: sql`${phrases.seenCount} + 1`, lastSeenAt: new Date() },
  });
  await mine.upsert(phrases, { lang: "es-MX", norm: "x", text: "x", source: "gloss" }, {
    target: [phrases.lang, phrases.norm],
    // @ts-expect-error nor can an upsert's SET
    set: { learnerId: "someone-else" },
  });

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

  return { text, due };
}
