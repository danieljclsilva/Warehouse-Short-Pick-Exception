import { authenticate } from "@/server/auth";
import { listMyRetrievals } from "@/server/case-progress";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json({ retrievals: await listMyRetrievals(auth) });
  } catch (error) { return handleRouteError(error); }
}
