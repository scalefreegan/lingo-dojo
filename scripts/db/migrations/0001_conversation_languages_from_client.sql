ALTER TABLE "conversations" ADD COLUMN "native_language" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "target_language" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "from_client" boolean DEFAULT false NOT NULL;