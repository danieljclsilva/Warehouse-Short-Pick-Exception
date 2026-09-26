import { authenticate } from "@/server/auth";
import { getOperationsDashboard } from "@/server/operations";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await getOperationsDashboard(auth));
  } catch (error) { return handleRouteError(error); }
}
