ALTER TABLE "phrase_pictures" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD COLUMN "stock_id" text;--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD COLUMN "restyle" text;--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_theme" CHECK ("phrase_pictures"."theme" is null or "phrase_pictures"."theme" ~ '^[a-z0-9][a-z0-9.+-]{0,63}$');--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_stock" CHECK ("phrase_pictures"."stock_id" is null or ("phrase_pictures"."status" = 'ready' and "phrase_pictures"."theme" is not null and "phrase_pictures"."stock_id" ~ '^[a-z0-9][a-z0-9-]{0,47}$'));--> statement-breakpoint
ALTER TABLE "phrase_pictures" ADD CONSTRAINT "phrase_pictures_restyle" CHECK ("phrase_pictures"."restyle" is null or ("phrase_pictures"."status" = 'ready' and "phrase_pictures"."restyle" in ('check', 'draw')));