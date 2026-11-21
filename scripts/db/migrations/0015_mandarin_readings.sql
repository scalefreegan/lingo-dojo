CREATE TABLE "reading_corrections" (
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"key" text NOT NULL,
	"word" text NOT NULL,
	"reading" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_corrections_pk" PRIMARY KEY("language_profile_id","key"),
	CONSTRAINT "reading_corrections_kind" CHECK ("reading_corrections"."kind" in ('corrected', 'confirmed', 'suggested')),
	CONSTRAINT "reading_corrections_source" CHECK ("reading_corrections"."source" in ('user', 'recap')),
	CONSTRAINT "reading_corrections_by_hand" CHECK ("reading_corrections"."source" = 'user' or "reading_corrections"."kind" <> 'corrected'),
	CONSTRAINT "reading_corrections_word" CHECK (char_length("reading_corrections"."word") between 2 and 8 and char_length("reading_corrections"."key") between 2 and 8),
	CONSTRAINT "reading_corrections_reading" CHECK (char_length("reading_corrections"."reading") between 2 and 80)
);
--> statement-breakpoint
CREATE TABLE "shared_reading_uses" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"changed" integer NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_reading_uses_changed" CHECK ("shared_reading_uses"."changed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shared_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"word" text NOT NULL,
	"reading" text NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"by_user" boolean DEFAULT false NOT NULL,
	"by_recap" boolean DEFAULT false NOT NULL,
	"suggested_by" uuid,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_readings_entry" UNIQUE("key","scope","reading"),
	CONSTRAINT "shared_readings_status" CHECK ("shared_readings"."status" in ('active', 'suggested')),
	CONSTRAINT "shared_readings_source" CHECK ("shared_readings"."source" in ('admin', 'user', 'recap')),
	CONSTRAINT "shared_readings_scope" CHECK ("shared_readings"."scope" in ('all', 'tw')),
	CONSTRAINT "shared_readings_word" CHECK (char_length("shared_readings"."word") between 2 and 8 and char_length("shared_readings"."key") between 2 and 8),
	CONSTRAINT "shared_readings_reading" CHECK (char_length("shared_readings"."reading") between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "reading_corrections" ADD CONSTRAINT "reading_corrections_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_reading_uses" ADD CONSTRAINT "shared_reading_uses_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_readings" ADD CONSTRAINT "shared_readings_suggested_by_users_id_fk" FOREIGN KEY ("suggested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_readings" ADD CONSTRAINT "shared_readings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_reading_uses_counted_idx" ON "shared_reading_uses" USING btree ("counted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_readings_one_active" ON "shared_readings" USING btree ("key","scope") WHERE "shared_readings"."status" = 'active';