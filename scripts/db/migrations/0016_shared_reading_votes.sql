CREATE TABLE "shared_reading_votes" (
	"shared_reading_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_reading_votes_shared_reading_id_user_id_pk" PRIMARY KEY("shared_reading_id","user_id"),
	CONSTRAINT "shared_reading_votes_source" CHECK ("shared_reading_votes"."source" in ('user', 'recap'))
);
--> statement-breakpoint
ALTER TABLE "shared_reading_votes" ADD CONSTRAINT "shared_reading_votes_shared_reading_id_shared_readings_id_fk" FOREIGN KEY ("shared_reading_id") REFERENCES "public"."shared_readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_reading_votes" ADD CONSTRAINT "shared_reading_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_reading_votes_user_idx" ON "shared_reading_votes" USING btree ("user_id","created_at");