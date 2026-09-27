import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { listAnalyticsReports } from "@/server/analytics-report-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const params = new URL(request.url).searchParams;
    if (params.getAll("cursor").length > 1) return jsonError("Invalid report pagination cursor", 400);
    const page = await listAnalyticsReports(auth, params.get("cursor") ?? undefined);
    return Response.json(page, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
