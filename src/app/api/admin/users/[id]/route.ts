import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { canManageUser, permissionsAllowedForRole, PERMISSIONS } from "@/domain/permissions";
import { authenticate, changePassword, changePin, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { isPasswordFormat, isPinFormat } from "@/server/security";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("permissions"), permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length) }),
  z.object({ action: z.literal("status"), status: z.enum(["ACTIVE", "DISABLED", "ARCHIVED"]) }),
  z.object({ action: z.literal("resetPin"), pin: z.string().min(1).max(200) }),
  z.object({ action: z.literal("resetPassword"), password: z.string().min(1).max(200) }),
  z.object({ action: z.literal("revokeSessions") }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return jsonError("User not found", 404);
    if (id === auth.user.id) return jsonError("You cannot administer your own account", 403);
    if (!canManageUser(auth.user.role, auth.user.permissions, target.role)) return jsonError("Cannot manage this user's role", 403);
    const input = await parseJson(request, schema);

    if (input.action === "permissions") {
      const permissionName = target.role === "PICKER" ? "EDIT_PICKER_PERMISSIONS" : target.role === "TROUBLESHOOTER" ? "EDIT_TROUBLESHOOTER_PERMISSIONS" : target.role === "ASSISTANT" ? "EDIT_ASSISTANT_PERMISSIONS" : "EDIT_TL_PERMISSIONS";
      if (!hasAuthPermission(auth, permissionName)) return jsonError("Forbidden", 403);
      if (!permissionsAllowedForRole(target.role, input.permissions)) return jsonError("Those permissions cannot be assigned to that role", 400);
      await db.transaction(async (tx) => {
        await tx.update(users).set({ permissions: input.permissions, updatedAt: new Date() }).where(eq(users.id, id));
        await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: id, action: "USER_PERMISSIONS_UPDATED", details: { permissions: input.permissions } });
      });
      return Response.json({ ok: true });
    }

    if (input.action === "status") {
      const required = input.status === "ARCHIVED" || target.status === "ARCHIVED" ? "ARCHIVE_USERS" : "DISABLE_USERS";
      if (!hasAuthPermission(auth, required)) return jsonError("Forbidden", 403);
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(users).set({ status: input.status, disabledAt: input.status === "DISABLED" ? now : null, archivedAt: input.status === "ARCHIVED" ? now : null, updatedAt: now }).where(eq(users.id, id));
        if (input.status !== "ACTIVE") await tx.update(sessions).set({ revokedAt: now, revokedReason: input.status.toLowerCase() }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
        await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: id, action: `USER_${input.status}`, details: {} });
      });
      return Response.json({ ok: true });
    }

    if (input.action === "resetPin" || input.action === "resetPassword") {
      if (!hasAuthPermission(auth, "RESET_USER_PIN")) return jsonError("Forbidden", 403);
      if (input.action === "resetPin") {
        if (!isPinFormat(input.pin)) return jsonError("PIN must contain 6-200 digits", 400);
        await changePin(id, input.pin, auth.user.id);
      } else {
        if (!isPasswordFormat(input.password)) return jsonError("Password must be 8-200 characters", 400);
        await changePassword(id, input.password, auth.user.id, "PASSWORD_RESET");
      }
      return Response.json({ ok: true });
    }

    if (!hasAuthPermission(auth, "REVOKE_USER_SESSIONS")) return jsonError("Forbidden", 403);
    await db.transaction(async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: "administrator_revoked" }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: id, action: "USER_SESSIONS_REVOKED", details: {} });
    });
    return Response.json({ ok: true });
  } catch (error) { return handleRouteError(error); }
}
