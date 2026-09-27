import { z } from "zod";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { deleteAnalyticsReport, getAnalyticsReport } from "@/server/analytics-report-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const { id } = await context.params;
    const report = await getAnalyticsReport(auth, z.uuid().parse(id));
    const safeFilename = /^[A-Za-z0-9._-]+\.pdf$/.test(report.filename) ? report.filename : "short-pick-analytics.pdf";
    return new Response(report.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": report.contentType,
        "content-disposition": `attachment; filename="${safeFilename}"`,
        "cache-control": "private, no-store",
        "content-length": String(report.body.byteLength),
      },
    });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) return jsonError("Analytics export permission required", 403);
    const { id } = await context.params;
    return Response.json(await deleteAnalyticsReport(auth, z.uuid().parse(id)), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
