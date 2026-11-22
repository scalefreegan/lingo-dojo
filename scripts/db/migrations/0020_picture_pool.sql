CREATE TABLE "picture_pool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"concepts" integer NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_pool_calls_concepts" CHECK ("picture_pool_calls"."concepts" > 0),
	CONSTRAINT "picture_pool_calls_outcome" CHECK ("picture_pool_calls"."outcome" is null or "picture_pool_calls"."outcome" in ('ok', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "picture_pool_levels" (
	"concept_id" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_pool_levels_concept" CHECK ("picture_pool_levels"."concept_id" ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
	CONSTRAINT "picture_pool_levels_level" CHECK ("picture_pool_levels"."level" in ('A1', 'A2', 'B1', 'B2'))
);
--> statement-breakpoint
CREATE TABLE "picture_pool_words" (
	"concept_id" text NOT NULL,
	"key" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_pool_words_pk" PRIMARY KEY("concept_id","key"),
	CONSTRAINT "picture_pool_words_concept" CHECK ("picture_pool_words"."concept_id" ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
	CONSTRAINT "picture_pool_words_key" CHECK ("picture_pool_words"."key" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "picture_pool_words_text" CHECK (char_length("picture_pool_words"."text") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "phrases" DROP CONSTRAINT "phrases_source";--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD COLUMN "kids_safe" boolean;--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD COLUMN "origin" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD COLUMN "source_file" text;--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD COLUMN "kids_safe" boolean;--> statement-breakpoint
ALTER TABLE "picture_pool_calls" ADD CONSTRAINT "picture_pool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "picture_pool_calls_created_idx" ON "picture_pool_calls" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD CONSTRAINT "picture_stock_concepts_source_file" UNIQUE("source_file");--> statement-breakpoint
ALTER TABLE "phrases" ADD CONSTRAINT "phrases_source" CHECK ("phrases"."source" in ('gloss', 'extraction', 'manual', 'scenario', 'picture'));--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD CONSTRAINT "picture_stock_concepts_origin" CHECK (("picture_stock_concepts"."origin" = 'admin' and "picture_stock_concepts"."source_file" is null and "picture_stock_concepts"."kids_safe" is null) or ("picture_stock_concepts"."origin" = 'drawing' and "picture_stock_concepts"."source_file" is not null and "picture_stock_concepts"."source_file" ~ '^[0-9a-f]{64}$'));