CREATE TABLE "language_prefs" (
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "language_prefs_pk" PRIMARY KEY("language_profile_id","key"),
	CONSTRAINT "language_prefs_key_length" CHECK (char_length("language_prefs"."key") between 1 and 40),
	CONSTRAINT "language_prefs_value_length" CHECK (octet_length("language_prefs"."value") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "language_prefs" ADD CONSTRAINT "language_prefs_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;