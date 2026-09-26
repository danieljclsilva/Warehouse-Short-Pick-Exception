import { authenticate, hasAuthPermission } from "@/server/auth";
import { lookupOrder, lookupOrderSchema } from "@/server/cases";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "REPORT_SHORT_PICK")) return jsonError("Forbidden", 403);
    const input = await parseJson(request, lookupOrderSchema);
    return Response.json(await lookupOrder(auth, input.orderNumber));
  } catch (error) { return handleRouteError(error); }
}
