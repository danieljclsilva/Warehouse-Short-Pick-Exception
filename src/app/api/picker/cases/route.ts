import { authenticate } from "@/server/auth";
import { listCasesForUser } from "@/server/cases";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json({ cases: await listCasesForUser(auth, "mine") });
  } catch (error) { return handleRouteError(error); }
}
