#!/usr/bin/env node
// Disposable upgrade-path proof for tracked migrations 0020 (notification
// enum additions) + 0021 (legacy replenishment backfill).
// Usage: sh scripts/with-test-env.sh node scripts/prove-workflow-corrections-upgrade.mjs [--keep]
// The script parses DATABASE_URL in code (never prints it) and derives two own
// disposable databases from it; with-test-env.sh guards the base URL. It
// creates/drops ONLY its own uniquely suffixed *_test databases and refuses
// restore/fixture names. No .env is read; no secrets are printed.
// Steps:
//   1. fresh DB: apply all migrations 0000..0021 from scratch.
//   2. upgrade DB: baseline through 0019 -> seed synthetic legacy rows ->
//      apply 0020..0021 -> assert every acceptance predicate.
//   3. Raw 0021 SQL rerun must be idempotent (markers make it a no-op).
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keep = process.argv.includes("--keep");
const TAG = "prove-workflow-corrections-upgrade";

function fail(message) {
  throw new Error(`${TAG}: FAIL: ${message}`);
}
function ok(message) {
  console.log(`${TAG}: ok: ${message}`);
}

// Parse DATABASE_URL in code; never print its value. Derive the admin URL
// from its pathname (/postgres) without logging credentials.
const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set");
let parsed;
try {
  parsed = new URL(url);
} catch {
  fail("DATABASE_URL is not a valid URL");
}
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname.toLowerCase())) {
  fail("refusing non-local DATABASE_URL");
}
if (url.includes("?") || url.includes("#")) fail("DATABASE_URL must not include query parameters or a fragment");
const baseName = decodeURIComponent(parsed.pathname.slice(1));
if (!/^[A-Za-z0-9_]+_test$/.test(baseName) || /^(shortpick_restore|shortpick_fixture)_/.test(baseName)) {
  fail("refusing base database name (must end in _test, not restore/fixture)");
}
const stamp = `${process.pid}_${Date.now().toString(36)}`;
const freshDb = `shortpick_wfcorr_fresh_${stamp}_test`;
const upgradeDb = `shortpick_wfcorr_upgrade_${stamp}_test`;
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const withDb = (name) => {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
};

async function execFileStatements(client, path) {
  const text = readFileSync(path, "utf8");
  const parts = text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of parts) {
    await client.unsafe(statement);
  }
}

function migrationFilesThrough(tag) {
  return readdirSync(join(root, "drizzle"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => f <= tag);
}

const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8"));
for (const tag of ["0020_workflow-corrections-notifications", "0021_legacy_replenishment_backfill"]) {
  if (!journal.entries.find((e) => e.tag === tag)) fail(`${tag} missing from drizzle/meta/_journal.json`);
}

const admin = postgres(adminUrl.toString(), { max: 1 });
let fresh = null;
let upgrade = null;
try {
  await admin.unsafe(`CREATE DATABASE "${freshDb}"`);
  await admin.unsafe(`CREATE DATABASE "${upgradeDb}"`);
  ok(`created own disposable databases (${freshDb}, ${upgradeDb})`);
  fresh = postgres(withDb(freshDb), { max: 1 });
  upgrade = postgres(withDb(upgradeDb), { max: 1 });

  // ---- Path 1: fresh apply of every tracked migration. ----
  for (const file of migrationFilesThrough("0021_legacy_replenishment_backfill.sql")) {
    await execFileStatements(fresh, join(root, "drizzle", file));
  }
  const freshEnum = await fresh`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'notification_type' order by e.enumsortorder`;
  const labels = freshEnum.map((r) => r.enumlabel);
  if (!labels.includes("CHECK_RESOLVED_EXTERNALLY") || !labels.includes("ORDER_STAGED")) {
    fail("fresh DB missing the new notification enum values");
  }
  ok(`fresh all-migrations apply: notification_type has both new values (${labels.length} total)`);

  // ---- Path 2: baseline through 0019, then seed synthetic legacy rows. ----
  for (const file of migrationFilesThrough("0019_hot_wildside.sql")) {
    await execFileStatements(upgrade, join(root, "drizzle", file));
  }
  const preEnum = await upgrade`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'notification_type' order by e.enumsortorder`;
  if (preEnum.some((r) => r.enumlabel === "CHECK_RESOLVED_EXTERNALLY" || r.enumlabel === "ORDER_STAGED")) {
    fail("0019 baseline already contains the new enum values");
  }
  ok("0019 baseline lacks both new enum values");

  const [cfg] = await upgrade`select id, version, values from configuration_versions order by version desc limit 1`;
  if (!cfg) fail("no configuration version seeded by baseline migrations");
  // Appended version row enabling both checker-routing flags + push, the same
  // way the app writes configuration (history stays immutable).
  const pushedValues = { ...cfg.values, CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: true, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true, PUSH_ENABLED: true };
  const [cfg2] = await upgrade`insert into configuration_versions (version, values) values (${Number(cfg.version) + 1}, ${upgrade.json(pushedValues)}) returning id`;
  await upgrade`insert into configuration_audits (previous_version_id, new_version_id, changed_values) values (${cfg.id}, ${cfg2.id}, ${upgrade.json({ proof: true })})`;

  const U = {
    picker: randomUUID(), checker: randomUUID(), resolver: randomUUID(),
    named: randomUUID(), disabled: randomUUID(), nogran: randomUUID(),
    unconfirmed: randomUUID(), reporter: randomUUID(),
  };
  await upgrade`insert into users (id, identifier, display_name, pin_hash, role, status, permissions) values
    (${U.picker}, 'wfcorr-picker', 'Wfcorr Picker', 'x', 'PICKER', 'ACTIVE', '["CONFIRM_RETRIEVAL"]'::jsonb),
    (${U.checker}, 'wfcorr-checker', 'Wfcorr Checker', 'x', 'TROUBLESHOOTER', 'ACTIVE', '["CONFIRM_RETRIEVAL"]'::jsonb),
    (${U.resolver}, 'wfcorr-resolver', 'Wfcorr Resolver', 'x', 'TEAM_LEADER', 'ACTIVE', '["CONFIRM_RETRIEVAL"]'::jsonb),
    (${U.named}, 'wfcorr-named', 'Wfcorr Named', 'x', 'PICKER', 'ACTIVE', '["CONFIRM_RETRIEVAL"]'::jsonb),
    (${U.disabled}, 'wfcorr-disabled', 'Wfcorr Disabled', 'x', 'PICKER', 'DISABLED', '["CONFIRM_RETRIEVAL"]'::jsonb),
    (${U.nogran}, 'wfcorr-nogran', 'Wfcorr No Grant', 'x', 'PICKER', 'ACTIVE', '[]'::jsonb),
    (${U.unconfirmed}, 'wfcorr-unconf', 'Wfcorr Unconfirmed', 'x', 'PICKER', 'ACTIVE', '[]'::jsonb),
    (${U.reporter}, 'wfcorr-reporter', 'Wfcorr Reporter', 'x', 'MANAGER', 'ACTIVE', '["RECORD_REPLENISHMENT"]'::jsonb)`;
  // Enabled + disabled device subscriptions for the eligible PICKING picker.
  await upgrade`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values
    (${U.picker}, 'https://example.test/wfcorr-enabled', 'k1', 'a1'),
    (${U.named}, 'https://example.test/wfcorr-named', 'k2', 'a2')`;
  await upgrade`update push_subscriptions set disabled_at = now() where endpoint = 'https://example.test/wfcorr-named'`;
  // Extra enabled device for the checker target (STAGED path asserts outbox fan-out).
  await upgrade`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${U.checker}, 'https://example.test/wfcorr-checker', 'k3', 'a3')`;

  async function seedCase(order, phase, pickerId, resolverId, physical) {
    const id = randomUUID();
    await upgrade`insert into order_cases (id, order_number, phase, physical_state, physical_location, picking_user_id, current_case_responsible_user_id, created_by_user_id, configuration_version_id)
      values (${id}, ${order}, ${phase}, ${phase === "STAGED" ? "SHORT_PICK_HOLD" : "WITH_PICKER"}, ${physical}, ${pickerId}, ${resolverId}, ${U.reporter}, ${cfg2.id})`;
    return id;
  }
  async function seedLine(caseId, overrides = {}) {
    const id = randomUUID();
    const row = {
      replenishment_state: "COMPLETED", retrieval_state: "NOT_REQUIRED", state: "OPEN",
      discovered_location: "HOLD-A1", original_location: `LOC-${id.slice(0, 4).toUpperCase()}`,
      ...overrides,
    };
    await upgrade`insert into short_pick_lines (id, case_id, original_location, sku, missing_quantity, reported_by_user_id, state, discovered_location, discovered_by_user_id, retrieval_state, replenishment_state, replenishment_retriever_user_id, replenishment_actor_user_id, retrieved_at, resolved_at)
      values (${id}, ${caseId}, ${row.original_location}, 'SKU-WFCORR', 1, ${U.reporter}, ${row.state}, ${row.discovered_location}, ${row.discovered_by_user_id ?? null}, ${row.retrieval_state}, ${row.replenishment_state}, ${row.replenishment_retriever_user_id ?? null}, ${row.replenishment_actor_user_id ?? null}, ${row.retrieved_at ?? null}, ${row.resolved_at ?? null})`;
    return id;
  }
  async function seedTask(lineId, checkerId, code = "FOUND", completedAt = null) {
    const taskId = randomUUID();
    await upgrade`insert into check_tasks (id, short_pick_line_id, status, claimed_by_user_id, assigned_to_user_id, completed_at, completion_code)
      values (${taskId}, ${lineId}, 'COMPLETED', ${checkerId}, ${checkerId}, ${completedAt ?? new Date().toISOString()}, ${code})`;
    return taskId;
  }
  async function seedOverride(caseId, lineId, taskId, flag) {
    await upgrade`insert into case_events (case_id, short_pick_line_id, event_type, details)
      values (${caseId}, ${lineId}, 'CHECK_ASSIGNED', ${upgrade.json({ taskId, pickerRetrieval: flag })})`;
  }


  // Eligible PICKING picker (origin checker exists, during-picking enabled so
  // the picker still wins only when no checker override applies — here the
  // named retriever equals the picker and is valid for PICKING). Deterministic
  // completed_at stamps: the sibling override is older, the actual origin task
  // is newer, so latest-task selection never ties on now().
  const casePicking = await seedCase("900001", "PICKING", U.picker, U.picker, null);
  const linePicking = await seedLine(casePicking, { replenishment_retriever_user_id: U.picker, replenishment_actor_user_id: U.reporter });
  const siblingTask = await seedTask(linePicking, U.checker, "FOUND", "2026-01-01T00:00:00.000Z");
  await seedOverride(casePicking, linePicking, siblingTask, true);
  const taskPicking = await seedTask(linePicking, U.checker, "FOUND", "2026-01-02T00:00:00.000Z");
  await seedOverride(casePicking, linePicking, taskPicking, false);
  const [originTask] = await upgrade`select id from check_tasks where short_pick_line_id = ${linePicking} order by completed_at desc limit 1`;
  if (originTask?.id !== taskPicking) fail("origin fixture nondeterministic: latest task is not the actual origin task");

  // STAGED named resolver: named retriever equals the explicit resolver.
  const caseStaged = await seedCase("900002", "STAGED", U.picker, U.resolver, "SHORT PICK / HOLD");
  const lineStaged = await seedLine(caseStaged, { replenishment_retriever_user_id: U.resolver, replenishment_actor_user_id: U.reporter });
  await seedTask(lineStaged, U.checker, "FOUND_AT_ORIGINAL");

  // STAGED checker fallback: named retriever ineligible (disabled) so the
  // configured originating checker wins.
  const caseStagedChecker = await seedCase("900003", "STAGED", U.picker, U.picker, "SHORT PICK / HOLD");
  const lineStagedChecker = await seedLine(caseStagedChecker, { replenishment_retriever_user_id: U.disabled, replenishment_actor_user_id: U.reporter });
  await seedTask(lineStagedChecker, U.checker);

  // Missing target: picker lacks CONFIRM_RETRIEVAL and no origin checker, so
  // the owner stays null (manager assignment) but the line still goes PENDING.
  const caseNull = await seedCase("900004", "PICKING", U.nogran, U.nogran, null);
  const lineNull = await seedLine(caseNull, { replenishment_retriever_user_id: U.nogran, replenishment_actor_user_id: U.reporter });

  // Disabled named target with no origin checker -> null owner.
  const caseDisabled = await seedCase("900005", "PICKING", U.disabled, U.disabled, null);
  const lineDisabled = await seedLine(caseDisabled, { replenishment_retriever_user_id: U.disabled, replenishment_actor_user_id: U.reporter });

  // No-confirm named target with an eligible origin checker configured during
  // picking -> checker wins over the ineligible named user.
  const caseNoConfirm = await seedCase("900006", "PICKING", U.picker, U.picker, null);
  const lineNoConfirm = await seedLine(caseNoConfirm, { replenishment_retriever_user_id: U.unconfirmed, replenishment_actor_user_id: U.reporter });
  await seedTask(lineNoConfirm, U.checker);

  // Explicit picker override on the actual origin task -> eligible picker wins
  // even though during-picking checker routing is enabled.
  const caseOverride = await seedCase("900007", "PICKING", U.picker, U.picker, null);
  const lineOverride = await seedLine(caseOverride, { replenishment_actor_user_id: U.reporter });
  const taskOverride = await seedTask(lineOverride, U.checker);
  await seedOverride(caseOverride, lineOverride, taskOverride, true);

  // STAGED arbitrary named worker (not the case resolver): any eligible
  // explicitly named user is honored as an intentional assignment. No
  // discovered location, so the notification location falls back to the
  // original location. The only U.named device is disabled, so this line
  // notifies in-app but must not enqueue any outbox row.
  const caseStagedNamed = await seedCase("900010", "STAGED", U.picker, U.picker, null);
  const lineStagedNamed = await seedLine(caseStagedNamed, { discovered_location: null, original_location: "LOC-FALLBACK-1", replenishment_retriever_user_id: U.named, replenishment_actor_user_id: U.reporter });
  const stagedNamedTask = await seedTask(lineStagedNamed, U.checker, "FOUND", "2026-01-03T00:00:00.000Z");
  await seedOverride(caseStagedNamed, lineStagedNamed, stagedNamedTask, true);

  // Finder fallback: no FOUND task, so the recorded discoverer is the origin
  // checker and wins during-picking over the ineligible named user.
  const caseFinder = await seedCase("900011", "PICKING", U.picker, U.picker, null);
  const lineFinder = await seedLine(caseFinder, { replenishment_retriever_user_id: U.unconfirmed, replenishment_actor_user_id: U.reporter, discovered_by_user_id: U.checker });
  // Exclusions: terminal RESOLVED, CANCELLED, RETRIEVED (retrieved_at set),
  // non-NOT_REQUIRED retrieval, and a CLOSED case line. None may be touched.
  const caseExcl = await seedCase("900008", "PICKING", U.picker, U.picker, null);
  const exclResolved = await seedLine(caseExcl, { state: "RESOLVED", resolved_at: new Date().toISOString() });
  const exclCancelled = await seedLine(caseExcl, { state: "CANCELLED" });
  const exclRetrieved = await seedLine(caseExcl, { retrieved_at: new Date().toISOString(), retrieval_state: "NOT_REQUIRED" });
  const exclPending = await seedLine(caseExcl, { retrieval_state: "PENDING" });
  const caseClosed = await seedCase("900009", "CLOSED", U.picker, U.picker, null);
  const exclClosed = await seedLine(caseClosed, {});
  ok("seeded synthetic legacy lines, users, and subscriptions on the 0019 baseline");

  // ---- Apply the new tracked migrations (0020 enum, then 0021 backfill). ----
  // SQL queues from the latest PUSH_ENABLED row plus enabled devices; the
  // worker handles VAPID/delivery separately.
  await execFileStatements(upgrade, join(root, "drizzle", "0020_workflow-corrections-notifications.sql"));
  await execFileStatements(upgrade, join(root, "drizzle", "0021_legacy_replenishment_backfill.sql"));
  ok("applied migrations 0020..0021 onto the seeded 0019 baseline");

  // Raw data migration rerun: applying the 0021 SQL statements twice must
  // change nothing (markers make the second run a no-op).
  const countsBefore = await upgrade`select
    (select count(*)::int from short_pick_lines where retrieval_state = 'PENDING') as pending,
    (select count(*)::int from case_events where event_type = 'RETRIEVAL_ASSIGNED' and (details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL' or details->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL')) as legacy_events,
    (select count(*)::int from case_events where event_type = 'RETRIEVAL_ASSIGNED' and details->>'source' = 'MANUAL_RETRIEVAL_ASSIGNMENT' and details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL') as manual_events,
    (select count(*)::int from audit_log where action = 'RETRIEVAL_ASSIGNED' and details->>'reason' = 'LEGACY_REPLENISHMENT_BACKFILL') as audits,
    (select count(*)::int from notifications where dedupe_key like 'legacy-replenishment-backfill:%') as notifs,
    (select count(*)::int from push_outbox o join notifications n on n.id = o.notification_id where n.dedupe_key like 'legacy-replenishment-backfill:%') as outbox,
    (select coalesce(max(version), 0)::int from short_pick_lines) as max_line_version,
    (select coalesce(max(version), 0)::int from order_cases) as max_case_version`;
  await execFileStatements(upgrade, join(root, "drizzle", "0021_legacy_replenishment_backfill.sql"));
  const countsAfter = await upgrade`select
    (select count(*)::int from short_pick_lines where retrieval_state = 'PENDING') as pending,
    (select count(*)::int from case_events where event_type = 'RETRIEVAL_ASSIGNED' and (details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL' or details->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL')) as legacy_events,
    (select count(*)::int from case_events where event_type = 'RETRIEVAL_ASSIGNED' and details->>'source' = 'MANUAL_RETRIEVAL_ASSIGNMENT' and details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL') as manual_events,
    (select count(*)::int from audit_log where action = 'RETRIEVAL_ASSIGNED' and details->>'reason' = 'LEGACY_REPLENISHMENT_BACKFILL') as audits,
    (select count(*)::int from notifications where dedupe_key like 'legacy-replenishment-backfill:%') as notifs,
    (select count(*)::int from push_outbox o join notifications n on n.id = o.notification_id where n.dedupe_key like 'legacy-replenishment-backfill:%') as outbox,
    (select coalesce(max(version), 0)::int from short_pick_lines) as max_line_version,
    (select coalesce(max(version), 0)::int from order_cases) as max_case_version`;
  if (JSON.stringify(countsBefore[0]) !== JSON.stringify(countsAfter[0])) {
    fail(`second raw 0021 rerun changed counts (before ${JSON.stringify(countsBefore[0])}, after ${JSON.stringify(countsAfter[0])})`);
  }
  ok(`second raw 0021 rerun is idempotent ${JSON.stringify(countsAfter[0])}`);

  // ---- Assertions. ----
  const lines = Object.fromEntries((await upgrade`select id, case_id, state, discovered_location, retrieval_state, retrieval_responsible_user_id, current_responsible_user_id, replenishment_state, replenishment_retriever_user_id, retrieved_at, version from short_pick_lines`).map((r) => [r.id, r]));
  const L = (id) => {
    const row = lines[id];
    if (!row) fail(`line ${id} missing after migration`);
    return row;
  };
  const expectOwner = (id, want, label) => {
    const got = L(id).retrieval_responsible_user_id;
    if (got !== want) fail(`${label}: owner ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    if (L(id).current_responsible_user_id !== want) fail(`${label}: current owner ${JSON.stringify(L(id).current_responsible_user_id)}, want ${JSON.stringify(want)}`);
  };
  // Eligible fixtures drive every expected count below (no hardcoded arrays).
  const eligibleFixtures = [
    [linePicking, U.picker, "picking", U.picker],
    [lineStaged, U.resolver, "staged", U.resolver],
    [lineStagedChecker, U.checker, "staged-checker", U.disabled],
    [lineNoConfirm, U.checker, "no-confirm", U.unconfirmed],
    [lineOverride, U.picker, "override", null],
    [lineStagedNamed, U.named, "staged-named", U.named],
    [lineFinder, U.checker, "finder", U.unconfirmed],
  ];
  const nullFixtures = [[lineNull, "null"], [lineDisabled, "disabled"]];
  for (const [id, owner, label] of eligibleFixtures) {
    expectOwner(id, owner, label);
    if (L(id).retrieval_state !== "PENDING") fail(`${label} line not PENDING`);
    if (L(id).replenishment_state !== "COMPLETED") fail(`${label} replenishment mutated`);
  }
  // Null-owner legacy stays PENDING for manager assignment.
  for (const [id, label] of nullFixtures) {
    expectOwner(id, null, `${label} target`);
    if (L(id).retrieval_state !== "PENDING") fail(`${label} line not PENDING`);
  }
  ok("eligible lines PENDING with routed owners; missing/disabled targets PENDING with null owner");

  // Main state + discovered location unchanged; old replenishment state kept;
  // versions incremented exactly once.
  for (const [id, , label] of [...eligibleFixtures, ...nullFixtures.map(([lid, l]) => [lid, null, l])]) {
    const row = L(id);
    if (row.state !== "OPEN") fail(`${label} main state mutated to ${row.state}`);
    if (row.version !== 2) fail(`${label} line version ${row.version}, want 2 (single increment)`);
  }
  for (const [id, , label] of eligibleFixtures) {
    if (id === lineStagedNamed) {
      if (L(id).discovered_location !== null) fail("staged-named discovered location mutated");
    } else if (L(id).discovered_location !== "HOLD-A1") fail(`${label} discovered location mutated`);
  }
  // Named retriever input preserved (migration never rewrites history).
  for (const [id, , , named] of eligibleFixtures) {
    if (L(id).replenishment_retriever_user_id !== named) fail(`named retriever mutated on ${id}`);
  }
  const caseVersions = await upgrade`select id, version from order_cases where id in (${casePicking}, ${caseStaged}, ${caseStagedChecker}, ${caseNoConfirm}, ${caseOverride}, ${caseStagedNamed}, ${caseFinder}, ${caseNull}, ${caseDisabled})`;
  if (caseVersions.length !== 9) fail(`touched cases = ${caseVersions.length}, want 9`);
  for (const c of caseVersions) {
    if (c.version !== 2) fail(`case ${c.id} version ${c.version}, want 2 (single increment)`);
  }
  ok("main state/discovered fields unchanged; line + case versions incremented once");

  // Exclusions untouched.
  for (const [id, wantState, label] of [[exclResolved, "RESOLVED", "terminal"], [exclCancelled, "CANCELLED", "cancelled"], [exclPending, "OPEN", "already-pending"], [exclClosed, "OPEN", "closed-case"]]) {
    const row = L(id);
    if (row.retrieval_state !== (id === exclPending ? "PENDING" : "NOT_REQUIRED")) fail(`${label} exclusion retrieval mutated`);
    if (row.state !== wantState) fail(`${label} exclusion state mutated`);
    if (row.retrieval_responsible_user_id) fail(`${label} exclusion gained an owner`);
  }
  if (L(exclRetrieved).retrieved_at === null) fail("retrieved exclusion lost its timestamp");
  if (L(exclRetrieved).retrieval_state !== "NOT_REQUIRED") fail("retrieved exclusion mutated");
  ok("terminal/retrieved/closed/already-pending exclusions untouched");

  // Events + audit: one RETRIEVAL_ASSIGNED each, system/null actor, migration marker.
  const events = await upgrade`select short_pick_line_id, actor_user_id, details from case_events where event_type = 'RETRIEVAL_ASSIGNED' and details->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL' and details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL'`;
  const manualEvents = await upgrade`select short_pick_line_id, actor_user_id, details from case_events where event_type = 'RETRIEVAL_ASSIGNED' and details->>'source' = 'MANUAL_RETRIEVAL_ASSIGNMENT' and details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL'`;
  const totalMarked = await upgrade`select count(*)::int as n from case_events where event_type = 'RETRIEVAL_ASSIGNED' and (details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL' or details->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL')`;
  const audits = await upgrade`select actor_user_id, details from audit_log where action = 'RETRIEVAL_ASSIGNED' and details->>'reason' = 'LEGACY_REPLENISHMENT_BACKFILL'`;
  const eligibleIds = new Set([...eligibleFixtures.map(([id]) => id), lineNull, lineDisabled]);
  if (totalMarked[0].n !== eligibleIds.size) fail(`backfill events (migration OR source) = ${totalMarked[0].n}, want ${eligibleIds.size}`);
  if (events.length + manualEvents.length !== eligibleIds.size) fail(`partitioned backfill events = ${events.length + manualEvents.length}, want ${eligibleIds.size}`);
  for (const e of [...events, ...manualEvents]) {
    if (e.actor_user_id !== null) fail("backfill event attributes automation to a user");
    if (!eligibleIds.has(e.short_pick_line_id)) fail("backfill event on ineligible line");
    if (e.details?.migration !== "LEGACY_REPLENISHMENT_BACKFILL") fail("backfill event missing details.migration marker");
  }
  for (const id of [lineStaged, lineStagedNamed]) {
    const e = manualEvents.find((r) => r.short_pick_line_id === id);
    if (!e) fail(`missing manual STAGED event for ${id}`);
    if (e.details?.source !== "MANUAL_RETRIEVAL_ASSIGNMENT") fail(`STAGED named event source wrong for ${id}`);
  }
  for (const a of audits) {
    if (a.actor_user_id !== null) fail("backfill audit attributes automation to a user");
    if (a.details?.source !== "migration") fail("backfill audit missing source=migration");
  }
  // No automation attributed to the old replenishment actor.
  const actorEvents = await upgrade`select count(*)::int as n from case_events where event_type = 'RETRIEVAL_ASSIGNED' and (details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL' or details->>'source' = 'LEGACY_REPLENISHMENT_BACKFILL') and actor_user_id = ${U.reporter}`;
  if (actorEvents[0].n !== 0) fail("backfill attributed to the old replenishment actor");
  const actorManual = await upgrade`select count(*)::int as n from case_events where event_type = 'RETRIEVAL_ASSIGNED' and details->>'source' = 'MANUAL_RETRIEVAL_ASSIGNMENT' and details->>'migration' = 'LEGACY_REPLENISHMENT_BACKFILL' and actor_user_id = ${U.reporter}`;
  if (actorManual[0].n !== 0) fail("manual backfill attributed to the old replenishment actor");
  ok(`${events.length + manualEvents.length} RETRIEVAL_ASSIGNED events (${manualEvents.length} manual STAGED) + ${audits.length} audits, all system/null actor with migration marker`);

  // Notifications: eligible new owners only, stable dedupe keys, case/line/phase/location payload.
  const notifs = await upgrade`select recipient_user_id, type, case_id, short_pick_line_id, payload, dedupe_key from notifications where dedupe_key like 'legacy-replenishment-backfill:%'`;
  const notified = new Map(notifs.map((n) => [n.short_pick_line_id, n]));
  for (const [lineId, owner] of eligibleFixtures) {
    const n = notified.get(lineId);
    if (!n) fail(`missing notification for ${lineId}`);
    if (n.recipient_user_id !== owner) fail(`notification for ${lineId} went to the wrong recipient`);
    if (n.type !== "RESPONSIBILITY_RETRIEVAL_ASSIGNED") fail(`notification for ${lineId} has wrong type`);
    if (n.dedupe_key !== `legacy-replenishment-backfill:${lineId}`) fail(`notification for ${lineId} has unstable dedupe key`);
    for (const key of ["casePhase", "location", "originalLocation"]) {
      if (n.payload?.[key] == null) fail(`notification for ${lineId} missing payload.${key}`);
    }
    if (!n.case_id || !n.short_pick_line_id) fail(`notification for ${lineId} missing case/line link`);
  }
  if (notified.has(lineNull) || notified.has(lineDisabled)) fail("null-owner legacy lines must not notify");
  if (notifs.length !== eligibleFixtures.length) fail(`notifications = ${notifs.length}, want ${eligibleFixtures.length}`);
  const stagedNamedNotif = notified.get(lineStagedNamed);
  if (stagedNamedNotif?.payload?.location !== "LOC-FALLBACK-1") fail("staged-named notification location did not fall back to original location");
  const dedupeKeys = notifs.map((n) => n.dedupe_key);
  if (new Set(dedupeKeys).size !== dedupeKeys.length) fail("duplicate dedupe keys");
  ok(`${notifs.length} in-app notifications with stable dedupe keys and case/line/phase/location payload`);

  // Device outbox: per-enabled-device rows; disabled devices excluded.
  const outbox = await upgrade`select o.notification_id, s.endpoint, s.user_id from push_outbox o join push_subscriptions s on s.id = o.subscription_id join notifications n on n.id = o.notification_id where n.dedupe_key like 'legacy-replenishment-backfill:%'`;
  const byUser = new Map();
  for (const row of outbox) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.endpoint);
  }
  if (!(byUser.get(U.picker) ?? []).includes("https://example.test/wfcorr-enabled")) fail("enabled picker device missing from outbox");
  if (!(byUser.get(U.checker) ?? []).includes("https://example.test/wfcorr-checker")) fail("enabled checker device missing from outbox");
  if ((byUser.get(U.named) ?? []).length) fail("disabled device was enqueued");
  if (outbox.some((r) => r.endpoint === "https://example.test/wfcorr-named")) fail("disabled endpoint present in outbox");
  const expectOutbox = eligibleFixtures.filter(([, owner]) => owner === U.picker || owner === U.checker).length;
  if (outbox.length !== expectOutbox) fail(`outbox rows = ${outbox.length}, want ${expectOutbox}`);
  ok(`${outbox.length} device outbox rows across enabled devices only; disabled excluded`);

  console.log(`${TAG}: PASS: all 0020/0021 upgrade-path assertions hold`);
} finally {
  if (fresh) await fresh.end({ timeout: 5 });
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (!keep) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${freshDb}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${upgradeDb}"`);
  }
  await admin.end({ timeout: 5 });
  if (!keep) console.log(`${TAG}: ok: dropped own disposable databases`);
}
