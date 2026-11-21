CREATE TABLE "phrase_pictures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"phrase_key" text NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"file" text,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phrase_pictures_profile_phrase" UNIQUE("language_profile_id","phrase_id"),
	CONSTRAINT "phrase_pictures_status" CHECK ("phrase_pictures"."status" in ('pending', 'ready', 'none', 'failed', 'removed')),
	CONSTRAINT "phrase_pictures_file" CHECK (("phrase_pictures"."status" = 'ready') = ("phrase_pictures"."file" is not null) and ("phrase_pictures"."file" is null or "phrase_pictures"."file" ~ '^[0-9a-f]{64}$') and ("phrase_pictures"."file" is null) = ("phrase_pictures"."content_type" is null)),
	CONSTRAINT "phrase_pictures_type" CHECK ("phrase_pictures"."content_type" is null or "phrase_pictures"."content_type" in ('image/png', 'image/webp', 'image/jpeg')),
	CONSTRAINT "phrase_pictures_description" CHECK ("phrase_pictures"."status" not in ('pending', 'ready') or "phrase_pictures"."description" is not null)
);
--> statement-breakpoint
CREATE TABLE "picture_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"words" integer NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_calls_kind" CHECK ("picture_calls"."kind" in ('judge', 'image')),
	CONSTRAINT "picture_calls_words" CHECK ("picture_calls"."words" > 0),
	CONSTRAINT "picture_calls_outcome" CHECK ("picture_calls"."outcome" is null or "picture_calls"."outcome" in ('ok', 'refused', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_mode";--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_phrase_id_learner_id_phrases_id_learner_id_fk" FOREIGN KEY ("phrase_id","learner_id") REFERENCES "public"."phrases"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_phrase_profile_fk" FOREIGN KEY ("phrase_id","language_profile_id") REFERENCES "public"."phrases"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picture_calls" ADD CONSTRAINT "picture_calls_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "picture_calls_profile_idx" ON "picture_calls" USING btree ("language_profile_id","created_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_mode" CHECK ("reviews"."mode" in ('flashcard', 'cloze', 'listening', 'speak', 'picture', 'session'));