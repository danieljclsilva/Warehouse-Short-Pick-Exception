import { describe, expect, it } from "vitest";
import { canManageRole, canManageUser, defaultPermissions, permissionsAllowedForRole } from "../src/domain/permissions";
import { persistentSessionCookie, SESSION_COOKIE_MAX_AGE_SECONDS } from "../src/server/security";

describe("role and permission hierarchy", () => {
  it("grants check and picker note defaults across role presets", () => {
    for (const role of ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const) {
      const permissions = defaultPermissions(role);
      expect(permissions).toEqual(expect.arrayContaining(["VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK"]));
    }
    expect(defaultPermissions("PICKER")).toEqual(expect.arrayContaining(["ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES"]));
    expect(defaultPermissions("ASSISTANT")).toContain("REPORT_NEW_LOCATION");
    expect(defaultPermissions("TROUBLESHOOTER")).toEqual(expect.arrayContaining(["REPORT_SHORT_PICK", "VIEW_OWN_CASES", "MARK_ORDER_STAGED"]));
    expect(defaultPermissions("ASSISTANT")).toContain("MARK_ORDER_STAGED");
  });
  it("grants every picker default plus replenishment and location reporting to troubleshooters", () => {
    const picker = defaultPermissions("PICKER");
    const troubleshooter = defaultPermissions("TROUBLESHOOTER");
    expect(troubleshooter).toEqual(expect.arrayContaining(picker));
    expect(troubleshooter).toEqual(expect.arrayContaining(["REPORT_NEW_LOCATION", "RECORD_REPLENISHMENT"]));
    for (const permission of ["VIEW_ALL_OPEN_CASES", "VIEW_USERS", "ASSIGN_CHECK", "REOPEN_CASE", "REPAIR_CASE_DATA", "RETRIEVE_FOR_OTHER_PICKER"]) expect(troubleshooter).not.toContain(permission);
  });


  it("enforces grant bounds for override and repair permissions", () => {
    expect(permissionsAllowedForRole("TEAM_LEADER", ["OVERRIDE_CASE_STATE"])).toBe(true);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["REPAIR_CASE_DATA"])).toBe(false);
    expect(permissionsAllowedForRole("PICKER", ["OVERRIDE_CASE_STATE"])).toBe(false);
    expect(permissionsAllowedForRole("ADMIN", ["OVERRIDE_CASE_STATE", "REPAIR_CASE_DATA"])).toBe(true);
  });
  it("limits assistant management to picker and troubleshooter roles", () => {
    expect(canManageRole("ASSISTANT", "PICKER")).toBe(true);
    expect(canManageRole("ASSISTANT", "TROUBLESHOOTER")).toBe(true);
    expect(canManageRole("ASSISTANT", "ASSISTANT")).toBe(false);
    expect(canManageRole("ASSISTANT", "TEAM_LEADER")).toBe(false);
  });

  it("prevents team leaders from editing admins and admin permissions", () => {
    expect(canManageRole("TEAM_LEADER", "ASSISTANT")).toBe(true);
    expect(canManageRole("TEAM_LEADER", "ADMIN")).toBe(false);
    expect(defaultPermissions("TEAM_LEADER")).not.toContain("EDIT_TL_PERMISSIONS");
  });
  it("places Manager above Team Leader and below Admin with Admin-only management", () => {
    expect(canManageRole("ADMIN", "MANAGER")).toBe(true);
    expect(canManageRole("MANAGER", "TEAM_LEADER")).toBe(true);
    expect(canManageRole("MANAGER", "ADMIN")).toBe(false);
    expect(canManageRole("MANAGER", "MANAGER")).toBe(false);
    expect(canManageRole("TEAM_LEADER", "MANAGER")).toBe(false);
    expect(canManageRole("ASSISTANT", "MANAGER")).toBe(false);
    expect(canManageUser("MANAGER", [], "TEAM_LEADER")).toBe(true);
    expect(canManageUser("MANAGER", [], "ADMIN")).toBe(false);
    expect(defaultPermissions("MANAGER")).toContain("EDIT_TL_PERMISSIONS");
    expect(defaultPermissions("MANAGER")).not.toContain("EDIT_MANAGER_PERMISSIONS");
    expect(defaultPermissions("MANAGER")).not.toContain("REPAIR_CASE_DATA");
    expect(permissionsAllowedForRole("MANAGER", ["EDIT_TL_PERMISSIONS"])).toBe(true);
    expect(permissionsAllowedForRole("MANAGER", ["EDIT_MANAGER_PERMISSIONS"])).toBe(false);
    expect(permissionsAllowedForRole("MANAGER", ["REPAIR_CASE_DATA"])).toBe(false);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["EDIT_MANAGER_PERMISSIONS"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["EDIT_MANAGER_PERMISSIONS"])).toBe(false);
  });

  it("requires the matching edit permission for an assistant managing picker permissions", () => {
    expect(canManageUser("ASSISTANT", ["EDIT_PICKER_PERMISSIONS"], "PICKER")).toBe(true);
    expect(canManageUser("ASSISTANT", [], "PICKER")).toBe(false);
  });

  it("keeps management permissions out of Picker and Troubleshooter assignments", () => {
    expect(permissionsAllowedForRole("PICKER", ["REPORT_SHORT_PICK", "CLAIM_CHECK"])).toBe(true);
    expect(permissionsAllowedForRole("PICKER", ["CREATE_INVITES"])).toBe(false);
    expect(permissionsAllowedForRole("TROUBLESHOOTER", ["VIEW_USERS"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["CREATE_INVITES", "EDIT_TL_PERMISSIONS"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["OVERRIDE_DUPLICATE_SHORT_PICK_LINE"])).toBe(false);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["OVERRIDE_DUPLICATE_SHORT_PICK_LINE"])).toBe(true);
    expect(permissionsAllowedForRole("TEAM_LEADER", ["EDIT_TL_PERMISSIONS"])).toBe(false);
  });

  it("sets persistent browser cookies without setting a server session lifetime", () => {
    const cookie = persistentSessionCookie("session-token", 0);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
    expect(cookie).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("Expires=");
    expect(cookie).toContain("HttpOnly");
  });
});
