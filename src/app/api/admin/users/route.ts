import { and, asc, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission, toPublicUser } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams, paginationMeta, paginationOffset } from "@/server/pagination";

function shape(row: typeof users.$inferSelect) {
  return { ...toPublicUser(row), status: row.status,
    profilePhotoStatus: row.profilePhotoStatus,
    photoUrl: row.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${row.id}` : null };
}

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "VIEW_USERS")) return jsonError("Forbidden", 403);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    const db = getDb();
    const offset = paginationOffset(page, pageSize);
    // Admin and Manager accounts are hidden from pickers, team leaders, assistants, and
    // troubleshooters. Managers see fellow Managers but never Admins; only Admin sees both.
    // Archived accounts stay visible to admins only. History joins (cases, events,
    // analytics) still resolve their display names; this list is the only surface filtered.
    if (auth.user.role === "MANAGER") {
      const scope = and(ne(users.status, "ARCHIVED"), notInArray(users.role, ["ADMIN"]));
      const [[countRow], rows] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users).where(scope),
        db.select().from(users).where(scope).orderBy(asc(users.displayName), asc(users.id))
          .limit(pageSize).offset(offset),
      ]);
      const total = countRow?.count ?? 0;
      return Response.json({ users: rows.map(shape), ...paginationMeta(total, page, pageSize) }, { headers: { "cache-control": "private, no-store" } });
    }
    if (auth.user.role !== "ADMIN") {
      const scope = and(ne(users.status, "ARCHIVED"), notInArray(users.role, ["ADMIN", "MANAGER"]));
      const [[countRow], rows] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users).where(scope),
        db.select().from(users).where(scope).orderBy(asc(users.displayName), asc(users.id))
          .limit(pageSize).offset(offset),
      ]);
      const total = countRow?.count ?? 0;
      return Response.json({ users: rows.map(shape), ...paginationMeta(total, page, pageSize) }, { headers: { "cache-control": "private, no-store" } });
    }
    const [[countRow], rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select().from(users).orderBy(asc(users.displayName), asc(users.id)).limit(pageSize).offset(offset),
    ]);
    const total = countRow?.count ?? 0;
    return Response.json({ users: rows.map(shape), ...paginationMeta(total, page, pageSize) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
