import { authenticate } from "@/server/auth";
import { listChecks } from "@/server/checks";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const requestedScope = new URL(request.url).searchParams.get("scope");
    const scope = requestedScope === "mine" || requestedScope === "active" ? requestedScope : "available";
    return Response.json({ checks: await listChecks(auth, scope) });
  } catch (error) { return handleRouteError(error); }
}
