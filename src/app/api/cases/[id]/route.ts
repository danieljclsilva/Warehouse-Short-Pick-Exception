import { authenticate } from "@/server/auth";
import { caseTimelineQuerySchema, getCaseForUser } from "@/server/cases";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";
import { getDb } from "@/db";
import { caseEvents } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams, 50);
    const timeline = caseTimelineQuerySchema.parse({ page, pageSize });
    const detail = (await getCaseForUser(auth, id, { page: timeline.page, pageSize: timeline.pageSize })) as Record<string, unknown> & {
      lines?: Array<Record<string, unknown> & { id?: string }>;
      lineProjections?: Array<Record<string, unknown>>;
      projection?: { lines?: Array<Record<string, unknown>> };
    };
    // Additive read-shape passthrough only (no cases.ts changes): surface the latest
    // assign-time pickerRetrieval choice from CHECK_ASSIGNED/CHECK_REASSIGNED event
    // details onto matching line shapes. Absence of the flag preserves current behavior.
    try {
      const rawLines = Array.isArray(detail.lines) ? detail.lines : [];
      const lineIds = rawLines.map((line) => typeof line.id === "string" ? line.id : "").filter(Boolean);
      if (lineIds.length) {
        const events = await getDb().select({ shortPickLineId: caseEvents.shortPickLineId, eventType: caseEvents.eventType, details: caseEvents.details, createdAt: caseEvents.createdAt })
          .from(caseEvents)
          .where(and(eq(caseEvents.caseId, id), inArray(caseEvents.eventType, ["CHECK_ASSIGNED", "CHECK_REASSIGNED"])))
          .orderBy(desc(caseEvents.createdAt));
        const flagged: Record<string, true> = {};
        for (const event of events) {
          const target = event.shortPickLineId;
          if (!target || flagged[target]) continue;
          const details = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
          if (details.pickerRetrieval === true) flagged[target] = true;
        }
        if (Object.keys(flagged).length) {
          const lines = rawLines.map((line) => (typeof line.id === "string" && flagged[line.id] ? { ...line, pickerRetrieval: true } : line));
          const projections = Array.isArray(detail.lineProjections) ? detail.lineProjections.map((entry) => {
            const target = typeof entry.lineId === "string" ? entry.lineId : "";
            return target && flagged[target] ? { ...entry, pickerRetrieval: true } : entry;
          }) : detail.lineProjections;
          const projection = detail.projection && Array.isArray(detail.projection.lines)
            ? { ...detail.projection, lines: detail.projection.lines.map((entry) => {
              const target = typeof entry.lineId === "string" ? entry.lineId : "";
              return target && flagged[target] ? { ...entry, pickerRetrieval: true } : entry;
            }) }
            : detail.projection;
          return Response.json({ case: { ...detail, lines, ...(projections ? { lineProjections: projections } : {}), ...(projection ? { projection } : {}) } });
        }
      }
    } catch { /* Passthrough enrichment is best-effort; the base read shape still applies. */ }
    return Response.json({ case: detail });
  } catch (error) { return handleRouteError(error); }
}
