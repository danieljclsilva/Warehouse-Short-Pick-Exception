ALTER TABLE "notifications" DROP CONSTRAINT "notifications_recipient_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_case_id_order_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_short_pick_line_id_short_pick_lines_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_short_pick_line_id_short_pick_lines_id_fk" FOREIGN KEY ("short_pick_line_id") REFERENCES "public"."short_pick_lines"("id") ON DELETE set null ON UPDATE no action;