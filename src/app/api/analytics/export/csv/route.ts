import { authenticate, hasAuthPermission } from "@/server/auth";
import { getAnalyticsEvents, getAnalyticsReportData, parseAnalyticsFilters, sameLocationFoundCsv, sameLocationFoundOverallCsv } from "@/server/analytics";
import { managementAnalyticsCsv } from "@/server/analytics-management-csv";
import { analyticsCsv, analyticsEventCsv } from "@/server/analytics-csv";
import { handleRouteError, jsonError } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const datasets = new Set(["case", "line", "event", "same-location-found", "same-location-found-overall", "management"]);

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const params = new URL(request.url).searchParams;
    const dataset = params.get("dataset") ?? "case";
    if (!datasets.has(dataset)) return jsonError("Dataset must be case, line, event, same-location-found, or same-location-found-overall, or management", 400);
    const filters = parseAnalyticsFilters(params);
    const isEvent = dataset === "event";
    const events = isEvent ? await getAnalyticsEvents(auth, filters) : null;
    const data = isEvent ? null : await getAnalyticsReportData(auth, filters);
    const csv = dataset === "management" ? managementAnalyticsCsv(data!.management!) : isEvent ? analyticsEventCsv(events!.rows)
      : dataset === "same-location-found" ? sameLocationFoundCsv(data!.kpis.sameLocationFoundByUser)
      : dataset === "same-location-found-overall" ? sameLocationFoundOverallCsv(data!.kpis.sameLocationFound)
      : analyticsCsv(data!, dataset as "case" | "line");
    const truncated = isEvent ? events!.truncated : dataset === "management"
      ? data!.management!.backlog.truncated || data!.management!.lifetimeRecurrence.groupsTruncated || data!.management!.lifetimeRecurrence.datesTruncated
      : data!.limits.casesTruncated || data!.limits.linesTruncated || data!.limits.tasksTruncated || data!.limits.derivedMetricsTruncated;
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="short-pick-analytics-${dataset === "management" ? "summary" : dataset}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-analytics-truncated": String(truncated),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
