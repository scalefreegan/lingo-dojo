-- Hand-added (drizzle-kit does not generate extensions): trigram search for
-- per-turn retrieval and LOOKUP, needed before the gin_trgm_ops indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_role" CHECK ("agent_messages"."role" in ('user', 'assistant', 'commit'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"learner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"due" timestamp with time zone DEFAULT now() NOT NULL,
	"stability" double precision DEFAULT 0 NOT NULL,
	"stability_fast" double precision,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"scheduled_days" double precision DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"state" smallint DEFAULT 0 NOT NULL,
	"last_review" timestamp with time zone,
	CONSTRAINT "cards_phrase_skill" UNIQUE("phrase_id","skill"),
	CONSTRAINT "cards_id_learner" UNIQUE("id","learner_id"),
	CONSTRAINT "cards_skill" CHECK ("cards"."skill" in ('recognize', 'listen', 'produce')),
	CONSTRAINT "cards_state" CHECK ("cards"."state" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "cloze_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"sentence" text NOT NULL,
	"blank_start" integer NOT NULL,
	"blank_end" integer NOT NULL,
	"hint" text,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloze_items_origin" CHECK ("cloze_items"."origin" in ('example', 'generated')),
	CONSTRAINT "cloze_items_blank" CHECK (0 <= "cloze_items"."blank_start" and "cloze_items"."blank_start" < "cloze_items"."blank_end")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"pack_snapshot" jsonb NOT NULL,
	"scenario_id" text,
	"title" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"target_variant" text DEFAULT '' NOT NULL,
	"model" text,
	"planned_minutes" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"extraction" jsonb,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "conversations_id_learner" UNIQUE("id","learner_id"),
	CONSTRAINT "conversations_mode" CHECK ("conversations"."mode" in ('adult', 'kids'))
);
--> statement-breakpoint
CREATE TABLE "learners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"native_language" text DEFAULT '' NOT NULL,
	"target_language" text DEFAULT '' NOT NULL,
	"target_variant" text DEFAULT '' NOT NULL,
	"level" text DEFAULT '' NOT NULL,
	"goals" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "learners_mode" CHECK ("learners"."mode" in ('adult', 'kids'))
);
--> statement-breakpoint
CREATE TABLE "pack_folders" (
	"learner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_folders_learner_id_name_pk" PRIMARY KEY("learner_id","name")
);
--> statement-breakpoint
CREATE TABLE "pack_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"created" text NOT NULL,
	"scenario" text DEFAULT '' NOT NULL,
	"quick_scenario" text DEFAULT '' NOT NULL,
	"units" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "packs_id_learner" UNIQUE("id","learner_id")
);
--> statement-breakpoint
CREATE TABLE "phrase_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"sentence" text NOT NULL,
	"speaker" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phrases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"lang" text NOT NULL,
	"text" text,
	"norm" text NOT NULL,
	"meaning" text,
	"note" text,
	"source" text NOT NULL,
	"alternates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"seen_count" integer DEFAULT 0 NOT NULL,
	"last_practiced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phrases_identity" UNIQUE("learner_id","lang","norm"),
	CONSTRAINT "phrases_id_learner" UNIQUE("id","learner_id"),
	CONSTRAINT "phrases_source" CHECK ("phrases"."source" in ('gloss', 'extraction', 'manual', 'scenario'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"rating" smallint NOT NULL,
	"answer" text,
	"verdict" text,
	"grader_note" text,
	"duration_ms" integer,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"conversation_id" uuid,
	CONSTRAINT "reviews_mode" CHECK ("reviews"."mode" in ('flashcard', 'cloze', 'listening', 'speak', 'session')),
	CONSTRAINT "reviews_rating" CHECK ("reviews"."rating" between 1 and 4),
	CONSTRAINT "reviews_verdict" CHECK ("reviews"."verdict" in ('exact', 'close', 'accepted', 'wrong', 'self'))
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"role" text NOT NULL,
	"text" text,
	"lines" jsonb,
	"glosses" jsonb,
	"choices" jsonb,
	"stage" text,
	"cast_notes" jsonb,
	"duration_ms" integer,
	"cost_usd" double precision,
	"lookup" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_conversation_position" UNIQUE("conversation_id","idx"),
	CONSTRAINT "turns_role" CHECK ("turns"."role" in ('learner', 'master'))
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"model" text,
	"voice" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_lowercase" CHECK ("users"."username" = lower("users"."username"))
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_phrase_id_learner_id_phrases_id_learner_id_fk" FOREIGN KEY ("phrase_id","learner_id") REFERENCES "public"."phrases"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloze_items" ADD CONSTRAINT "cloze_items_phrase_id_learner_id_phrases_id_learner_id_fk" FOREIGN KEY ("phrase_id","learner_id") REFERENCES "public"."phrases"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_folders" ADD CONSTRAINT "pack_folders_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_revisions" ADD CONSTRAINT "pack_revisions_pack_id_learner_id_packs_id_learner_id_fk" FOREIGN KEY ("pack_id","learner_id") REFERENCES "public"."packs"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrase_examples" ADD CONSTRAINT "phrase_examples_phrase_id_learner_id_phrases_id_learner_id_fk" FOREIGN KEY ("phrase_id","learner_id") REFERENCES "public"."phrases"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_card_id_learner_id_cards_id_learner_id_fk" FOREIGN KEY ("card_id","learner_id") REFERENCES "public"."cards"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_learner_id_conversations_id_learner_id_fk" FOREIGN KEY ("conversation_id","learner_id") REFERENCES "public"."conversations"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_messages_user_ts_idx" ON "agent_messages" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cards_learner_due_idx" ON "cards" USING btree ("learner_id","due");--> statement-breakpoint
CREATE INDEX "cloze_items_phrase_idx" ON "cloze_items" USING btree ("phrase_id");--> statement-breakpoint
CREATE INDEX "conversations_learner_started_idx" ON "conversations" USING btree ("learner_id","started_at");--> statement-breakpoint
CREATE INDEX "learners_user_idx" ON "learners" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pack_revisions_pack_at_idx" ON "pack_revisions" USING btree ("pack_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_learner_folder_slug_live" ON "packs" USING btree ("learner_id","folder","slug") WHERE "packs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "phrase_examples_phrase_idx" ON "phrase_examples" USING btree ("phrase_id");--> statement-breakpoint
CREATE INDEX "phrases_text_trgm" ON "phrases" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "phrases_meaning_trgm" ON "phrases" USING gin ("meaning" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reviews_card_at_idx" ON "reviews" USING btree ("card_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "reviews_learner_at_idx" ON "reviews" USING btree ("learner_id","reviewed_at");