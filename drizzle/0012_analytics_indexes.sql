CREATE INDEX "case_events_created_idx" ON "case_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "check_tasks_line_created_idx" ON "check_tasks" USING btree ("short_pick_line_id","created_at");--> statement-breakpoint
CREATE INDEX "order_cases_created_at_idx" ON "order_cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "order_cases_phase_idx" ON "order_cases" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "short_pick_lines_location_idx" ON "short_pick_lines" USING btree ("original_location");--> statement-breakpoint
CREATE INDEX "short_pick_lines_sku_idx" ON "short_pick_lines" USING btree ("sku");