import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { getAnalyticsReportData, parseAnalyticsFilters } from "@/server/analytics";
import { renderAnalyticsPdf, type AnalyticsReportData } from "@/server/analytics-pdf";
import { persistAnalyticsReport } from "@/server/analytics-report-storage";
import { logServerError } from "@/server/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const filters = parseAnalyticsFilters(new URL(request.url).searchParams);
    const analytics = await getAnalyticsReportData(auth, filters);
    // AnalyticsData keeps rich row interfaces and Date values; the renderer
    // intentionally accepts a serializable, field-tolerant view of the same
    // response so it can remain independent of query implementation details.
    const pdf = await renderAnalyticsPdf(analytics as unknown as AnalyticsReportData, { language: auth.user.preferredLanguage });
    const filename = `short-pick-analytics-${new Date().toISOString().slice(0, 10)}.pdf`;
    let reportId: string | null = null;
    try {
      reportId = await persistAnalyticsReport(auth, filename, filters, pdf);
    } catch (retentionError) {
      logServerError("report.pdf.retention_failed", retentionError, { area: "reports", route: "/api/analytics/export/pdf", userId: auth.user.id, reason: "retained copy unavailable; streaming generated PDF" });
      reportId = null;
    }
    return new Response(pdf as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "content-length": String(pdf.byteLength),
        "x-report-retention": reportId ? "retained" : "unavailable",
        ...(reportId ? { "x-report-id": reportId } : {}),
      },
    });
  } catch (error) {
    logServerError("report.pdf.generation_failed", error, { area: "reports", route: "/api/analytics/export/pdf" });
    return handleRouteError(error);
  }
}
