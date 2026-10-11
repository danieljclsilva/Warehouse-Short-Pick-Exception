export const ROLES = ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "REPORT_SHORT_PICK", "VIEW_OWN_CASES", "VIEW_ALL_OPEN_CASES", "VIEW_AVAILABLE_CHECKS",
  "CLAIM_CHECK", "COMPLETE_CHECK", "RETRIEVE_FOR_OTHER_PICKER", "ASSIGN_CHECK", "REASSIGN_CHECK",
  "ASSIGN_TROUBLESHOOTER", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES", "REPORT_NEW_LOCATION",
  "CONFIRM_RETRIEVAL", "MARK_ORDER_STAGED", "RESOLVE_CASE", "REOPEN_CASE", "CREATE_CASE_ON_BEHALF", "OVERRIDE_DUPLICATE_SHORT_PICK_LINE",
  "OVERRIDE_CASE_STATE", "RECORD_REPLENISHMENT", "REPAIR_CASE_DATA",
  "CREATE_INVITES", "VIEW_ANALYTICS", "EXPORT_ANALYTICS", "VIEW_USERS", "EDIT_PICKER_PERMISSIONS",
  "EDIT_TROUBLESHOOTER_PERMISSIONS", "EDIT_ASSISTANT_PERMISSIONS", "EDIT_TL_PERMISSIONS", "EDIT_MANAGER_PERMISSIONS",
  "MANAGE_CONFIGURATION", "MANAGE_TRANSLATIONS", "APPROVE_PROFILE_PHOTO", "ARCHIVE_USERS",
  "DISABLE_USERS", "RESET_USER_PIN", "REVOKE_USER_SESSIONS",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const presets: Record<Role, readonly Permission[]> = {
  PICKER: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES", "MARK_ORDER_STAGED", "CONFIRM_RETRIEVAL", "RESOLVE_CASE",
    "VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES"],
  TROUBLESHOOTER: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES", "MARK_ORDER_STAGED", "VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES",
    "REPORT_NEW_LOCATION", "CONFIRM_RETRIEVAL", "RESOLVE_CASE", "RECORD_REPLENISHMENT"],
  ASSISTANT: ["VIEW_ALL_OPEN_CASES", "ASSIGN_CHECK", "REASSIGN_CHECK", "ASSIGN_TROUBLESHOOTER", "CREATE_CASE_ON_BEHALF",
    "RESOLVE_CASE", "REOPEN_CASE", "MARK_ORDER_STAGED", "ADD_CASE_MESSAGE", "VIEW_CASE_MESSAGES", "CREATE_INVITES", "VIEW_ANALYTICS",
    "VIEW_USERS", "EDIT_PICKER_PERMISSIONS", "EDIT_TROUBLESHOOTER_PERMISSIONS", "DISABLE_USERS", "RESET_USER_PIN",
    "REVOKE_USER_SESSIONS", "VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK",
    "REPORT_NEW_LOCATION", "RECORD_REPLENISHMENT"],
  // Team Leaders manage every role below Manager; Manager accounts are Admin-created and Admin-managed.
  // OVERRIDE_CASE_STATE is Admin-only by default (grantable to Team Leader or Manager); REPAIR_CASE_DATA is Admin-only.
  TEAM_LEADER: PERMISSIONS.filter((p) => p !== "EDIT_TL_PERMISSIONS" && p !== "EDIT_MANAGER_PERMISSIONS" && p !== "OVERRIDE_CASE_STATE" && p !== "REPAIR_CASE_DATA"),
  // Managers sit above Team Leader and below Admin: everything a Team Leader holds plus EDIT_TL_PERMISSIONS.
  // EDIT_MANAGER_PERMISSIONS stays Admin-only so Managers cannot edit Manager or Admin accounts.
  MANAGER: PERMISSIONS.filter((p) => p !== "EDIT_MANAGER_PERMISSIONS" && p !== "OVERRIDE_CASE_STATE" && p !== "REPAIR_CASE_DATA"),
  ADMIN: PERMISSIONS,
};
export function defaultPermissions(role: Role): Permission[] {
  return [...presets[role]];
}
const userAdministrationPermissions = new Set<Permission>([
  "CREATE_INVITES", "VIEW_ANALYTICS", "EXPORT_ANALYTICS", "VIEW_USERS",
  "EDIT_PICKER_PERMISSIONS", "EDIT_TROUBLESHOOTER_PERMISSIONS", "EDIT_ASSISTANT_PERMISSIONS", "EDIT_TL_PERMISSIONS", "EDIT_MANAGER_PERMISSIONS",
  "MANAGE_CONFIGURATION", "MANAGE_TRANSLATIONS", "APPROVE_PROFILE_PHOTO", "ARCHIVE_USERS", "DISABLE_USERS",
  "RESET_USER_PIN", "REVOKE_USER_SESSIONS", "OVERRIDE_DUPLICATE_SHORT_PICK_LINE",
  "OVERRIDE_CASE_STATE", "REPAIR_CASE_DATA",
]);

/** Permissions a user role may receive through an invite or another user's admin edit. */
export function permissionsAllowedForRole(role: Role, permissions: readonly string[]): boolean {
  const allKnown = permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission));
  if (!allKnown) return false;
  if (role === "ADMIN") return permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission));
  if (role === "MANAGER") return permissions.every((permission) => permission !== "EDIT_MANAGER_PERMISSIONS" && permission !== "REPAIR_CASE_DATA");
  if (role === "TEAM_LEADER") return permissions.every((permission) => permission !== "EDIT_TL_PERMISSIONS" && permission !== "EDIT_MANAGER_PERMISSIONS" && permission !== "REPAIR_CASE_DATA");
  if (role === "ASSISTANT") return permissions.every((permission) => permission !== "EDIT_ASSISTANT_PERMISSIONS" && permission !== "EDIT_TL_PERMISSIONS" && permission !== "EDIT_MANAGER_PERMISSIONS" && permission !== "OVERRIDE_DUPLICATE_SHORT_PICK_LINE" && permission !== "OVERRIDE_CASE_STATE" && permission !== "REPAIR_CASE_DATA");
  return permissions.every((permission) =>
    (PERMISSIONS as readonly string[]).includes(permission) && !userAdministrationPermissions.has(permission as Permission),
  );
}

const permissionForRole: Partial<Record<Role, Permission>> = {
  PICKER: "EDIT_PICKER_PERMISSIONS",
  TROUBLESHOOTER: "EDIT_TROUBLESHOOTER_PERMISSIONS",
  ASSISTANT: "EDIT_ASSISTANT_PERMISSIONS",
  TEAM_LEADER: "EDIT_TL_PERMISSIONS",
  MANAGER: "EDIT_MANAGER_PERMISSIONS",
};
/**
 * Role management hierarchy: ADMIN > MANAGER > TEAM_LEADER > ASSISTANT > picker/troubleshooter.
 * Only Admin can create or manage Manager accounts; Managers cannot touch Admin accounts in any way.
 */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "ADMIN") return true;
  if (targetRole === "ADMIN" || targetRole === "MANAGER") return false;
  if (actorRole === "MANAGER") return true;
  if (actorRole === "TEAM_LEADER") return true;
  if (actorRole === "ASSISTANT") return targetRole === "PICKER" || targetRole === "TROUBLESHOOTER";
  return false;
}

export function canManageUser(actorRole: Role, actorPermissions: readonly string[], targetRole: Role): boolean {
  if (!canManageRole(actorRole, targetRole)) return false;
  if (actorRole === "ADMIN" || actorRole === "MANAGER" || actorRole === "TEAM_LEADER") return true;
  const needed = permissionForRole[targetRole];
  return needed !== undefined && actorPermissions.includes(needed);
}

export function hasPermission(permissions: readonly string[], required: Permission): boolean {
  return permissions.includes(required);
}

/**
 * Whether the account holds elevated access (manager/admin roles or any user-administration
 * permission). Used to recommend a password over a PIN for these accounts.
 */
export function hasHighPrivilegeAccess(role: Role, permissions: readonly string[]): boolean {
  if (role === "ADMIN" || role === "MANAGER" || role === "TEAM_LEADER") return true;
  return permissions.some((permission) => userAdministrationPermissions.has(permission as Permission));
}
