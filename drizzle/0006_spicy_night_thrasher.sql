CREATE TYPE "public"."notification_preference_key" AS ENUM('NEW_SHORT_PICK', 'CHECK_CLAIMED', 'NEW_LOCATION', 'TROUBLESHOOTER_MESSAGE', 'UNRESOLVED_OVER_THRESHOLD', 'CASE_RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('RESPONSIBILITY_CASE_ASSIGNED', 'RESPONSIBILITY_CHECK_ASSIGNED', 'RESPONSIBILITY_RETRIEVAL_ASSIGNED', 'RESPONSIBILITY_NEW_LOCATION', 'RESPONSIBILITY_CASE_REOPENED', 'NEW_SHORT_PICK', 'CHECK_CLAIMED', 'NEW_LOCATION', 'TROUBLESHOOTER_MESSAGE', 'UNRESOLVED_OVER_THRESHOLD', 'CASE_RESOLVED');--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"key" "notification_preference_key" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold_minutes" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_threshold_check" CHECK ("notification_preferences"."threshold_minutes" IS NULL OR "notification_preferences"."threshold_minutes" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"case_id" uuid,
	"short_pick_line_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"push_attempted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_short_pick_line_id_short_pick_lines_id_fk" FOREIGN KEY ("short_pick_line_id") REFERENCES "public"."short_pick_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_key_uq" ON "notification_preferences" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("recipient_user_id","read_at");