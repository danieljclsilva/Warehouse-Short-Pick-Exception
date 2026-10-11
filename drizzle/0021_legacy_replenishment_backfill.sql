-- Wave workflow corrections: backfill legacy COMPLETED replenishment lines with
-- missing retrieval obligations into PENDING obligations. Data-only migration;
-- no schema change. Eligible owners follow the persisted PICKING/STAGED routing
-- rules from each case's pinned configuration snapshot. Idempotent: guards on
-- retrieval_state = 'NOT_REQUIRED' plus NOT EXISTS on the stable migration
-- markers (details.migration or the legacy details.source) so a second run is
-- a no-op.
DO $$
DECLARE
  backfilled RECORD;
  selected_owner uuid;
  checker_id uuid;
  latest_task uuid;
  override_flag boolean;
  phase_value text;
  picking_id uuid;
  resolver_id uuid;
  config_id uuid;
  config jsonb;
  during_picking boolean;
  when_staged boolean;
  elig jsonb;
  payload jsonb;
  dedupe text;
  notif_id uuid;
  pick_elig boolean;
  resolv_elig boolean;
  check_elig boolean;
  named_elig boolean;
  named_staged boolean;
  event_source text;
  push_ok boolean;
BEGIN
  FOR backfilled IN
    SELECT line."id" AS line_id, line."case_id" AS case_id, line."state" AS line_state,
      line."discovered_location" AS discovered_location, line."original_location" AS original_location,
      line."discovered_by_user_id" AS finder_id,
      line."replenishment_retriever_user_id" AS named_retriever, line."replenishment_actor_user_id" AS old_actor,
      c."phase" AS case_phase, c."order_number" AS order_number,
      c."physical_location" AS physical_location, c."picking_user_id" AS picking_user_id,
      c."current_case_responsible_user_id" AS resolver_user_id,
      c."configuration_version_id" AS configuration_version_id, c."version" AS case_version,
      line."retrieval_responsible_user_id" AS previous_owner, line."version" AS line_version
    FROM "short_pick_lines" AS line
    JOIN "order_cases" AS c ON c."id" = line."case_id"
    WHERE line."replenishment_state" = 'COMPLETED'
      AND line."retrieval_state" = 'NOT_REQUIRED'
      AND line."state" NOT IN ('RESOLVED', 'CANCELLED')
      AND line."retrieved_at" IS NULL
      AND c."phase" IN ('PICKING', 'STAGED')
      AND NOT EXISTS (
        SELECT 1 FROM "case_events" AS e
        WHERE e."case_id" = line."case_id" AND e."short_pick_line_id" = line."id"
          AND e."event_type" = 'RETRIEVAL_ASSIGNED'
          AND (e."details"->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL'
            OR e."details"->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL')
      )
    ORDER BY line."created_at", line."id"
    FOR UPDATE OF c, line
  LOOP
    phase_value := backfilled.case_phase;
    picking_id := backfilled.picking_user_id;
    resolver_id := backfilled.resolver_user_id;
    config_id := backfilled.configuration_version_id;
    SELECT "values" INTO config FROM "configuration_versions" WHERE "id" = config_id;
    during_picking := COALESCE((config->>'CHECKER_RETRIEVAL_DURING_PICKING_ENABLED')::boolean, false);
    when_staged := COALESCE((config->>'CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED')::boolean, true);

    -- Originating checker: latest COMPLETED task with a FOUND code, assigned wins over claimed.
    SELECT task."id", COALESCE(task."assigned_to_user_id", task."claimed_by_user_id")
      INTO latest_task, checker_id
    FROM "check_tasks" AS task
    WHERE task."short_pick_line_id" = backfilled.line_id
      AND task."status" = 'COMPLETED'
      AND task."completion_code" IN ('FOUND', 'FOUND_AT_ORIGINAL')
    ORDER BY task."completed_at" DESC NULLS LAST, task."created_at" DESC, task."id" DESC
    LIMIT 1;
    -- Persisted finder fallback: when no FOUND task yields an origin checker,
    -- the recorded discoverer is the origin, exactly like the shared resolver.
    IF checker_id IS NULL THEN
      checker_id := backfilled.finder_id;
    END IF;

    -- Task-specific explicit picker override: only the latest event for the
    -- actual origin task decides; never a sibling task's event.
    override_flag := false;
    IF latest_task IS NOT NULL THEN
      SELECT (e."details"->>'pickerRetrieval') = 'true' INTO override_flag
      FROM "case_events" AS e
      WHERE e."case_id" = backfilled.case_id AND e."short_pick_line_id" = backfilled.line_id
        AND e."event_type" IN ('CHECK_ASSIGNED', 'CHECK_REASSIGNED')
        AND e."details"->>'taskId' = latest_task::text
      ORDER BY e."created_at" DESC, e."id" DESC
      LIMIT 1;
      override_flag := COALESCE(override_flag, false);
    END IF;

    -- Eligibility: ACTIVE status plus CONFIRM_RETRIEVAL grant.
    SELECT jsonb_build_object('status', "status", 'perms', "permissions") INTO elig
    FROM "users" WHERE "id" = picking_id;
    pick_elig := elig IS NOT NULL AND (elig->>'status') = 'ACTIVE'
      AND (elig->'perms') ? 'CONFIRM_RETRIEVAL';
    SELECT jsonb_build_object('status', "status", 'perms', "permissions") INTO elig
    FROM "users" WHERE "id" = resolver_id;
    resolv_elig := elig IS NOT NULL AND (elig->>'status') = 'ACTIVE'
      AND (elig->'perms') ? 'CONFIRM_RETRIEVAL';
    SELECT jsonb_build_object('status', "status", 'perms', "permissions") INTO elig
    FROM "users" WHERE "id" = checker_id;
    check_elig := elig IS NOT NULL AND (elig->>'status') = 'ACTIVE'
      AND (elig->'perms') ? 'CONFIRM_RETRIEVAL';
    SELECT jsonb_build_object('status', "status", 'perms', "permissions") INTO elig
    FROM "users" WHERE "id" = backfilled.named_retriever;
    named_elig := backfilled.named_retriever IS NOT NULL AND elig IS NOT NULL
      AND (elig->>'status') = 'ACTIVE' AND (elig->'perms') ? 'CONFIRM_RETRIEVAL';

    -- Precedence: eligible explicitly named STAGED retrieval owners are manual
    -- assignments. Otherwise the explicit picker override wins and only yields
    -- the eligible picker (a missing eligible picker stays null, never falls
    -- through). Otherwise a valid named retriever is honored: PICKING accepts
    -- only the eligible picker or the configured origin checker; STAGED honors
    -- any eligible explicitly named user (any role, including the picker) as an
    -- intentional assignment. Anything else follows the phase-derived default:
    -- PICKING the configured checker else the picker; STAGED the eligible
    -- explicitly assigned resolver (responsible differs from picker), then the
    -- configured checker.
    selected_owner := NULL;
    named_staged := false;
    IF phase_value = 'STAGED' AND named_elig THEN
      selected_owner := backfilled.named_retriever;
      named_staged := true;
    ELSIF override_flag THEN
      IF pick_elig THEN
        selected_owner := picking_id;
      END IF;
    ELSE
      IF named_elig THEN
        IF phase_value = 'PICKING'
          AND (backfilled.named_retriever = picking_id
            OR (during_picking AND backfilled.named_retriever = checker_id)) THEN
          selected_owner := backfilled.named_retriever;
        ELSIF phase_value = 'STAGED' THEN
          selected_owner := backfilled.named_retriever;
          named_staged := true;
        END IF;
      END IF;
      IF selected_owner IS NULL THEN
        IF phase_value = 'PICKING' THEN
          IF during_picking AND check_elig THEN
            selected_owner := checker_id;
          ELSIF pick_elig THEN
            selected_owner := picking_id;
          END IF;
        ELSIF phase_value = 'STAGED' THEN
          IF resolv_elig AND resolver_id IS DISTINCT FROM picking_id THEN
            selected_owner := resolver_id;
          ELSIF when_staged AND check_elig THEN
            selected_owner := checker_id;
          END IF;
        END IF;
      END IF;
    END IF;

    -- Retrieval owner and current owner move together (including null); main
    -- state and discovered fields stay untouched.
    UPDATE "short_pick_lines"
    SET "retrieval_state" = 'PENDING',
        "retrieval_responsible_user_id" = selected_owner,
        "current_responsible_user_id" = selected_owner,
        "updated_at" = now(),
        "version" = "version" + 1
    WHERE "id" = backfilled.line_id;
    UPDATE "order_cases"
    SET "updated_at" = now(), "version" = "version" + 1
    WHERE "id" = backfilled.case_id;

    -- Honored explicit STAGED names carry the manual-assignment source so later
    -- staged rederives preserve them; the stable migration marker keeps the
    -- guard idempotent either way. Audit reason is always the legacy marker.
    IF named_staged THEN
      event_source := 'MANUAL_RETRIEVAL_ASSIGNMENT';
    ELSE
      event_source := 'LEGACY_REPLENISHMENT_BACKFILL';
    END IF;
    INSERT INTO "case_events" ("case_id", "short_pick_line_id", "actor_user_id", "event_type", "details")
    VALUES (backfilled.case_id, backfilled.line_id, NULL, 'RETRIEVAL_ASSIGNED',
      jsonb_build_object('responsibleUserId', selected_owner, 'previousUserId', backfilled.previous_owner,
        'casePhase', phase_value, 'source', event_source, 'migration', 'LEGACY_REPLENISHMENT_BACKFILL'));
    INSERT INTO "audit_log" ("actor_user_id", "action", "details")
    VALUES (NULL, 'RETRIEVAL_ASSIGNED',
      jsonb_build_object('caseId', backfilled.case_id, 'lineId', backfilled.line_id,
        'responsibleUserId', selected_owner, 'previousUserId', backfilled.previous_owner,
        'reason', 'LEGACY_REPLENISHMENT_BACKFILL', 'source', 'migration'));

    IF selected_owner IS NOT NULL THEN
      dedupe := 'legacy-replenishment-backfill:' || backfilled.line_id::text;
      payload := jsonb_build_object('orderNumber', backfilled.order_number,
        'casePhase', phase_value,
        'discoveredLocation', backfilled.discovered_location,
        'originalLocation', backfilled.original_location,
        'location', COALESCE(backfilled.discovered_location, backfilled.original_location),
        'reassigned', false);
      IF phase_value = 'STAGED' AND backfilled.physical_location IS NOT NULL THEN
        payload := payload || jsonb_build_object('physicalLocation', backfilled.physical_location);
      END IF;
      INSERT INTO "notifications" ("recipient_user_id", "type", "case_id", "short_pick_line_id", "payload", "dedupe_key")
      VALUES (selected_owner, 'RESPONSIBILITY_RETRIEVAL_ASSIGNED', backfilled.case_id, backfilled.line_id, payload, dedupe)
      ON CONFLICT DO NOTHING
      RETURNING "id" INTO notif_id;

      IF notif_id IS NOT NULL THEN
        -- Mirror the application enqueue rule: the latest configuration row
        -- must have PUSH_ENABLED true, and only enabled (non-disabled) devices
        -- are enqueued, one outbox row per device. Worker VAPID gating happens
        -- at delivery time; queued rows without worker keys simply stay queued.
        SELECT COALESCE((cv."values"->>'PUSH_ENABLED')::boolean, false) INTO push_ok
        FROM "configuration_versions" AS cv ORDER BY cv."version" DESC LIMIT 1;
        IF COALESCE(push_ok, false) THEN
          INSERT INTO "push_outbox" ("notification_id", "subscription_id")
          SELECT notif_id, s."id" FROM "push_subscriptions" AS s
          WHERE s."user_id" = selected_owner AND s."disabled_at" IS NULL
          ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END IF;
  END LOOP;
END $$;
