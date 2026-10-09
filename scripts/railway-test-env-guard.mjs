// railway-test-env-guard.mjs — single source of truth for the Railway
// on-demand test-environment scripts (scripts/railway-test-env.sh).
//
// Pure guard logic: no Railway calls, no side effects, no secrets. The shell
// scripts delegate every environment decision to this module so the
// production guard cannot drift between copies.
//
// IDs (pinned 2026-10-08; project/test/prod envs + the three test services):
export const PROJECT_ID = "10168080-e6e5-4e65-a8ec-b92f6cf514e5";
export const TEST_ENV_ID = "877f4590-5eb0-4aed-b811-d7d234195169";
export const PRODUCTION_ENV_ID = "eb369535-cde7-445d-90f3-baeab196e88c";

export const SERVICE_IDS = {
  web: "fd533f19-cbed-4023-96e6-463dd299815e",
  db: "c44519a3-f013-4d49-a62b-7ca3bd61c4ff",
  push: "d528d77e-fd99-4cd2-8c58-e9c4680e7587",
};

// Region names observed live via service listing on 2026-10-08.
// Retained only for `--print region:*` compatibility (tests pin them); the
// scripts no longer adjust replicas by region and prefer live API data.
export const FALLBACK_REGIONS = {
  web: "sfo",
  db: "sfo",
  push: "europe-west4-drams3a",
};

// Native deployment-stop lifecycle (2026-10-09): replica-count commands are
// deleted after the witnessed zero-replica failure. Stop/start work on
// deployments: active non-stopped terminal-ish deployments are stopped,
// pending ones are stopped (removal only for stubborn
// QUEUED/INITIALIZING/WAITING singles).
export const PENDING_STATUSES = Object.freeze([
  "QUEUED",
  "INITIALIZING",
  "WAITING",
  "BUILDING",
  "DEPLOYING",
  "NEEDS_APPROVAL",
]);

// Active, non-stopped, non-pending statuses that deploymentStop can park.
export const STOPPABLE_STATUSES = Object.freeze([
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "SLEEPING",
  "SKIPPED",
]);

// Deployments so early they never started work; the only statuses eligible
// for deploymentRemove, and only after deploymentStop was attempted first.
export const REMOVABLE_STATUSES = Object.freeze([
  "QUEUED",
  "INITIALIZING",
  "WAITING",
]);

// Classify a deployment status for the stop planner. Returns
// "pending" | "stoppable" | "unknown". Unknown statuses are refused
// (fail closed) — the scripts never act on a status they do not know.
export function classifyDeployment(status) {
  const value = String(status ?? "").trim().toUpperCase();
  if (PENDING_STATUSES.includes(value)) return "pending";
  if (STOPPABLE_STATUSES.includes(value)) return "stoppable";
  return "unknown";
}

// Parked per the native state schema: running==0 AND no active non-stopped
// AND no pending. Configured replica counts are ignored (replica-command
// residue). A null latest counts as parked only when the scoped lists also
// confirm empty (active empty + pending empty + running 0).
export function isParked(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!Number.isInteger(snapshot.running) || snapshot.running !== 0)
    return false;
  const active = Array.isArray(snapshot.active) ? snapshot.active : null;
  const pending = Array.isArray(snapshot.pending) ? snapshot.pending : null;
  if (active === null || pending === null) return false;
  if (active.some((d) => d && (d.deploymentStopped !== true || classifyDeployment(d.status) === "pending"))) return false;
  if (pending.length > 0) return false;
  return true;
}

// Compute the stop set for one service snapshot: every active non-stopped
// deployment whose status classifies as pending or stoppable. Pending
// deployments remain in the stop set even when marked stopped, because a
// build landing can clear the flag and restart the service. Returns
// { stop: [ids], unknown: [statuses] }. Removal candidates are a subset of
// stop (REMOVABLE_STATUSES) and are only removed after a stop round leaves
// them still active — the caller enforces that ordering, not this helper.
export function computeStopSet(snapshot) {
  const stop = [];
  const unknown = [];
  const active = (snapshot && Array.isArray(snapshot.active)
    ? snapshot.active
    : []
  ).filter((d) => d && d.id && (d.deploymentStopped !== true || classifyDeployment(d.status) === "pending"));
  for (const dep of active) {
    const kind = classifyDeployment(dep.status);
    if (kind === "pending" || kind === "stoppable") stop.push(dep.id);
    else if (!unknown.includes(String(dep.status))) unknown.push(String(dep.status));
  }
  return { stop, unknown };
}

// Resolve the requested environment to an effective target. Empty input
// means "default", which is always the test environment — production is never
// a default, and can never be reached by omitting a flag.
export function resolveTargetEnv(input) {
  const value = String(input ?? "").trim();
  return value === "" ? TEST_ENV_ID : value;
}

// Fail-closed gate: only the exact test environment ID passes. Production
// gets its own explicit refusal message; anything else (typos, other envs)
// is refused as unknown. Comparison is exact — no prefix/substring matching.
export function assertTestEnv(envId) {
  const value = String(envId ?? "").trim();
  if (value === "") {
    return {
      ok: false,
      reason:
        "empty environment ID: refusing to act (fail closed). " +
        "Pass the test environment ID explicitly or leave it defaulted.",
    };
  }
  if (value.toLowerCase() === PRODUCTION_ENV_ID.toLowerCase()) {
    return {
      ok: false,
      reason:
        `REFUSING: target environment ${value} is PRODUCTION ` +
        `(${PRODUCTION_ENV_ID}). These scripts only ever manage the test ` +
        `environment ${TEST_ENV_ID}.`,
    };
  }
  if (value !== TEST_ENV_ID) {
    return {
      ok: false,
      reason:
        `REFUSING: target environment ${value} is not the test environment ` +
        `${TEST_ENV_ID}. Unknown environments are treated as unsafe (fail closed).`,
    };
  }
  return { ok: true, reason: "" };
}

const PRINTABLE = {
  project: PROJECT_ID,
  "test-env": TEST_ENV_ID,
  "production-env": PRODUCTION_ENV_ID,
  "service:web": SERVICE_IDS.web,
  "service:db": SERVICE_IDS.db,
  "service:push": SERVICE_IDS.push,
  "region:web": FALLBACK_REGIONS.web,
  "region:db": FALLBACK_REGIONS.db,
  "region:push": FALLBACK_REGIONS.push,
};

function usage() {
  console.error(
    "usage: node railway-test-env-guard.mjs --assert-env <env-id>\n" +
      "       node railway-test-env-guard.mjs --print <key>",
  );
}

// CLI entrypoint for shell scripts. Only runs when executed directly, never
// on import (so vitest can import the pure functions above).
import { pathToFileURL } from "node:url";

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [flag, value] = process.argv.slice(2);
  if (flag === "--assert-env") {
    const target = resolveTargetEnv(value);
    const result = assertTestEnv(target);
    if (!result.ok) {
      console.error(`railway-test-env: ${result.reason}`);
      process.exit(1);
    }
    console.log(target);
  } else if (flag === "--print") {
    if (value == null || !(value in PRINTABLE)) {
      console.error(`railway-test-env: unknown print key ${JSON.stringify(value ?? "")}`);
      usage();
      process.exit(2);
    }
    console.log(PRINTABLE[value]);
  } else {
    usage();
    process.exit(2);
  }
}
