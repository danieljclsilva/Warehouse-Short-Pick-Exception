import { authenticate, hasAuthPermission } from "@/server/auth";
import { checkLimitSchema, getCheckLimit, setCheckLimit } from "@/server/checks";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "MANAGE_CONFIGURATION")) return jsonError("Forbidden", 403);
    return Response.json({ maxSimultaneousChecksPerCase: await getCheckLimit() });
  } catch (error) { return handleRouteError(error); }
}

export async function PUT(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, checkLimitSchema);
    return Response.json({ maxSimultaneousChecksPerCase: await setCheckLimit(auth, input.maxSimultaneousChecksPerCase) });
  } catch (error) { return handleRouteError(error); }
}
