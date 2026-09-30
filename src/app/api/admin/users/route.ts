import { and, asc, ne, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission, toPublicUser } from "@/server/auth";
import { jsonError } from "@/server/http";

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return jsonError("Unauthenticated", 401);
  if (!hasAuthPermission(auth, "VIEW_USERS")) return jsonError("Forbidden", 403);
  // Admin and Manager accounts are hidden from pickers, team leaders, assistants, and
  // troubleshooters. Managers see fellow Managers but never Admins; only Admin sees both.
  if (auth.user.role === "MANAGER") {
    const rows = await getDb().select().from(users)
      .where(and(ne(users.status, "ARCHIVED"), notInArray(users.role, ["ADMIN"])))
      .orderBy(asc(users.displayName)).limit(500);
    return Response.json({ users: rows.map((row) => ({ ...toPublicUser(row), status: row.status,
      profilePhotoStatus: row.profilePhotoStatus,
      photoUrl: row.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${row.id}` : null })) }, { headers: { "cache-control": "private, no-store" } });
  }
  if (auth.user.role !== "ADMIN") {
    const rows = await getDb().select().from(users)
      .where(and(ne(users.status, "ARCHIVED"), notInArray(users.role, ["ADMIN", "MANAGER"])))
      .orderBy(asc(users.displayName)).limit(500);
    return Response.json({ users: rows.map((row) => ({ ...toPublicUser(row), status: row.status,
      profilePhotoStatus: row.profilePhotoStatus,
      photoUrl: row.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${row.id}` : null })) }, { headers: { "cache-control": "private, no-store" } });
  }
  // Archived accounts stay visible to admins only. History joins (cases, events,
  // analytics) still resolve their display names; this list is the only surface filtered.
  const rows = await getDb().select().from(users).orderBy(asc(users.displayName)).limit(500);
  return Response.json({ users: rows.map((row) => ({ ...toPublicUser(row), status: row.status,
    profilePhotoStatus: row.profilePhotoStatus,
    photoUrl: row.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${row.id}` : null })) }, { headers: { "cache-control": "private, no-store" } });
}
