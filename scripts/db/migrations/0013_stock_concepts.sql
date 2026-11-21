CREATE TABLE "picture_stock_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"concept_id" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_stock_calls_outcome" CHECK ("picture_stock_calls"."outcome" is null or "picture_stock_calls"."outcome" in ('ok', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "picture_stock_concepts" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"words" text[] NOT NULL,
	"adults" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_stock_concepts_id" CHECK ("picture_stock_concepts"."id" ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
	CONSTRAINT "picture_stock_concepts_category" CHECK (char_length("picture_stock_concepts"."category") between 1 and 40),
	CONSTRAINT "picture_stock_concepts_description" CHECK (char_length("picture_stock_concepts"."description") between 1 and 80),
	CONSTRAINT "picture_stock_concepts_words" CHECK (cardinality("picture_stock_concepts"."words") between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "picture_stock_calls" ADD CONSTRAINT "picture_stock_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD CONSTRAINT "picture_stock_concepts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "picture_stock_calls_created_idx" ON "picture_stock_calls" USING btree ("created_at");