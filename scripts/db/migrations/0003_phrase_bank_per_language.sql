ALTER TABLE "cards" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "phrases" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): every phrase goes to its
-- learner's oldest language profile: the one 0002 made from the learner's one
-- language, which is what the bank was in until now.
UPDATE "phrases" SET "language_profile_id" = (
  SELECT lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "phrases"."learner_id" ORDER BY lp."created_at", lp."id" LIMIT 1);
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): rows the new identity (profile, norm),
-- or (profile, meaning_norm) for a pending one, makes one: each maps to the
-- oldest of them, which is kept.
CREATE TEMPORARY TABLE "phrase_merge" AS
SELECT p."id" AS "loser", (
  SELECT k."id" FROM "phrases" k
  WHERE k."language_profile_id" = p."language_profile_id"
    AND ((p."text" IS NOT NULL AND k."text" IS NOT NULL AND k."norm" = p."norm")
      OR (p."text" IS NULL AND k."text" IS NULL AND k."meaning_norm" = p."meaning_norm"))
  ORDER BY k."created_at", k."id" LIMIT 1) AS "keeper"
FROM "phrases" p;
--> statement-breakpoint
DELETE FROM "phrase_merge" WHERE "keeper" = "loser";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): the kept row takes what the others knew.
UPDATE "phrases" k SET
  "seen_count" = k."seen_count" + s."seen_count",
  "first_seen_at" = LEAST(k."first_seen_at", s."first_seen_at"),
  "last_seen_at" = GREATEST(k."last_seen_at", s."last_seen_at"),
  "last_practiced_at" = GREATEST(k."last_practiced_at", s."last_practiced_at"),
  "starred" = k."starred" OR s."starred",
  "meaning" = COALESCE(k."meaning", s."meaning"),
  "note" = COALESCE(k."note", s."note"),
  "alternates" = (
    SELECT COALESCE(jsonb_agg(u."a"), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements(k."alternates") AS "a"
      UNION SELECT jsonb_array_elements(p."alternates") FROM "phrase_merge" m JOIN "phrases" p ON p."id" = m."loser" WHERE m."keeper" = k."id") u)
FROM (
  SELECT m."keeper", sum(p."seen_count")::int AS "seen_count", min(p."first_seen_at") AS "first_seen_at", max(p."last_seen_at") AS "last_seen_at",
    max(p."last_practiced_at") AS "last_practiced_at", bool_or(p."starred") AS "starred", min(p."meaning") AS "meaning", min(p."note") AS "note"
  FROM "phrase_merge" m JOIN "phrases" p ON p."id" = m."loser" GROUP BY m."keeper") s
WHERE k."id" = s."keeper";
--> statement-breakpoint
UPDATE "phrase_examples" x SET "phrase_id" = m."keeper" FROM "phrase_merge" m WHERE x."phrase_id" = m."loser";
--> statement-breakpoint
UPDATE "cloze_items" x SET "phrase_id" = m."keeper" FROM "phrase_merge" m WHERE x."phrase_id" = m."loser";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): per skill, one card survives a merge:
-- the kept phrase's own, else the one with the most reps.
CREATE TEMPORARY TABLE "card_merge" AS
SELECT c."id" AS "card", m."keeper" AS "phrase", (
  SELECT k."id" FROM "cards" k
  WHERE k."skill" = c."skill" AND (k."phrase_id" = m."keeper" OR k."phrase_id" IN (SELECT o."loser" FROM "phrase_merge" o WHERE o."keeper" = m."keeper"))
  ORDER BY (k."phrase_id" = m."keeper") DESC, k."reps" DESC, k."id" LIMIT 1) AS "survivor"
FROM "cards" c JOIN "phrase_merge" m ON m."loser" = c."phrase_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): a session review that would be a
-- second one for the surviving card and its conversation goes (the
-- survivor's own is kept, else the first).
DELETE FROM "reviews" r USING "card_merge" cm
WHERE r."card_id" = cm."card" AND cm."survivor" <> cm."card" AND r."mode" = 'session' AND r."conversation_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "reviews" o LEFT JOIN "card_merge" om ON om."card" = o."card_id"
    WHERE o."mode" = 'session' AND o."conversation_id" = r."conversation_id" AND o."id" <> r."id"
      AND COALESCE(om."survivor", o."card_id") = cm."survivor" AND (o."card_id" = cm."survivor" OR o."id" < r."id"));
--> statement-breakpoint
UPDATE "reviews" r SET "card_id" = cm."survivor" FROM "card_merge" cm WHERE r."card_id" = cm."card" AND cm."survivor" <> cm."card";
--> statement-breakpoint
DELETE FROM "cards" c USING "card_merge" cm WHERE c."id" = cm."card" AND cm."survivor" <> cm."card";
--> statement-breakpoint
UPDATE "cards" c SET "phrase_id" = cm."phrase" FROM "card_merge" cm WHERE c."id" = cm."card" AND cm."survivor" = cm."card";
--> statement-breakpoint
DELETE FROM "phrases" p USING "phrase_merge" m WHERE p."id" = m."loser";
--> statement-breakpoint
DROP TABLE "card_merge";
--> statement-breakpoint
DROP TABLE "phrase_merge";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 3): every example, card and cloze item
-- under its phrase's profile, every review under its card's.
UPDATE "phrase_examples" x SET "language_profile_id" = p."language_profile_id" FROM "phrases" p WHERE p."id" = x."phrase_id";
--> statement-breakpoint
UPDATE "cards" x SET "language_profile_id" = p."language_profile_id" FROM "phrases" p WHERE p."id" = x."phrase_id";
--> statement-breakpoint
UPDATE "cloze_items" x SET "language_profile_id" = p."language_profile_id" FROM "phrases" p WHERE p."id" = x."phrase_id";
--> statement-breakpoint
UPDATE "reviews" x SET "language_profile_id" = c."language_profile_id" FROM "cards" c WHERE c."id" = x."card_id";
--> statement-breakpoint
ALTER TABLE "phrases" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "cards_learner_due_idx";
--> statement-breakpoint
DROP INDEX "phrases_identity";
--> statement-breakpoint
DROP INDEX "phrases_pending_identity";
--> statement-breakpoint
DROP INDEX "reviews_learner_at_idx";
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD CONSTRAINT "cloze_items_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_card_profile_fk" FOREIGN KEY ("card_id","language_profile_id") REFERENCES "public"."cards"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cards_profile_due_idx" ON "cards" USING btree ("language_profile_id","due");
--> statement-breakpoint
CREATE UNIQUE INDEX "phrases_profile_identity" ON "phrases" USING btree ("language_profile_id","norm") WHERE "phrases"."text" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "phrases_profile_pending_identity" ON "phrases" USING btree ("language_profile_id","meaning_norm") WHERE "phrases"."text" is null;
--> statement-breakpoint
CREATE INDEX "reviews_profile_at_idx" ON "reviews" USING btree ("language_profile_id","reviewed_at");
