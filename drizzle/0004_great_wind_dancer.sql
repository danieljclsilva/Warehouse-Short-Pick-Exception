ALTER TABLE "case_events" ADD COLUMN "short_pick_line_id" uuid;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_short_pick_line_id_short_pick_lines_id_fk" FOREIGN KEY ("short_pick_line_id") REFERENCES "public"."short_pick_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "users" SET "permissions" = "permissions" || '["CONFIRM_RETRIEVAL"]'::jsonb
WHERE "role" = 'PICKER' AND "permissions" = '["REPORT_SHORT_PICK","VIEW_OWN_CASES","MARK_ORDER_STAGED"]'::jsonb;
UPDATE "invites" SET "default_permissions" = "default_permissions" || '["CONFIRM_RETRIEVAL"]'::jsonb
WHERE "default_role" = 'PICKER' AND "default_permissions" = '["REPORT_SHORT_PICK","VIEW_OWN_CASES","MARK_ORDER_STAGED"]'::jsonb;
