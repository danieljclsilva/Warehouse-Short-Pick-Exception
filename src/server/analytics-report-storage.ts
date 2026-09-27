import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { analyticsReports } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { getStorage } from "@/server/storage";
import { logServerError } from "@/server/logger";

export async function persistAnalyticsReport(auth: AuthContext, filename: string, filters: unknown, pdf: Uint8Array) {
  const storage = getStorage();
  if (!storage) {
    if (process.env.NODE_ENV === "production") throw new Error("Persistent object storage is required to generate analytics reports in production");
    return null;
  }
  const id = randomUUID();
  const objectKey = `analytics-reports/${auth.user.id}/${id}.pdf`;
  await storage.put(objectKey, pdf, "application/pdf");
  try {
    const [report] = await getDb().insert(analyticsReports).values({ generatedByUserId: auth.user.id, objectKey, filename,
      filters: filters && typeof filters === "object" ? filters as Record<string, unknown> : {}, byteSize: pdf.byteLength }).returning({ id: analyticsReports.id });
    if (!report) throw new Error("Analytics report metadata was not saved");
    return report.id;
  } catch (error) {
    try { await storage.delete(objectKey); }
    catch (deleteError) { logServerError("analytics_report.upload_compensation_failed", deleteError, { area: "analytics_report", userId: auth.user.id, reason: "uploaded object could not be deleted after database failure" }); }
    throw error;
  }
}
