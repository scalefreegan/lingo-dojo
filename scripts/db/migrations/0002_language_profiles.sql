CREATE TABLE "language_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"target_language" text DEFAULT '' NOT NULL,
	"target_variant" text DEFAULT '' NOT NULL,
	"level" text DEFAULT '' NOT NULL,
	"goals" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "language_profiles_id_learner" UNIQUE("id","learner_id")
);
--> statement-breakpoint
ALTER TABLE "language_profiles" ADD CONSTRAINT "language_profiles_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "language_profiles_learner_idx" ON "language_profiles" USING btree ("learner_id");
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "pack_folders" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "pack_revisions" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "language_profile_id" uuid;
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): one language profile per existing
-- learner, from the learner's own per-language columns (dropped below). It
-- is the learner's only one, so last_used_at makes it the one picking the
-- learner lands on.
INSERT INTO "language_profiles" ("learner_id", "target_language", "target_variant", "level", "goals", "notes", "created_at", "last_used_at")
SELECT "id", "target_language", "target_variant", "level", "goals", "notes", "created_at", now() FROM "learners";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): every packs row goes under its learner's profile.
UPDATE "packs" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "packs"."learner_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): every pack_folders row goes under its learner's profile.
UPDATE "pack_folders" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "pack_folders"."learner_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): every pack_revisions row goes under its learner's profile.
UPDATE "pack_revisions" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "pack_revisions"."learner_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): every conversations row goes under its learner's profile.
UPDATE "conversations" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "conversations"."learner_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): every turns row goes under its learner's profile.
UPDATE "turns" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "turns"."learner_id";
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0002 edit 3): a session with a learner practises that learner's
-- one language.
UPDATE "auth_sessions" SET "language_profile_id" = lp."id" FROM "language_profiles" lp WHERE lp."learner_id" = "auth_sessions"."learner_id";
--> statement-breakpoint
ALTER TABLE "packs" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pack_folders" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pack_revisions" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "language_profile_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "packs_learner_folder_slug_live";
--> statement-breakpoint
ALTER TABLE "pack_folders" DROP CONSTRAINT "pack_folders_learner_id_name_pk";
--> statement-breakpoint
ALTER TABLE "pack_folders" ADD CONSTRAINT "pack_folders_profile_name_pk" PRIMARY KEY("language_profile_id","name");
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_id_profile" UNIQUE("id","language_profile_id");
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE SET NULL ("language_profile_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pack_folders" ADD CONSTRAINT "pack_folders_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pack_revisions" ADD CONSTRAINT "pack_revisions_pack_profile_fk" FOREIGN KEY ("pack_id","language_profile_id") REFERENCES "public"."packs"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_language_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_profile_fk" FOREIGN KEY ("conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversations_profile_started_idx" ON "conversations" USING btree ("language_profile_id","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "packs_profile_folder_slug_live" ON "packs" USING btree ("language_profile_id","folder","slug") WHERE "packs"."deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "learners" DROP COLUMN "target_language";
--> statement-breakpoint
ALTER TABLE "learners" DROP COLUMN "target_variant";
--> statement-breakpoint
ALTER TABLE "learners" DROP COLUMN "level";
--> statement-breakpoint
ALTER TABLE "learners" DROP COLUMN "goals";
--> statement-breakpoint
ALTER TABLE "learners" DROP COLUMN "notes";
