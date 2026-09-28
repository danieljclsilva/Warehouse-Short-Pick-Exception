ALTER TABLE "short_pick_lines" ADD COLUMN "replenishment_state" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD COLUMN "replenishment_note" text;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD COLUMN "replenishment_actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD COLUMN "replenishment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD COLUMN "replenishment_retriever_user_id" uuid;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_replenishment_actor_user_id_users_id_fk" FOREIGN KEY ("replenishment_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_replenishment_retriever_user_id_users_id_fk" FOREIGN KEY ("replenishment_retriever_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "short_pick_lines_reporter_reported_idx" ON "short_pick_lines" USING btree ("reported_by_user_id","reported_at");--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_replenishment_state_check" CHECK ("short_pick_lines"."replenishment_state" in ('NONE', 'WAITING', 'COMPLETED'));