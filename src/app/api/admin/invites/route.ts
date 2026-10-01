import { and, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, invites } from "@/db/schema";
import { canManageRole, defaultPermissions as rolePermissions, permissionsAllowedForRole, PERMISSIONS, ROLES } from "@/domain/permissions";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { createToken, digestToken } from "@/server/security";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { getCurrentConfiguration } from "@/server/configuration";

const schema = z.object({
  defaultRole: z.enum(ROLES).default("PICKER"),
  defaultPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
  expiresInHours: z.number().int().min(1).max(720).optional(),
  maxRegistrations: z.number().int().min(1).max(1000).optional(),
});

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return jsonError("Unauthenticated", 401);
  if (!hasAuthPermission(auth, "CREATE_INVITES")) return jsonError("Forbidden", 403);
  const query = getDb().select({ id: invites.id, expiresAt: invites.expiresAt, maxRegistrations: invites.maxRegistrations, registrationsUsed: invites.registrationsUsed, defaultRole: invites.defaultRole, createdBy: invites.createdBy, createdAt: invites.createdAt, revokedAt: invites.revokedAt }).from(invites);
  // Manager (and Admin) invitations are hidden from pickers, team leaders, assistants, and
  // troubleshooters; only Admin sees them. canManageRole already blocks non-Admin creation.
  const roleScope = auth.user.role === "ADMIN" ? undefined : notInArray(invites.defaultRole, ["ADMIN", "MANAGER"]);
  const assistantScope = auth.user.role === "ASSISTANT"
    ? or(eq(invites.createdBy, auth.user.id), inArray(invites.defaultRole, ["PICKER", "TROUBLESHOOTER"]))
    : undefined;
  const scope = roleScope && assistantScope ? and(roleScope, assistantScope) : roleScope ?? assistantScope;
  const rows = await (scope ? query.where(scope) : query).orderBy(desc(invites.createdAt)).limit(100);
  return Response.json({ invites: rows });
}

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "CREATE_INVITES")) return jsonError("Forbidden", 403);
    const input = await parseJson(request, schema);
    // Admin invitations are never issued via invites; Manager invitations are Admin-only via canManageRole.
    if (input.defaultRole === "ADMIN" || !canManageRole(auth.user.role, input.defaultRole)) return jsonError("Cannot create an invitation for that role", 403);
    const defaultPermissions = input.defaultPermissions ?? rolePermissions(input.defaultRole);
    if (!permissionsAllowedForRole(input.defaultRole, defaultPermissions)) return jsonError("Those permissions cannot be assigned to that role", 400);
    const token = createToken();
    const db = getDb();
    const created = await db.transaction(async (tx) => {
      const configuration = await getCurrentConfiguration(tx);
      const expiresInHours = input.expiresInHours ?? configuration.values.INVITE_DEFAULT_EXPIRY_HOURS;
      const maxRegistrations = input.maxRegistrations ?? configuration.values.INVITE_DEFAULT_MAX_REGISTRATIONS;
      const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);
      const result = await tx.insert(invites).values({ tokenHash: digestToken(token), expiresAt, maxRegistrations, defaultRole: input.defaultRole, defaultPermissions: defaultPermissions ?? [], createdBy: auth.user.id }).returning({ id: invites.id });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "INVITE_CREATED", details: { inviteId: result[0]!.id, role: input.defaultRole, expiresAt: expiresAt.toISOString(), maxRegistrations } });
      return { result, expiresAt, maxRegistrations };
    });
    return Response.json({ invite: { id: created.result[0]!.id, token, registrationUrl: `/register?invite=${encodeURIComponent(token)}`, expiresAt: created.expiresAt, maxRegistrations: created.maxRegistrations, defaultRole: input.defaultRole, registrationsUsed: 0 } }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
