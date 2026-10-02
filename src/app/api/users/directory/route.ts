import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams, paginationMeta, paginationOffset } from "@/server/pagination";

/**
 * Minimal active-user directory (Admin/Manager excluded). Currently unused:
 * replenishment is state-only with no assignment. Kept for a future
 * assignment affordance; requires `RECORD_REPLENISHMENT`. Returns
 * id/displayName/role only — never credentials, sessions, or contact
 * details.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "RECORD_REPLENISHMENT")) return jsonError("Forbidden", 403);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    const scope = and(eq(users.status, "ACTIVE"), notInArray(users.role, ["ADMIN", "MANAGER"]));
    const db = getDb();
    const [[countRow], rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(users).where(scope),
      db.select({ id: users.id, displayName: users.displayName, role: users.role })
        .from(users)
        .where(scope)
        .orderBy(asc(users.displayName), asc(users.id))
        .limit(pageSize).offset(paginationOffset(page, pageSize)),
    ]);
    const total = countRow?.count ?? 0;
    return Response.json({ users: rows, ...paginationMeta(total, page, pageSize) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
