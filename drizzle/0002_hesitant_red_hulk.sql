CREATE TYPE "public"."case_phase" AS ENUM('PICKING', 'STAGED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."case_source" AS ENUM('PICKER_REPORT', 'TL_MANUAL', 'ASSISTANT_MANUAL', 'ADMIN_MANUAL');--> statement-breakpoint
CREATE TYPE "public"."physical_state" AS ENUM('WITH_PICKER', 'SHORT_PICK_HOLD', 'OTHER_KNOWN_LOCATION', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."short_pick_line_state" AS ENUM('OPEN', 'CHECKING', 'FOUND', 'RETRIEVING', 'RESOLVED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"event_type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"phase" "case_phase" DEFAULT 'PICKING' NOT NULL,
	"physical_state" "physical_state" DEFAULT 'WITH_PICKER' NOT NULL,
	"physical_location" text,
	"picking_user_id" uuid,
	"current_case_responsible_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"source" "case_source" DEFAULT 'PICKER_REPORT' NOT NULL,
	"manual_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"reopened_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_cases_order_number_digits_check" CHECK ("order_cases"."order_number" ~ '^[0-9]+$'),
	CONSTRAINT "order_cases_version_positive_check" CHECK ("order_cases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "short_pick_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"original_location" text NOT NULL,
	"sku" text NOT NULL,
	"missing_quantity" integer NOT NULL,
	"reported_by_user_id" uuid NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" "short_pick_line_state" DEFAULT 'OPEN' NOT NULL,
	"current_responsible_user_id" uuid,
	"discovered_location" text,
	"discovered_by_user_id" uuid,
	"discovered_at" timestamp with time zone,
	"retrieval_state" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"retrieval_responsible_user_id" uuid,
	"retrieved_by_user_id" uuid,
	"retrieved_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "short_pick_lines_location_normalized_check" CHECK ("short_pick_lines"."original_location" = upper(btrim("short_pick_lines"."original_location")) AND length("short_pick_lines"."original_location") > 0),
	CONSTRAINT "short_pick_lines_sku_normalized_check" CHECK ("short_pick_lines"."sku" = upper(btrim("short_pick_lines"."sku")) AND length("short_pick_lines"."sku") > 0),
	CONSTRAINT "short_pick_lines_quantity_positive_check" CHECK ("short_pick_lines"."missing_quantity" > 0),
	CONSTRAINT "short_pick_lines_version_positive_check" CHECK ("short_pick_lines"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_picking_user_id_users_id_fk" FOREIGN KEY ("picking_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_current_case_responsible_user_id_users_id_fk" FOREIGN KEY ("current_case_responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_current_responsible_user_id_users_id_fk" FOREIGN KEY ("current_responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_discovered_by_user_id_users_id_fk" FOREIGN KEY ("discovered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_retrieval_responsible_user_id_users_id_fk" FOREIGN KEY ("retrieval_responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_pick_lines" ADD CONSTRAINT "short_pick_lines_retrieved_by_user_id_users_id_fk" FOREIGN KEY ("retrieved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_events_case_created_idx" ON "case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "order_cases_order_created_idx" ON "order_cases" USING btree ("order_number","created_at");--> statement-breakpoint
CREATE INDEX "order_cases_picking_phase_idx" ON "order_cases" USING btree ("picking_user_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "order_cases_one_open_per_order_uq" ON "order_cases" USING btree ("order_number") WHERE "order_cases"."phase" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "short_pick_lines_case_idx" ON "short_pick_lines" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "short_pick_lines_duplicate_idx" ON "short_pick_lines" USING btree ("case_id","original_location","sku","state");