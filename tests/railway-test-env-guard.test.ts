import { describe, expect, it } from "vitest";
import {
  FALLBACK_REGIONS,
  PRODUCTION_ENV_ID,
  PROJECT_ID,
  SERVICE_IDS,
  TEST_ENV_ID,
  assertTestEnv,
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
});
