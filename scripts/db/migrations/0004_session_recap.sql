ALTER TABLE "conversations" ADD COLUMN "extraction_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_claim" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD COLUMN "source" text DEFAULT 'gloss' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "phrase_sightings_extraction_once" ON "phrase_sightings" USING btree ("conversation_id","phrase_id") WHERE "phrase_sightings"."source" = 'extraction';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_extraction_status" CHECK ("conversations"."extraction_status" in ('none', 'running', 'done', 'failed', 'skipped'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_extraction_claim" CHECK (("conversations"."extraction_status" = 'running') = ("conversations"."extraction_claim" is not null));--> statement-breakpoint
ALTER TABLE "phrase_sightings" ADD CONSTRAINT "phrase_sightings_source" CHECK ("phrase_sightings"."source" in ('gloss', 'extraction'));