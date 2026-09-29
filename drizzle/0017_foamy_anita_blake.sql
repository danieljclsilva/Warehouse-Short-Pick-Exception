ALTER TYPE "public"."check_completion_code" ADD VALUE 'FOUND_AT_ORIGINAL' BEFORE 'NOT_FOUND';--> statement-breakpoint

-- Wave 1 A1: restore the check workflow grants for every existing account.
UPDATE "users" AS target
SET "permissions" = (
  SELECT jsonb_agg(to_jsonb(value) ORDER BY value)
  FROM (
    SELECT DISTINCT value
    FROM jsonb_array_elements_text(
      target."permissions" || jsonb_build_array('VIEW_AVAILABLE_CHECKS', 'CLAIM_CHECK', 'COMPLETE_CHECK') ||
        CASE WHEN target."role" = 'PICKER' THEN jsonb_build_array('ADD_CASE_MESSAGE', 'VIEW_CASE_MESSAGES') ELSE '[]'::jsonb END
    ) AS entries(value)
  ) AS unique_entries
);--> statement-breakpoint

DO $$
DECLARE
  current_row RECORD;
  previous_values jsonb;
  next_values jsonb;
  changed_values jsonb;
  new_id uuid;
BEGIN
  SELECT * INTO current_row FROM "configuration_versions" ORDER BY "version" DESC LIMIT 1;
  IF current_row.id IS NULL THEN
    RAISE EXCEPTION 'Configuration has not been initialized; run migrations';
  END IF;

  previous_values := current_row.values;
  next_values := previous_values;
  IF (previous_values->>'MAX_SIMULTANEOUS_CHECKS_PER_CASE') = '1' THEN
    next_values := jsonb_set(next_values, '{MAX_SIMULTANEOUS_CHECKS_PER_CASE}', 'null'::jsonb, true);
  END IF;
  IF NOT ((next_values->'ALLOWED_RESOLUTION_CODES') ? 'FOUND_AT_ORIGINAL') THEN
    next_values := jsonb_set(next_values, '{ALLOWED_RESOLUTION_CODES}', (next_values->'ALLOWED_RESOLUTION_CODES') || '"FOUND_AT_ORIGINAL"'::jsonb, true);
  END IF;

  IF next_values IS DISTINCT FROM previous_values THEN
    changed_values := jsonb_build_object(
      'MAX_SIMULTANEOUS_CHECKS_PER_CASE', jsonb_build_object(
        'previous', previous_values->'MAX_SIMULTANEOUS_CHECKS_PER_CASE',
        'next', next_values->'MAX_SIMULTANEOUS_CHECKS_PER_CASE',
        'reason', 'Make every available line check claimable by default; preserve explicit caps other than legacy 1'
      ),
      'ALLOWED_RESOLUTION_CODES', jsonb_build_object(
        'previous', previous_values->'ALLOWED_RESOLUTION_CODES',
        'next', next_values->'ALLOWED_RESOLUTION_CODES',
        'reason', 'Enable the audited FOUND_AT_ORIGINAL check outcome'
      )
    );
    INSERT INTO "configuration_versions" ("version", "values", "changed_by_user_id")
      VALUES (current_row.version + 1, next_values, NULL)
      RETURNING "id" INTO new_id;
    INSERT INTO "configuration_audits" ("previous_version_id", "new_version_id", "changed_by_user_id", "changed_values")
      VALUES (current_row.id, new_id, NULL, changed_values);
    INSERT INTO "audit_log" ("actor_user_id", "action", "details")
      VALUES (NULL, 'CONFIGURATION_ROLL_FORWARD', jsonb_build_object(
        'previousVersion', current_row.version,
        'newVersion', current_row.version + 1,
        'changedValues', changed_values,
        'reason', 'Wave 1 A1 check workflow contract'
      ));
  END IF;
END $$;