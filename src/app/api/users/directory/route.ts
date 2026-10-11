import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { orderCases, shortPickLines, users } from "@/db/schema";
import { authenticate, hasAuthPermission } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams, paginationMeta, paginationOffset } from "@/server/pagination";
import { assertReplenishmentCaseAccess } from "@/server/case-progress";
import { loadExplicitPickerOverride, loadOriginCheck } from "@/server/retrieval-routing";
import { getConfigurationVersion } from "@/server/configuration";

/**
 * Minimal completion-candidate directory for the replenishment form.
 * Permission-gated (`RECORD_REPLENISHMENT`), paginated, excludes privileged
 * accounts, and lists only ACTIVE holders of CONFIRM_RETRIEVAL — never
 * credentials, sessions, or contact details. With `caseId` (+ optional
 * `lineId`) context the server independently validates case access and the
 * current phase, then returns only valid COMPLETED candidates for that phase:
 * the eligible picker in PICKING (plus the eligible originating checker when
 * the case snapshot enables checker retrieval during picking), or any
 * eligible worker in STAGED (manual retrieval assignment). An explicit
 * authorized picker-retrieval choice on the origin task pins PICKING to the
 * picker. Without context the endpoint returns all eligible workers.
 */
const directoryQuerySchema = z.object({
  caseId: z.uuid().nullable().optional(),
  lineId: z.uuid().nullable().optional(),
});

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    if (!hasAuthPermission(auth, "RECORD_REPLENISHMENT")) return jsonError("Forbidden", 403);
    const params = new URL(request.url).searchParams;
    const { page, pageSize } = parsePaginationParams(params);
    const query = directoryQuerySchema.parse({ caseId: params.get("caseId"), lineId: params.get("lineId") });
    const db = getDb();
    if (query.caseId) {
      const [record] = await db.select().from(orderCases).where(eq(orderCases.id, query.caseId)).limit(1);
      if (!record || record.phase === "CLOSED") return jsonError("Case is closed or missing", 409);
      await db.transaction(async (tx) => assertReplenishmentCaseAccess(tx, auth, record));
      if (query.lineId) {
        const [line] = await db.select().from(shortPickLines)
          .where(and(eq(shortPickLines.id, query.lineId), eq(shortPickLines.caseId, query.caseId))).limit(1);
        if (!line) return jsonError("Line not found", 404);
      }
      if (record.phase === "PICKING") {
        const configuration = await getConfigurationVersion(db, record.configurationVersionId);
        const origin = query.lineId ? await db.transaction(async (tx) => loadOriginCheck(tx, query.lineId!)) : null;
        const explicitPickerOverride = query.lineId
          ? await db.transaction(async (tx) => loadExplicitPickerOverride(tx, record.id, query.lineId!, origin?.taskId ?? null))
          : false;
        const pickerCandidates = await db.select({ id: users.id, displayName: users.displayName, role: users.role })
          .from(users)
          .where(and(eq(users.status, "ACTIVE"), notInArray(users.role, ["ADMIN", "MANAGER"]),
            record.pickingUserId ? eq(users.id, record.pickingUserId) : sql`false`,
            sql`${users.permissions} ? 'CONFIRM_RETRIEVAL'`))
          .orderBy(asc(users.displayName), asc(users.id));
        if (explicitPickerOverride || !configuration?.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED || !origin?.checkerUserId) {
          return Response.json({ users: pickerCandidates, ...paginationMeta(pickerCandidates.length, 1, Math.max(pickerCandidates.length, 1)),
            context: { caseId: record.id, phase: record.phase, explicitPickerOverride } },
            { headers: { "cache-control": "private, no-store" } });
        }
        const checkerCandidates = await db.select({ id: users.id, displayName: users.displayName, role: users.role })
          .from(users)
          .where(and(eq(users.status, "ACTIVE"), notInArray(users.role, ["ADMIN", "MANAGER"]),
            eq(users.id, origin.checkerUserId), sql`${users.permissions} ? 'CONFIRM_RETRIEVAL'`))
          .orderBy(asc(users.displayName), asc(users.id));
        const combined = [...pickerCandidates, ...checkerCandidates.filter((row) => !pickerCandidates.some((picker) => picker.id === row.id))];
        return Response.json({ users: combined, ...paginationMeta(combined.length, 1, Math.max(combined.length, 1)),
          context: { caseId: record.id, phase: record.phase, explicitPickerOverride } },
          { headers: { "cache-control": "private, no-store" } });
      }
    }
    const scope = and(eq(users.status, "ACTIVE"), notInArray(users.role, ["ADMIN", "MANAGER"]),
      sql`${users.permissions} ? 'CONFIRM_RETRIEVAL'`);
    const [[countRow], rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(users).where(scope),
      db.select({ id: users.id, displayName: users.displayName, role: users.role })
        .from(users)
        .where(scope)
        .orderBy(asc(users.displayName), asc(users.id))
        .limit(pageSize).offset(paginationOffset(page, pageSize)),
    ]);
    const total = countRow?.count ?? 0;
    return Response.json({ users: rows, ...paginationMeta(total, page, pageSize),
      ...(query.caseId ? { context: { caseId: query.caseId, phase: "STAGED" as const } } : {}) },
      { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
