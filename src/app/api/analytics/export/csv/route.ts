import { authenticate, hasAuthPermission } from "@/server/auth";
import { getAnalyticsEvents, getAnalyticsReportData, parseAnalyticsFilters } from "@/server/analytics";
import { analyticsCsv, analyticsEventCsv } from "@/server/analytics-csv";
import { handleRouteError, jsonError } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const datasets = new Set(["case", "line", "event"]);

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const params = new URL(request.url).searchParams;
    const dataset = params.get("dataset") ?? "case";
    if (!datasets.has(dataset)) return jsonError("Dataset must be case, line, or event", 400);
    const filters = parseAnalyticsFilters(params);
    const isEvent = dataset === "event";
    const events = isEvent ? await getAnalyticsEvents(auth, filters) : null;
    const data = isEvent ? null : await getAnalyticsReportData(auth, filters);
    const csv = isEvent ? analyticsEventCsv(events!.rows) : analyticsCsv(data!, dataset as "case" | "line");
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="short-pick-analytics-${dataset}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-analytics-truncated": String(isEvent ? events!.truncated : data!.limits.casesTruncated || data!.limits.linesTruncated || data!.limits.tasksTruncated || data!.limits.derivedMetricsTruncated),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
