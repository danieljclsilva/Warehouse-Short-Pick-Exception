import { describe, expect, it } from "vitest";
import {
  FALLBACK_REGIONS,
  PENDING_STATUSES,
  PRODUCTION_ENV_ID,
  PROJECT_ID,
  REMOVABLE_STATUSES,
  SERVICE_IDS,
  STOPPABLE_STATUSES,
  TEST_ENV_ID,
  assertTestEnv,
  classifyDeployment,
  computeStopSet,
  isParked,
  resolveTargetEnv,
} from "../scripts/railway-test-env-guard.mjs";

describe("railway test-env guard", () => {
  it("defaults an empty override to the test environment, never production", () => {
    expect(resolveTargetEnv("")).toBe(TEST_ENV_ID);
    expect(resolveTargetEnv(undefined)).toBe(TEST_ENV_ID);
    expect(resolveTargetEnv("   ")).toBe(TEST_ENV_ID);
    expect(TEST_ENV_ID).not.toBe(PRODUCTION_ENV_ID);
  });

  it("passes the exact test environment ID", () => {
    expect(assertTestEnv(TEST_ENV_ID)).toEqual({ ok: true, reason: "" });
  });

  it("refuses the production environment ID with an explicit message", () => {
    const result = assertTestEnv(PRODUCTION_ENV_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PRODUCTION/);
    expect(result.reason).toContain(PRODUCTION_ENV_ID);
  });

  it("fails closed on empty or unknown environment IDs", () => {
    for (const bad of ["", "   ", "test", "production", "877f4590", `${TEST_ENV_ID}-x`]) {
      const result = assertTestEnv(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("pins project, service, and fallback-region constants", () => {
    expect(PROJECT_ID).toBe("10168080-e6e5-4e65-a8ec-b92f6cf514e5");
    expect(SERVICE_IDS).toEqual({
      web: "fd533f19-cbed-4023-96e6-463dd299815e",
      db: "c44519a3-f013-4d49-a62b-7ca3bd61c4ff",
      push: "d528d77e-fd99-4cd2-8c58-e9c4680e7587",
    });
    expect(FALLBACK_REGIONS).toEqual({
      web: "sfo",
      db: "sfo",
      push: "europe-west4-drams3a",
    });
  });

  it("classifies deployment statuses into pending/stoppable/unknown lifecycles", () => {
    for (const status of PENDING_STATUSES) {
      expect(classifyDeployment(status), status).toBe("pending");
      expect(classifyDeployment(status.toLowerCase()), status).toBe("pending");
    }
    for (const status of STOPPABLE_STATUSES) {
      expect(classifyDeployment(status), status).toBe("stoppable");
    }
    expect(PENDING_STATUSES).toEqual(
      expect.arrayContaining(["QUEUED", "BUILDING", "DEPLOYING", "NEEDS_APPROVAL"]),
    );
    expect(STOPPABLE_STATUSES).toEqual(
      expect.arrayContaining(["SUCCESS", "FAILED", "CRASHED", "SLEEPING", "SKIPPED"]),
    );
    expect(classifyDeployment("FROBNICATED")).toBe("unknown");
    expect(classifyDeployment("")).toBe("unknown");
    expect(REMOVABLE_STATUSES).toEqual(["QUEUED", "INITIALIZING", "WAITING"]);
  });

  it("parks only on running=0 with no live deployments (configured ignored)", () => {
    const parked = {
      running: 0,
      configured: 1,
      active: [{ id: "a", status: "CRASHED", deploymentStopped: true }],
      pending: [],
      latest: { id: "a", status: "CRASHED", deploymentStopped: true },
    };
    expect(isParked(parked)).toBe(true);
    expect(isParked({ ...parked, running: 1 })).toBe(false);
    expect(
      isParked({
        ...parked,
        active: [{ id: "a", status: "SUCCESS", deploymentStopped: false }],
      }),
    ).toBe(false);
    expect(
      isParked({ ...parked, pending: [{ id: "b", status: "BUILDING" }] }),
    ).toBe(false);
    // Push-shaped: null latest + empty scoped lists + null-derived running 0.
    expect(
      isParked({ running: 0, configured: 0, active: [], pending: [], latest: null }),
    ).toBe(true);
  });

  it("computes stop sets with stop[]/unknown[] (already-stopped excluded)", () => {
    const snapshot = {
      active: [
        { id: "live-success", status: "SUCCESS", deploymentStopped: false },
        { id: "live-queued", status: "QUEUED", deploymentStopped: false },
        { id: "old-stopped", status: "CRASHED", deploymentStopped: true },
      ],
    };
    const plan = computeStopSet(snapshot);
    expect(plan.stop).toEqual(expect.arrayContaining(["live-success", "live-queued"]));
    expect(plan.stop).not.toContain("old-stopped");
    expect(plan.unknown).toEqual([]);
    const refused = computeStopSet({
      active: [{ id: "weird", status: "FROBNICATED", deploymentStopped: false }],
    });
    expect(refused.stop).toEqual([]);
    expect(refused.unknown).toContain("FROBNICATED");
  });
});
