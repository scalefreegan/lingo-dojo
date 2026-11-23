CREATE TABLE "pronunciation_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"language_profile_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"coaching" text NOT NULL,
	"syllables" jsonb NOT NULL,
	"flagged" integer NOT NULL,
	"clip_file" text,
	"clip_bytes" integer,
	"clip_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pronunciation_checks_turn" UNIQUE("turn_id"),
	CONSTRAINT "pronunciation_checks_engine" CHECK ("pronunciation_checks"."engine" in ('azure', 'local')),
	CONSTRAINT "pronunciation_checks_coaching" CHECK ("pronunciation_checks"."coaching" in ('light', 'strict')),
	CONSTRAINT "pronunciation_checks_flagged" CHECK ("pronunciation_checks"."flagged" >= 0),
	CONSTRAINT "pronunciation_checks_clip" CHECK (("pronunciation_checks"."clip_file" is null and "pronunciation_checks"."clip_bytes" is null and "pronunciation_checks"."clip_ms" is null) or ("pronunciation_checks"."clip_file" is not null and "pronunciation_checks"."clip_bytes" is not null and "pronunciation_checks"."clip_ms" is not null and "pronunciation_checks"."flagged" > 0 and "pronunciation_checks"."clip_file" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]wav$' and "pronunciation_checks"."clip_bytes" > 0 and "pronunciation_checks"."clip_ms" > 0))
);
--> statement-breakpoint
ALTER TABLE "pronunciation_checks" ADD CONSTRAINT "pronunciation_checks_profile_fk" FOREIGN KEY ("language_profile_id","learner_id") REFERENCES "public"."language_profiles"("id","learner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pronunciation_checks" ADD CONSTRAINT "pronunciation_checks_conversation_fk" FOREIGN KEY ("conversation_id","language_profile_id") REFERENCES "public"."conversations"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pronunciation_checks" ADD CONSTRAINT "pronunciation_checks_turn_fk" FOREIGN KEY ("turn_id","language_profile_id") REFERENCES "public"."turns"("id","language_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pronunciation_checks_conversation_idx" ON "pronunciation_checks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "pronunciation_checks_profile_idx" ON "pronunciation_checks" USING btree ("language_profile_id","created_at");