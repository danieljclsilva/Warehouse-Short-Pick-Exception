import { authenticate, revokeSession } from "@/server/auth";
import { clearSessionCookie } from "@/server/auth";

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth) await revokeSession(auth.sessionId, "logout");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
