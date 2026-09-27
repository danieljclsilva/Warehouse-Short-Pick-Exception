import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { analyticsReports, auditLog } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/case-errors";
import { getStorage } from "@/server/storage";
import { logServerError } from "@/server/logger";

export async function persistAnalyticsReport(auth: AuthContext, filename: string, filters: unknown, pdf: Uint8Array) {
  if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) throw new CaseApiError("CASE_ACCESS_DENIED", "EXPORT_ANALYTICS permission required", 403);
  const storage = getStorage();
  if (!storage) {
    if (process.env.NODE_ENV === "production") throw new Error("Persistent object storage is required to generate analytics reports in production");
    return null;
  }
  const id = randomUUID();
  const objectKey = `analytics-reports/${auth.user.id}/${id}.pdf`;
  await storage.put(objectKey, pdf, "application/pdf");
  try {
    const result = await getDb().transaction(async (tx) => {
      const [report] = await tx.insert(analyticsReports).values({ generatedByUserId: auth.user.id, objectKey, filename,
        filters: filters && typeof filters === "object" ? filters as Record<string, unknown> : {}, byteSize: pdf.byteLength }).returning({ id: analyticsReports.id });
      if (!report) throw new Error("Analytics report metadata was not saved");
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: null,
        action: "ANALYTICS_REPORT_GENERATED", details: { reportId: report.id, objectKey, filename, byteSize: pdf.byteLength } });
      return report;
    });
    return result.id;
  } catch (error) {
    try { await storage.delete(objectKey); }
    catch (deleteError) { logServerError("analytics_report.upload_compensation_failed", deleteError, { area: "analytics_report", userId: auth.user.id, reason: "uploaded object could not be deleted after database failure" }); }
    throw error;
  }
}

export async function getAnalyticsReport(auth: AuthContext, reportId: string) {
  if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) throw new CaseApiError("CASE_ACCESS_DENIED", "EXPORT_ANALYTICS permission required", 403);
  const [report] = await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId)).limit(1);
  if (!report) throw new CaseApiError("CASE_NOT_FOUND", "Analytics report not found", 404);
  if (report.generatedByUserId !== auth.user.id && auth.user.role !== "TEAM_LEADER") {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Only the report creator or a Team Leader can download this report", 403);
  }
  const storage = getStorage();
  if (!storage) throw new CaseApiError("STORAGE_UNAVAILABLE", "Analytics report storage is unavailable", 503);
  const object = await storage.get(report.objectKey);
  if (!object) throw new CaseApiError("CASE_NOT_FOUND", "Analytics report not found", 404);
  return { body: object.body, contentType: "application/pdf", filename: report.filename };
}

const REPORT_PAGE_SIZE = 50;
const reportCursorSchema = z.object({ createdAtMicros: z.string().regex(/^\d{1,20}$/), id: z.uuid() }).strict();

function parseReportCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new CaseApiError("INVALID_INPUT", "Invalid report pagination cursor", 400);
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return reportCursorSchema.parse(value);
  } catch {
    throw new CaseApiError("INVALID_INPUT", "Invalid report pagination cursor", 400);
  }
}

export async function listAnalyticsReports(auth: AuthContext, cursorValue?: string) {
  if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) throw new CaseApiError("CASE_ACCESS_DENIED", "EXPORT_ANALYTICS permission required", 403);
  const cursor = parseReportCursor(cursorValue);
  const ownerFilter = eq(analyticsReports.generatedByUserId, auth.user.id);
  const createdAtMicros = sql`(extract(epoch from ${analyticsReports.createdAt}) * 1000000)::bigint`;
  const where = cursor
    ? and(ownerFilter, or(sql`${createdAtMicros} < ${cursor.createdAtMicros}::bigint`, and(sql`${createdAtMicros} = ${cursor.createdAtMicros}::bigint`, lt(analyticsReports.id, cursor.id))))
    : ownerFilter;
  const rows = await getDb().select({ id: analyticsReports.id, filename: analyticsReports.filename, createdAt: analyticsReports.createdAt,
    createdAtMicros: sql<string>`${createdAtMicros}::text`, byteSize: analyticsReports.byteSize, filters: analyticsReports.filters })
    .from(analyticsReports).where(where)
    .orderBy(desc(analyticsReports.createdAt), desc(analyticsReports.id)).limit(REPORT_PAGE_SIZE + 1);
  const hasMore = rows.length > REPORT_PAGE_SIZE;
  const reports = rows.slice(0, REPORT_PAGE_SIZE);
  const last = reports[reports.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ createdAtMicros: last.createdAtMicros, id: last.id })).toString("base64url")
    : null;
  return { reports, nextCursor };
}

export async function deleteAnalyticsReport(auth: AuthContext, reportId: string) {
  if (!hasAuthPermission(auth, "EXPORT_ANALYTICS")) throw new CaseApiError("CASE_ACCESS_DENIED", "EXPORT_ANALYTICS permission required", 403);
  const storage = getStorage();
  if (!storage) throw new CaseApiError("STORAGE_UNAVAILABLE", "Report storage is unavailable; the report was not deleted", 503);

  return getDb().transaction(async (tx) => {
    const [report] = await tx.select().from(analyticsReports).where(eq(analyticsReports.id, reportId)).for("update").limit(1);
    if (!report) throw new CaseApiError("CASE_NOT_FOUND", "Analytics report not found", 404);
    const isOwner = report.generatedByUserId === auth.user.id;
    const isTeamLeader = auth.user.role === "TEAM_LEADER" && hasAuthPermission(auth, "EXPORT_ANALYTICS");
    if (!isOwner && !isTeamLeader) throw new CaseApiError("CASE_ACCESS_DENIED", "Only the report creator or a Team Leader can delete this report", 403);

    try {
      // S3-compatible DeleteObject is idempotent. If the DB transaction later rolls
      // back, the retained metadata remains and a retry can safely delete the key again.
      await storage.delete(report.objectKey);
    } catch (error) {
      logServerError("analytics_report.delete_object_failed", error, { area: "analytics_report", userId: auth.user.id });
      throw new CaseApiError("STORAGE_UNAVAILABLE", "The report could not be deleted from storage; retry later", 503);
    }

    await tx.delete(analyticsReports).where(eq(analyticsReports.id, reportId));
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: null,
      action: "ANALYTICS_REPORT_DELETED", details: { reportId: report.id, objectKey: report.objectKey } });
    return { id: report.id };
  });
}
