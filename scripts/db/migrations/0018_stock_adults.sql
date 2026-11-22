CREATE TABLE "picture_stock_adults" (
	"concept_id" text PRIMARY KEY NOT NULL,
	"adults" boolean NOT NULL,
	"set_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "picture_stock_adults_id" CHECK ("picture_stock_adults"."concept_id" ~ '^[a-z0-9][a-z0-9-]{0,47}$')
);
--> statement-breakpoint
ALTER TABLE "picture_stock_adults" ADD CONSTRAINT "picture_stock_adults_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;