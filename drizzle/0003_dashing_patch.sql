CREATE TYPE "public"."check_completion_code" AS ENUM('FOUND', 'NOT_FOUND', 'WRONG_LOCATION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."check_task_status" AS ENUM('AVAILABLE', 'CLAIMED', 'ASSIGNED', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "check_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_pick_line_id" uuid NOT NULL,
	"status" "check_task_status" DEFAULT 'AVAILABLE' NOT NULL,
	"claimed_by_user_id" uuid,
	"assigned_to_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"assigned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completion_code" "check_completion_code",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "check_tasks_version_positive_check" CHECK ("check_tasks"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "check_tasks" ADD CONSTRAINT "check_tasks_short_pick_line_id_short_pick_lines_id_fk" FOREIGN KEY ("short_pick_line_id") REFERENCES "public"."short_pick_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_tasks" ADD CONSTRAINT "check_tasks_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_tasks" ADD CONSTRAINT "check_tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_tasks_status_created_idx" ON "check_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "check_tasks_assignee_status_idx" ON "check_tasks" USING btree ("assigned_to_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "check_tasks_one_active_per_line_uq" ON "check_tasks" USING btree ("short_pick_line_id") WHERE "check_tasks"."status" <> 'COMPLETED';--> statement-breakpoint
INSERT INTO "check_tasks" ("short_pick_line_id") SELECT "id" FROM "short_pick_lines" WHERE "state" = 'OPEN';
