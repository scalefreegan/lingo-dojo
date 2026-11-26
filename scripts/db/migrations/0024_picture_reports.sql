CREATE TABLE "picture_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"language_profile_id" uuid,
	"concept_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "picture_reports_reason" CHECK ("picture_reports"."reason" in ('wrong', 'lookalike', 'kids', 'style'))
);
--> statement-breakpoint
ALTER TABLE "picture_reports" ADD CONSTRAINT "picture_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picture_reports" ADD CONSTRAINT "picture_reports_language_profile_id_language_profiles_id_fk" FOREIGN KEY ("language_profile_id") REFERENCES "public"."language_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picture_reports" ADD CONSTRAINT "picture_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "picture_reports_open_idx" ON "picture_reports" USING btree ("concept_id") WHERE "picture_reports"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "picture_reports_user_idx" ON "picture_reports" USING btree ("user_id","created_at");