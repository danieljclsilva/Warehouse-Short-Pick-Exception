CREATE TABLE "case_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"short_pick_line_id" uuid,
	"author_user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_messages_text_length_check" CHECK (length(btrim("case_messages"."message")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_short_pick_line_id_short_pick_lines_id_fk" FOREIGN KEY ("short_pick_line_id") REFERENCES "public"."short_pick_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_messages_case_created_idx" ON "case_messages" USING btree ("case_id","created_at");--> statement-breakpoint
UPDATE "users" SET "permissions" = "permissions" || '["RESOLVE_CASE"]'::jsonb
WHERE "role" = 'PICKER' AND "permissions" = '["REPORT_SHORT_PICK","VIEW_OWN_CASES","MARK_ORDER_STAGED","CONFIRM_RETRIEVAL"]'::jsonb;--> statement-breakpoint
UPDATE "invites" SET "default_permissions" = "default_permissions" || '["RESOLVE_CASE"]'::jsonb
WHERE "default_role" = 'PICKER' AND "default_permissions" = '["REPORT_SHORT_PICK","VIEW_OWN_CASES","MARK_ORDER_STAGED","CONFIRM_RETRIEVAL"]'::jsonb;--> statement-breakpoint
UPDATE "users" SET "permissions" = "permissions" || '["RESOLVE_CASE","REOPEN_CASE","ADD_CASE_MESSAGE","VIEW_CASE_MESSAGES"]'::jsonb
WHERE "role" = 'ASSISTANT' AND "permissions" = '["VIEW_ALL_OPEN_CASES","ASSIGN_CHECK","REASSIGN_CHECK","ASSIGN_TROUBLESHOOTER","CREATE_CASE_ON_BEHALF","CREATE_INVITES","VIEW_ANALYTICS","VIEW_USERS","EDIT_PICKER_PERMISSIONS","EDIT_TROUBLESHOOTER_PERMISSIONS","DISABLE_USERS","RESET_USER_PIN","REVOKE_USER_SESSIONS"]'::jsonb;--> statement-breakpoint
UPDATE "invites" SET "default_permissions" = "default_permissions" || '["RESOLVE_CASE","REOPEN_CASE","ADD_CASE_MESSAGE","VIEW_CASE_MESSAGES"]'::jsonb
WHERE "default_role" = 'ASSISTANT' AND "default_permissions" = '["VIEW_ALL_OPEN_CASES","ASSIGN_CHECK","REASSIGN_CHECK","ASSIGN_TROUBLESHOOTER","CREATE_CASE_ON_BEHALF","CREATE_INVITES","VIEW_ANALYTICS","VIEW_USERS","EDIT_PICKER_PERMISSIONS","EDIT_TROUBLESHOOTER_PERMISSIONS","DISABLE_USERS","RESET_USER_PIN","REVOKE_USER_SESSIONS"]'::jsonb;
