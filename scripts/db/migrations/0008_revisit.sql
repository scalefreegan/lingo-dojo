CREATE TABLE "recent_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"day" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"claim" uuid,
	"text" text,
	"through" timestamp with time zone,
	"sessions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "recent_digests_profile_day" UNIQUE("language_profile_id","day"),
	CONSTRAINT "recent_digests_status" CHECK ("recent_digests"."status" in ('running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "scene_key" text;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "previous_conversation_id" uuid;
--> statement-breakpoint
ALTER TABLE "recent_digests" ADD CONSTRAINT "recent_digests_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_previous_fk" FOREIGN KEY ("previous_conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE SET NULL ("previous_conversation_id") ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversations_profile_scene_idx" ON "conversations" USING btree ("language_profile_id","scene_key","started_at");
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0008 edit 2): every existing session gets
-- its scene key (scripts/revisit.mjs sceneKey); none has an earlier attempt.
UPDATE "conversations" SET "scene_key" = CASE
  WHEN coalesce(btrim("scenario_id"), '') <> '' THEN 's:' || btrim("scenario_id")
  WHEN btrim(regexp_replace(coalesce("pack_snapshot"->>'quick_scenario', ''), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g')) <> ''
    THEN 'q:' || md5(lower(btrim(regexp_replace("pack_snapshot"->>'quick_scenario', '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))))
  ELSE 'c:' || "id"::text
END;
