CREATE TABLE "reading_check_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"words" integer NOT NULL,
	"settled" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_check_calls_counts" CHECK ("reading_check_calls"."words" > 0 and "reading_check_calls"."settled" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reading_corrections" ADD COLUMN "checked_by" text;--> statement-breakpoint
ALTER TABLE "reading_check_calls" ADD CONSTRAINT "reading_check_calls_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_check_calls_profile_idx" ON "reading_check_calls" USING btree ("language_profile_id","created_at");--> statement-breakpoint
ALTER TABLE "reading_corrections" ADD CONSTRAINT "reading_corrections_checked_by" CHECK ("reading_corrections"."checked_by" is null or ("reading_corrections"."source" = 'recap' and "reading_corrections"."checked_by" in ('session', 'recap')));