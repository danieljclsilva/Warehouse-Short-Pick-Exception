#!/usr/bin/env node
// Disposable upgrade-path proof for drizzle migration 0017 (Wave 1 A1).
// Usage: DATABASE_URL=postgresql://.../disposable_db node scripts/prove-0017-upgrade.mjs [--keep]
// NEVER point at production or shared test data: the script refuses any DB
// whose name does not end in `_test` and refuses restore/fixture databases.
// Steps:
//   1. wipe + migrate through 0016 only (pre-0017 baseline)
//   2. seed users (one with revoked check grants) + configs with cap 1/2/null
//   3. apply migration 0017 alone
//   4. assert every acceptance predicate
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keep = process.argv.includes("--keep");

function fail(message) {
  console.error(`prove-0017-upgrade: FAIL: ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`prove-0017-upgrade: ok: ${message}`);
}

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
const dbName = decodeURIComponent(parsed.pathname.slice(1));
if (!/^[A-Za-z0-9_]+_test$/.test(dbName) || /^(shortpick_restore|shortpick_fixture)_/.test(dbName)) {
  fail(`refusing database name ${JSON.stringify(dbName)} (must end in _test, not restore/fixture)`);
}
if (dbName === "short_pick_test") fail("refusing the shared short_pick_test database; use a disposable *_test database");

const sql = postgres(url, { max: 1 });

async function execFileStatements(path) {
  const text = readFileSync(path, "utf8");
  // Drizzle splits statements on `--> statement-breakpoint`.
  const parts = text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of parts) {
    await sql.unsafe(statement);
  }
}

function migrationFilesThrough(tag) {
  return readdirSync(join(root, "drizzle"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => f <= tag);
}

const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8"));
const entry17 = journal.entries.find((e) => e.tag === "0017_foamy_anita_blake");
if (!entry17) fail("0017_foamy_anita_blake missing from drizzle/meta/_journal.json");

try {
  // 1. Fresh wipe, then migrate through 0016 (pre-0017 baseline).
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  for (const file of migrationFilesThrough("0016_lethal_jimmy_woo.sql")) {
    await execFileStatements(join(root, "drizzle", file));
  }
  ok(`migrated pre-0017 baseline (${migrationFilesThrough("0016_lethal_jimmy_woo.sql").length} files, 0000..0016)`);

  // 0017's DO block requires at least one configuration_versions row; 0010 seeds version 1.
  const versions = await sql`select version, values from configuration_versions order by version`;
  if (!versions.length) fail("no configuration_versions seeded by baseline migrations");
  ok(`baseline has ${versions.length} configuration version(s)`);

  // Confirm the pre-0017 enum lacks FOUND_AT_ORIGINAL.
  const enumLabels = await sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'check_completion_code' order by e.enumsortorder`;
  if (enumLabels.some((r) => r.enumlabel === "FOUND_AT_ORIGINAL")) fail("pre-0017 enum already contains FOUND_AT_ORIGINAL");
  ok("pre-0017 enum lacks FOUND_AT_ORIGINAL");

  // 2. Seed users: one fully revoked of check grants, one partial, one complete.
  await sql`delete from users`;
  const revokedId = crypto.randomUUID();
  const pickerId = crypto.randomUUID();
  const tsId = crypto.randomUUID();
  async function seedUsers() {
    await sql`insert into users (id, identifier, display_name, pin_hash, role, status, permissions) values
      (${revokedId}, 'upgrade-revoked', 'Upgrade Revoked', 'x', 'PICKER', 'ACTIVE', '[]'::jsonb),
      (${pickerId}, 'upgrade-picker', 'Upgrade Picker', 'x', 'TROUBLESHOOTER', 'ACTIVE', '["VIEW_AVAILABLE_CHECKS","CLAIM_CHECK"]'::jsonb),
      (${tsId}, 'upgrade-ts', 'Upgrade TS', 'x', 'TROUBLESHOOTER', 'ACTIVE', '["VIEW_AVAILABLE_CHECKS","CLAIM_CHECK","COMPLETE_CHECK"]'::jsonb)`;
  }
  await seedUsers();
  ok("seeded 3 users (one fully revoked)");

  async function rebaselineWithCap(cap) {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    for (const file of migrationFilesThrough("0016_lethal_jimmy_woo.sql")) {
      await execFileStatements(join(root, "drizzle", file));
    }
    await seedUsers();
    // The baseline seeds version 1; history is immutable, so set the cap by appending a new
    // version row (the same way the app writes configuration), then strip FOUND_AT_ORIGINAL
    // from the newest row via a fresh insert — never UPDATE configuration_versions.
    const [cur] = await sql`select id, version, values from configuration_versions order by version desc limit 1`;
    const nextValues = { ...cur.values, MAX_SIMULTANEOUS_CHECKS_PER_CASE: cap };
    if (Array.isArray(nextValues.ALLOWED_RESOLUTION_CODES)) {
      nextValues.ALLOWED_RESOLUTION_CODES = nextValues.ALLOWED_RESOLUTION_CODES.filter((c) => c !== "FOUND_AT_ORIGINAL");
    }
    const [seeded] = await sql`insert into configuration_versions (version, values) values (${cur.version + 1}, ${sql.json(nextValues)}) returning id, version`;
    await sql`insert into configuration_audits (previous_version_id, new_version_id, changed_values) values (${cur.id}, ${seeded.id}, ${sql.json({ seed: true })})`;
    return seeded.version;
  }

  const results = [];
  for (const cap of [1, 2, 3, 100, null]) {
    const baseVersion = await rebaselineWithCap(cap);
    await execFileStatements(join(root, "drizzle", "0017_foamy_anita_blake.sql"));
    const [cur] = await sql`select version, values from configuration_versions order by version desc limit 1`;
    const parsedValues = typeof cur.values === "string" ? JSON.parse(cur.values) : cur.values;
    const codes = parsedValues.ALLOWED_RESOLUTION_CODES ?? [];
    const capAfter = parsedValues.MAX_SIMULTANEOUS_CHECKS_PER_CASE ?? null;
    const [revoked] = await sql`select permissions from users where id = ${revokedId}`;
    const hasChecks = ["VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK"].every((p) => revoked.permissions.includes(p));
    const audits = await sql`select changed_values from configuration_audits order by changed_at desc limit 1`;
    const logs = await sql`select action, details from audit_log where action = 'CONFIGURATION_ROLL_FORWARD' order by created_at desc limit 1`;
    results.push({ cap, baseVersion, curVersion: cur.version, codes, capAfter, hasChecks, audit: audits[0]?.changed_values ?? null, log: logs[0] ?? null });
  }

  // 3. Assertions per scenario.
  for (const r of results) {
    if (!r.hasChecks) fail(`cap=${r.cap}: revoked user did not regain the 3 check grants`);
    if (!r.codes.includes("FOUND_AT_ORIGINAL")) fail(`cap=${r.cap}: FOUND_AT_ORIGINAL missing from codes`);
  }
  ok("revoked user regains the 3 check grants in every scenario; FOUND_AT_ORIGINAL added");

  const cap1 = results.find((r) => r.cap === 1);
  if (cap1.capAfter !== null) fail(`cap=1 was not rolled to null (got ${JSON.stringify(cap1.capAfter)})`);
  if (cap1.curVersion !== cap1.baseVersion + 1) fail("cap=1 did not create exactly one new configuration version");
  if (!cap1.audit || cap1.audit.MAX_SIMULTANEOUS_CHECKS_PER_CASE?.previous !== 1 || cap1.audit.MAX_SIMULTANEOUS_CHECKS_PER_CASE?.next !== null) {
    fail(`cap=1 audit row missing prior value + reason (got ${JSON.stringify(cap1.audit)})`);
  }
  if (!cap1.audit.MAX_SIMULTANEOUS_CHECKS_PER_CASE?.reason) fail("cap=1 audit row missing reason");
  if (!cap1.log || cap1.log.action !== "CONFIGURATION_ROLL_FORWARD") fail("cap=1 missing CONFIGURATION_ROLL_FORWARD audit_log row");
  ok("cap 1 -> null with audited config version row (prior value + reason)");

  for (const r of results.filter((r) => r.cap !== 1)) {
    if (r.capAfter !== r.cap) fail(`cap=${r.cap} changed unexpectedly to ${JSON.stringify(r.capAfter)}`);
    if (r.audit && r.audit.MAX_SIMULTANEOUS_CHECKS_PER_CASE?.previous === r.cap
      && r.audit.MAX_SIMULTANEOUS_CHECKS_PER_CASE?.next !== r.cap) {
      fail(`cap=${r.cap} audit row rewrote an explicit cap (got ${JSON.stringify(r.audit)})`);
    }
  }
  ok("caps 2, 3, 100 and null preserved (other explicit caps unchanged)");

  // A later explicit revoke sticks (post-migration edit is allowed).
  await sql`update users set permissions = (permissions - 'CLAIM_CHECK') where id = ${revokedId}`;
  const [afterRevoke] = await sql`select permissions from users where id = ${revokedId}`;
  if (afterRevoke.permissions.includes("CLAIM_CHECK")) fail("later explicit revoke did not stick");
  ok("later explicit revoke sticks");

  // Enum gained the value exactly once.
  const enumAfter = await sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'check_completion_code' order by e.enumsortorder`;
  const faoCount = enumAfter.filter((r) => r.enumlabel === "FOUND_AT_ORIGINAL").length;
  if (faoCount !== 1) fail(`FOUND_AT_ORIGINAL enum count = ${faoCount}, want 1`);
  ok("check_completion_code enum contains FOUND_AT_ORIGINAL exactly once");

  console.log("prove-0017-upgrade: PASS: all pre-0017 upgrade-path assertions hold");
} finally {
  if (!keep) {
    // Leave no trace: drop and recreate the disposable database empty.
    await sql.end({ timeout: 5 });
    const admin = postgres(url.replace(new RegExp(`${dbName}$`), "postgres"), { max: 1 });
    await admin`drop database if exists ${admin(dbName)}`;
    await admin`create database ${admin(dbName)}`;
    await admin.end({ timeout: 5 });
    // Re-apply NOTHING: leave the disposable DB empty for the next user.
  } else {
    await sql.end({ timeout: 5 });
  }
}
