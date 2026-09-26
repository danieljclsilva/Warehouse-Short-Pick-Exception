import { authenticate, refreshSessionCookie } from "@/server/auth";
import { jsonError } from "@/server/http";
import { readCookie, SESSION_COOKIE } from "@/server/security";

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return jsonError("Unauthenticated", 401);
  const token = readCookie(request, SESSION_COOKIE);
  return Response.json({ user: auth.user }, { headers: token ? { "Set-Cookie": refreshSessionCookie(token) } : undefined });
}
