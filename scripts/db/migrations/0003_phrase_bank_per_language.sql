-- Hand-written (scripts/db/hand-edits.mjs, 0003 edit 1): refuse to run on a bank that has rows
-- (see the header of hand-edits.mjs); nothing is changed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "phrases")
    OR EXISTS (SELECT 1 FROM "phrase_examples")
    OR EXISTS (SELECT 1 FROM "cards")
    OR EXISTS (SELECT 1 FROM "cloze_items")
    OR EXISTS (SELECT 1 FROM "reviews") THEN
    RAISE EXCEPTION '0003_phrase_bank_per_language: the phrase bank tables already hold rows. This migration moves the bank under language profiles and does not guess which language an existing phrase belongs to; empty phrases, phrase_examples, cards, cloze_items and reviews (or assign them by hand) and run it again.';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "phrase_dismissals" (
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phrase_dismissals_pk" PRIMARY KEY("language_profile_id","kind","key"),
	CONSTRAINT "phrase_dismissals_kind" CHECK ("phrase_dismissals"."kind" in ('text', 'meaning'))
);
--> statement-breakpoint
CREATE TABLE "phrase_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "cards_learner_due_idx";
--> statement-breakpoint
DROP INDEX "phrases_identity";
--> statement-breakpoint
DROP INDEX "phrases_pending_identity";
--> statement-breakpoint
DROP INDEX "reviews_learner_at_idx";
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "language_profile_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD COLUMN "language_profile_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD COLUMN "language_profile_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "phrases" ADD COLUMN "language_profile_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "language_profile_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "phrases" ADD COLUMN "edited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "phrase_dismissals" ADD CONSTRAINT "phrase_dismissals_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD CONSTRAINT "phrase_sightings_phrase_id_learner_id_phrases_id_learner_id_fk" FOREIGN KEY ("phrase_id","learner_id") REFERENCES "public"."phrases"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD CONSTRAINT "phrase_sightings_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD CONSTRAINT "phrase_sightings_conversation_profile_fk" FOREIGN KEY ("conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD CONSTRAINT "phrase_sightings_turn_profile_fk" FOREIGN KEY ("turn_id","language_profile_id") REFERENCES "public"."turns"("id","language_profile_id") ON DELETE SET NULL ("turn_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD CONSTRAINT "cloze_items_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_conversation_profile_fk" FOREIGN KEY ("conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_turn_profile_fk" FOREIGN KEY ("turn_id","language_profile_id") REFERENCES "public"."turns"("id","language_profile_id") ON DELETE SET NULL ("turn_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_card_profile_fk" FOREIGN KEY ("card_id","language_profile_id") REFERENCES "public"."cards"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_conversation_profile_fk" FOREIGN KEY ("conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "phrase_sightings_turn_phrase" ON "phrase_sightings" USING btree ("turn_id","phrase_id");
--> statement-breakpoint
CREATE INDEX "phrase_sightings_phrase_idx" ON "phrase_sightings" USING btree ("phrase_id","seen_at");
--> statement-breakpoint
CREATE INDEX "cards_profile_due_idx" ON "cards" USING btree ("language_profile_id","due");
--> statement-breakpoint
CREATE UNIQUE INDEX "phrases_profile_identity" ON "phrases" USING btree ("language_profile_id","norm") WHERE "phrases"."text" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "phrases_profile_pending_identity" ON "phrases" USING btree ("language_profile_id","meaning_norm") WHERE "phrases"."text" is null;
--> statement-breakpoint
CREATE INDEX "reviews_profile_at_idx" ON "reviews" USING btree ("language_profile_id","reviewed_at");
