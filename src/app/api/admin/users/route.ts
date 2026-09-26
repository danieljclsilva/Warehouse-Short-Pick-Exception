import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticate, hasAuthPermission, toPublicUser } from "@/server/auth";
import { jsonError } from "@/server/http";

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return jsonError("Unauthenticated", 401);
  if (!hasAuthPermission(auth, "VIEW_USERS")) return jsonError("Forbidden", 403);
  const rows = await getDb().select().from(users).orderBy(asc(users.displayName)).limit(500);
  return Response.json({ users: rows.map(toPublicUser) });
}
