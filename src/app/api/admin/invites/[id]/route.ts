import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, invites } from "@/db/schema";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { canManageRole } from "@/domain/permissions";
import { handleRouteError, jsonError } from "@/server/http";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "CREATE_INVITES")) return jsonError("Forbidden", 403);
    const { id } = await context.params;
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx.select().from(invites).where(and(eq(invites.id, id), isNull(invites.revokedAt))).for("update").limit(1);
      if (!invite) return "not_found" as const;
      if ((invite.defaultRole === "ADMIN" || invite.defaultRole === "MANAGER") && auth.user.role !== "ADMIN") return "forbidden" as const;
      if (invite.createdBy !== auth.user.id && !canManageRole(auth.user.role, invite.defaultRole)) return "forbidden" as const;
      await tx.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, id));
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "INVITE_REVOKED", details: { inviteId: id } });
      return "revoked" as const;
    });
    if (result === "forbidden") return jsonError("Cannot revoke an invitation for that role", 403);
    if (result === "not_found") return jsonError("Invitation not found or already revoked", 404);
    return Response.json({ ok: true });
  } catch (error) { return handleRouteError(error); }
}
