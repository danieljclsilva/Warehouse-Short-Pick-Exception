import { describe, expect, it } from "vitest";
import { defaultPermissions, permissionsAllowedForRole } from "../../src/domain/permissions";

describe("Integration slice: new-permission grant and revoke bounds", () => {
  it("keeps repair Admin-only while override is grantable to Team Leader", () => {
    expect(permissionsAllowedForRole("ADMIN", ["REPAIR_CASE_DATA", "OVERRIDE_CASE_STATE"])).toBe(true);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["OVERRIDE_CASE_STATE"])).toBe(true);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["REPAIR_CASE_DATA"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["OVERRIDE_CASE_STATE"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["REPAIR_CASE_DATA"])).toBe(false);
    expect(permissionsAllowedForRole("PICKER", ["OVERRIDE_CASE_STATE"])).toBe(false);
    expect(permissionsAllowedForRole("PICKER", ["REPAIR_CASE_DATA"])).toBe(false);
    expect(permissionsAllowedForRole("TROUBLESHOOTER", ["OVERRIDE_CASE_STATE"])).toBe(false);
    expect(permissionsAllowedForRole("TROUBLESHOOTER", ["REPAIR_CASE_DATA"])).toBe(false);
  });

  it("grants replenishment and ad hoc location to every role including Picker", () => {
    for (const role of ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const) {
      expect(permissionsAllowedForRole(role, ["RECORD_REPLENISHMENT", "REPORT_NEW_LOCATION"])).toBe(true);
    }
  });

  it("matches the shipped role presets: picker and troubleshooter never record replenishment", () => {
    expect(defaultPermissions("PICKER")).not.toContain("RECORD_REPLENISHMENT");
    expect(defaultPermissions("PICKER")).not.toContain("REPORT_NEW_LOCATION");
    expect(defaultPermissions("PICKER")).not.toContain("OVERRIDE_CASE_STATE");
    expect(defaultPermissions("PICKER")).not.toContain("REPAIR_CASE_DATA");
    expect(defaultPermissions("TROUBLESHOOTER")).not.toContain("RECORD_REPLENISHMENT");
    for (const role of ["ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const) {
      expect(defaultPermissions(role)).toContain("RECORD_REPLENISHMENT");
    }
    for (const role of ["TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const) {
      expect(defaultPermissions(role)).toContain("REPORT_NEW_LOCATION");
    }
    expect(defaultPermissions("TEAM_LEADER")).not.toContain("OVERRIDE_CASE_STATE");
    expect(defaultPermissions("TEAM_LEADER")).not.toContain("REPAIR_CASE_DATA");
    expect(defaultPermissions("ADMIN")).toContain("OVERRIDE_CASE_STATE");
    expect(defaultPermissions("ADMIN")).toContain("REPAIR_CASE_DATA");
  });

  it("rejects unknown permissions for every role", () => {
    for (const role of ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const) {
      expect(permissionsAllowedForRole(role, ["NOT_A_PERMISSION"])).toBe(false);
    }
  });
});
