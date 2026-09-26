CREATE TABLE "configuration_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"previous_version_id" uuid,
	"new_version_id" uuid NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_values" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configuration_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"values" jsonb NOT NULL,
	"changed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_cases" ADD COLUMN "configuration_version_id" uuid;--> statement-breakpoint
ALTER TABLE "configuration_audits" ADD CONSTRAINT "configuration_audits_previous_version_id_configuration_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_audits" ADD CONSTRAINT "configuration_audits_new_version_id_configuration_versions_id_fk" FOREIGN KEY ("new_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_audits" ADD CONSTRAINT "configuration_audits_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configuration_audits_changed_idx" ON "configuration_audits" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "configuration_audits_new_version_idx" ON "configuration_audits" USING btree ("new_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_versions_version_uq" ON "configuration_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "configuration_versions_created_idx" ON "configuration_versions" USING btree ("created_at");--> statement-breakpoint
DO $$
DECLARE
  legacy_capacity jsonb := (SELECT "value" FROM "app_settings" WHERE "key" = 'MAX_SIMULTANEOUS_CHECKS_PER_CASE' LIMIT 1);
  legacy_location jsonb := (SELECT "value" FROM "app_settings" WHERE "key" = 'SHORT_PICK_HOLD_LOCATION' LIMIT 1);
  legacy_critical jsonb := (SELECT "value" FROM "app_settings" WHERE "key" = 'DASHBOARD_ATTENTION_CRITICAL_MINUTES' LIMIT 1);
BEGIN
  INSERT INTO "configuration_versions" ("version", "values") VALUES (1, jsonb_build_object(
    'MAX_SIMULTANEOUS_CHECKS_PER_CASE', CASE WHEN legacy_capacity = '"UNLIMITED"'::jsonb THEN 'null'::jsonb WHEN jsonb_typeof(legacy_capacity) = 'number' AND (legacy_capacity #>> '{}') ~ '^[0-9]+$' AND (legacy_capacity #>> '{}')::int BETWEEN 1 AND 100 THEN legacy_capacity ELSE '1'::jsonb END,
    'CLAIM_CHECKS_ENABLED', true,
    'CHECKER_RETRIEVAL_DURING_PICKING_ENABLED', false,
    'CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED', true,
    'WARNING_THRESHOLD_MINUTES', 5,
    'ATTENTION_THRESHOLD_MINUTES', 10,
    'CRITICAL_THRESHOLD_MINUTES', CASE WHEN jsonb_typeof(legacy_critical) = 'number' AND (legacy_critical #>> '{}') ~ '^[0-9]+$' AND (legacy_critical #>> '{}')::int BETWEEN 1 AND 1440 THEN to_jsonb(GREATEST(10, (legacy_critical #>> '{}')::int)) ELSE '15'::jsonb END,
    'REQUIRE_STAGING_CONFIRMATION', true,
    'INVITE_DEFAULT_EXPIRY_HOURS', 8,
    'INVITE_DEFAULT_MAX_REGISTRATIONS', 1,
    'LOGIN_MAX_FAILED_ATTEMPTS', 5,
    'LOGIN_LOCKOUT_MINUTES', 15,
    'SHORT_PICK_HOLD_LOCATION_NAME', CASE WHEN jsonb_typeof(legacy_location) = 'string' AND length(btrim(legacy_location #>> '{}')) BETWEEN 1 AND 100 THEN legacy_location ELSE '"SHORT PICK / HOLD"'::jsonb END,
    'ALLOWED_RESOLUTION_CODES', jsonb_build_array('FOUND', 'NOT_FOUND', 'WRONG_LOCATION', 'OTHER'),
    'MANUAL_CASE_CREATION_ENABLED', true,
    'ASSISTANT_CAN_MANAGE_CONFIGURATION', false,
    'PUSH_ENABLED', true
  ));
END $$;--> statement-breakpoint
INSERT INTO "configuration_audits" ("new_version_id", "changed_values") SELECT "id", "values" FROM "configuration_versions" WHERE "version" = 1;--> statement-breakpoint
UPDATE "order_cases" SET "configuration_version_id" = (SELECT "id" FROM "configuration_versions" WHERE "version" = 1) WHERE "configuration_version_id" IS NULL;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_configuration_version_id_configuration_versions_id_fk" FOREIGN KEY ("configuration_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ALTER COLUMN "configuration_version_id" SET NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_configuration_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."changed_by_user_id" IS NULL
    AND OLD."changed_by_user_id" IS NOT NULL
    AND (to_jsonb(NEW) - 'changed_by_user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'changed_by_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Configuration history is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER configuration_versions_immutable BEFORE UPDATE OR DELETE ON "configuration_versions" FOR EACH ROW EXECUTE FUNCTION prevent_configuration_history_mutation();--> statement-breakpoint
CREATE TRIGGER configuration_audits_immutable BEFORE UPDATE OR DELETE ON "configuration_audits" FOR EACH ROW EXECUTE FUNCTION prevent_configuration_history_mutation();
