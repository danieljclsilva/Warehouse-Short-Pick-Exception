import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";

/**
 * Minimal active-user directory for action forms that name another worker
 * (currently the replenishment named retriever). Requires
 * `RECORD_REPLENISHMENT`: anyone who may record replenishment may see the
 * names they can assign it to. Returns id/displayName/role only — never
 * credentials, sessions, or contact details.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "RECORD_REPLENISHMENT")) return jsonError("Forbidden", 403);
    const rows = await getDb()
      .select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users)
      .where(eq(users.status, "ACTIVE"))
      .orderBy(asc(users.displayName))
      .limit(500);
    return Response.json({ users: rows }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
