ALTER TABLE "phrase_pictures" ADD COLUMN "look_alike" text;--> statement-breakpoint
ALTER TABLE "picture_stock_concepts" ADD COLUMN "look_alike_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_look_alike" CHECK ("phrase_pictures"."look_alike" is null or "phrase_pictures"."look_alike" ~ '^[a-z0-9][a-z0-9-]{0,47}$');