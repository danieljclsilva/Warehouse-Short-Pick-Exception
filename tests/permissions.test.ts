import { describe, expect, it } from "vitest";
import { canManageRole, canManageUser, defaultPermissions, permissionsAllowedForRole } from "../src/domain/permissions";
import { persistentSessionCookie, SESSION_COOKIE_MAX_AGE_SECONDS } from "../src/server/security";

describe("role and permission hierarchy", () => {
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

  it("requires the matching edit permission for an assistant managing picker permissions", () => {
    expect(canManageUser("ASSISTANT", ["EDIT_PICKER_PERMISSIONS"], "PICKER")).toBe(true);
    expect(canManageUser("ASSISTANT", [], "PICKER")).toBe(false);
  });

  it("keeps management permissions out of Picker and Troubleshooter assignments", () => {
    expect(permissionsAllowedForRole("PICKER", ["REPORT_SHORT_PICK", "CLAIM_CHECK"])).toBe(true);
    expect(permissionsAllowedForRole("PICKER", ["CREATE_INVITES"])).toBe(false);
    expect(permissionsAllowedForRole("TROUBLESHOOTER", ["VIEW_USERS"])).toBe(false);
    expect(permissionsAllowedForRole("ASSISTANT", ["CREATE_INVITES", "EDIT_TL_PERMISSIONS"])).toBe(false);
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
