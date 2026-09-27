import { asc, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission, toPublicUser } from "@/server/auth";
import { jsonError } from "@/server/http";

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return jsonError("Unauthenticated", 401);
  if (!hasAuthPermission(auth, "VIEW_USERS")) return jsonError("Forbidden", 403);
  // Archived accounts stay visible to admins only. History joins (cases, events,
  // analytics) still resolve their display names; this list is the only surface filtered.
  const rows = auth.user.role === "ADMIN"
    ? await getDb().select().from(users).orderBy(asc(users.displayName)).limit(500)
    : await getDb().select().from(users).where(ne(users.status, "ARCHIVED")).orderBy(asc(users.displayName)).limit(500);
  return Response.json({ users: rows.map((row) => ({ ...toPublicUser(row), status: row.status,
    profilePhotoStatus: row.profilePhotoStatus,
    photoUrl: row.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${row.id}` : null })) }, { headers: { "cache-control": "private, no-store" } });
}
