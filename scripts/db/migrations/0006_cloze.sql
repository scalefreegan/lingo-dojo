-- Hand-written (scripts/db/hand-edits.mjs, 0006 edit 1): cloze_items is a cache nothing
-- wrote before this migration; any row would have no phrase key (see the
-- header of hand-edits.mjs).
DELETE FROM "cloze_items";
--> statement-breakpoint
CREATE TABLE "cloze_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"phrases" integer NOT NULL,
	"kept" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloze_calls_counts" CHECK ("cloze_calls"."phrases" > 0 and "cloze_calls"."kept" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cloze_items" ALTER COLUMN "sentence" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ALTER COLUMN "blank_start" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ALTER COLUMN "blank_end" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD COLUMN "phrase_key" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD COLUMN "example_id" uuid;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD COLUMN "flagged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_id_phrase" UNIQUE("id","phrase_id");
--> statement-breakpoint
ALTER TABLE "cloze_calls" ADD CONSTRAINT "cloze_calls_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD CONSTRAINT "cloze_items_example_fk" FOREIGN KEY ("example_id","phrase_id") REFERENCES "public"."phrase_examples"("id","phrase_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloze_items" ADD CONSTRAINT "cloze_items_sentence" CHECK (("cloze_items"."sentence" is null) = ("cloze_items"."blank_start" is null) and ("cloze_items"."sentence" is null) = ("cloze_items"."blank_end" is null) and ("cloze_items"."sentence" is not null or "cloze_items"."origin" = 'generated') and ("cloze_items"."example_id" is not null) = ("cloze_items"."origin" = 'example'));
--> statement-breakpoint
CREATE INDEX "cloze_calls_profile_idx" ON "cloze_calls" USING btree ("language_profile_id","created_at");
--> statement-breakpoint
CREATE INDEX "cloze_items_profile_idx" ON "cloze_items" USING btree ("language_profile_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cloze_items_example_once" ON "cloze_items" USING btree ("example_id","phrase_key") WHERE "cloze_items"."example_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "cloze_items_generated_once" ON "cloze_items" USING btree ("phrase_id","phrase_key","sentence") WHERE "cloze_items"."origin" = 'generated' and "cloze_items"."sentence" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "cloze_items_tried_once" ON "cloze_items" USING btree ("language_profile_id","phrase_id","phrase_key") WHERE "cloze_items"."sentence" is null;
