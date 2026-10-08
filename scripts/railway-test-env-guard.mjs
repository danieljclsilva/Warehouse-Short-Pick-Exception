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

// Region names observed live via `railway service list --json` on 2026-10-08.
// Used only as a fallback when the live region list is empty (e.g. everything
// already scaled to zero); the scripts prefer live data.
export const FALLBACK_REGIONS = {
  web: "sfo",
  db: "sfo",
  push: "europe-west4-drams3a",
};

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
