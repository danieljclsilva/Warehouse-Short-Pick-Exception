export const ROLES = ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "REPORT_SHORT_PICK", "VIEW_OWN_CASES", "VIEW_ALL_OPEN_CASES", "VIEW_AVAILABLE_CHECKS",
  "CLAIM_CHECK", "COMPLETE_CHECK", "RETRIEVE_FOR_OTHER_PICKER", "ASSIGN_CHECK", "REASSIGN_CHECK",
  "ASSIGN_TROUBLESHOOTER", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES", "REPORT_NEW_LOCATION",
  "CONFIRM_RETRIEVAL", "MARK_ORDER_STAGED", "RESOLVE_CASE", "REOPEN_CASE", "CREATE_CASE_ON_BEHALF", "OVERRIDE_DUPLICATE_SHORT_PICK_LINE",
  "CREATE_INVITES", "VIEW_ANALYTICS", "EXPORT_ANALYTICS", "VIEW_USERS", "EDIT_PICKER_PERMISSIONS",
  "EDIT_TROUBLESHOOTER_PERMISSIONS", "EDIT_ASSISTANT_PERMISSIONS", "EDIT_TL_PERMISSIONS",
  "MANAGE_CONFIGURATION", "MANAGE_TRANSLATIONS", "APPROVE_PROFILE_PHOTO", "ARCHIVE_USERS",
  "DISABLE_USERS", "RESET_USER_PIN", "REVOKE_USER_SESSIONS",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const presets: Record<Role, readonly Permission[]> = {
  PICKER: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES", "MARK_ORDER_STAGED", "CONFIRM_RETRIEVAL", "RESOLVE_CASE"],
  TROUBLESHOOTER: ["VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES", "REPORT_NEW_LOCATION", "CONFIRM_RETRIEVAL", "RESOLVE_CASE"],
  ASSISTANT: ["VIEW_ALL_OPEN_CASES", "ASSIGN_CHECK", "REASSIGN_CHECK", "ASSIGN_TROUBLESHOOTER", "CREATE_CASE_ON_BEHALF", "RESOLVE_CASE", "REOPEN_CASE", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES", "CREATE_INVITES", "VIEW_ANALYTICS", "VIEW_USERS", "EDIT_PICKER_PERMISSIONS", "EDIT_TROUBLESHOOTER_PERMISSIONS", "DISABLE_USERS", "RESET_USER_PIN", "REVOKE_USER_SESSIONS"],
  TEAM_LEADER: PERMISSIONS.filter((p) => p !== "EDIT_TL_PERMISSIONS"),
  ADMIN: PERMISSIONS,
};

// Team Leaders can manage every non-admin role and user account. Admin permissions remain reserved.
presets.TEAM_LEADER = PERMISSIONS.filter((p) => p !== "EDIT_TL_PERMISSIONS");

export function defaultPermissions(role: Role): Permission[] {
  return [...presets[role]];
}

const userAdministrationPermissions = new Set<Permission>([
  "CREATE_INVITES", "VIEW_ANALYTICS", "EXPORT_ANALYTICS", "VIEW_USERS",
  "EDIT_PICKER_PERMISSIONS", "EDIT_TROUBLESHOOTER_PERMISSIONS", "EDIT_ASSISTANT_PERMISSIONS", "EDIT_TL_PERMISSIONS",
  "MANAGE_CONFIGURATION", "MANAGE_TRANSLATIONS", "APPROVE_PROFILE_PHOTO", "ARCHIVE_USERS", "DISABLE_USERS",
  "RESET_USER_PIN", "REVOKE_USER_SESSIONS", "OVERRIDE_DUPLICATE_SHORT_PICK_LINE",
]);

/** Permissions a user role may receive through an invite or another user's admin edit. */
export function permissionsAllowedForRole(role: Role, permissions: readonly string[]): boolean {
  const allKnown = permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission));
  if (!allKnown) return false;
  if (role === "ADMIN") return permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission));
  if (role === "TEAM_LEADER") return permissions.every((permission) => permission !== "EDIT_TL_PERMISSIONS");
  if (role === "ASSISTANT") return permissions.every((permission) => permission !== "EDIT_ASSISTANT_PERMISSIONS" && permission !== "EDIT_TL_PERMISSIONS" && permission !== "OVERRIDE_DUPLICATE_SHORT_PICK_LINE");
  return permissions.every((permission) =>
    (PERMISSIONS as readonly string[]).includes(permission) && !userAdministrationPermissions.has(permission as Permission),
  );
}

const permissionForRole: Partial<Record<Role, Permission>> = {
  PICKER: "EDIT_PICKER_PERMISSIONS",
  TROUBLESHOOTER: "EDIT_TROUBLESHOOTER_PERMISSIONS",
  ASSISTANT: "EDIT_ASSISTANT_PERMISSIONS",
  TEAM_LEADER: "EDIT_TL_PERMISSIONS",
};

export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "ADMIN") return true;
  if (targetRole === "ADMIN" || targetRole === "TEAM_LEADER") return false;
  if (actorRole === "TEAM_LEADER") return true;
  if (actorRole === "ASSISTANT") return targetRole === "PICKER" || targetRole === "TROUBLESHOOTER";
  return false;
}

export function canManageUser(actorRole: Role, actorPermissions: readonly string[], targetRole: Role): boolean {
  if (!canManageRole(actorRole, targetRole)) return false;
  if (actorRole === "ADMIN" || actorRole === "TEAM_LEADER") return true;
  const needed = permissionForRole[targetRole];
  return needed !== undefined && actorPermissions.includes(needed);
}

export function hasPermission(permissions: readonly string[], required: Permission): boolean {
  return permissions.includes(required);
}
