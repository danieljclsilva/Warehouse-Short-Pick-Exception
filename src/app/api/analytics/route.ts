import { authenticate } from "@/server/auth";
import { getAnalyticsData, parseAnalyticsFilters } from "@/server/analytics";
import { handleRouteError, jsonError } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const filters = parseAnalyticsFilters(new URL(request.url).searchParams);
    return Response.json(await getAnalyticsData(auth, filters), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
