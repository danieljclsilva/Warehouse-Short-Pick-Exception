import { ROLES, type Role } from "./permissions";

/** Reporting staff only; administrative/manual reports are outside this signal. */
export const SAME_LOCATION_REPORTER_ROLES: readonly Role[] = ROLES.filter((role) => role !== "ADMIN" && role !== "MANAGER");
export function isSameLocationReporter(role: string): boolean {
  return SAME_LOCATION_REPORTER_ROLES.some((allowed) => allowed === role);
}
