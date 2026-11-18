CREATE TABLE "hidden_scenes" (
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hidden_scenes_pk" PRIMARY KEY("language_profile_id","kind","key"),
	CONSTRAINT "hidden_scenes_kind" CHECK ("hidden_scenes"."kind" in ('scenario', 'collection')),
	CONSTRAINT "hidden_scenes_key_length" CHECK (char_length("hidden_scenes"."key") <= 200)
);
--> statement-breakpoint
ALTER TABLE "hidden_scenes" ADD CONSTRAINT "hidden_scenes_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;