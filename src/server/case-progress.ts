import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appSettings, auditLog, caseEvents, checkTasks, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { insertResponsibilityNotification } from "@/server/notifications";

export const stageCaseSchema = z.object({ confirmedPhysicalPlacement: z.literal(true) });
export const retrievalSchema = z.object({ result: z.enum(["RETRIEVED", "FAILED"]) });
export const assignRetrievalSchema = z.object({ userId: z.uuid() });

export async function listMyRetrievals(auth: AuthContext) {
  if (!hasAuthPermission(auth, "CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view retrievals", 403);
  const rows = await getDb().select({ line: shortPickLines, case: orderCases }).from(shortPickLines)
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .where(and(eq(shortPickLines.retrievalResponsibleUserId, auth.user.id), eq(shortPickLines.state, "FOUND"),
      inArray(shortPickLines.retrievalState, ["PENDING", "FAILED"]), sql`${orderCases.phase} <> 'CLOSED'`))
    .orderBy(desc(shortPickLines.updatedAt)).limit(100);
  return rows.map((row) => ({ lineId: row.line.id, caseId: row.case.id, orderNumber: row.case.orderNumber,
    casePhase: row.case.phase, location: row.line.originalLocation, discoveredLocation: row.line.discoveredLocation,
    sku: row.line.sku, quantity: row.line.missingQuantity, retrievalState: row.line.retrievalState }));
}

export async function stageCase(auth: AuthContext, caseId: string) {
  if (!hasAuthPermission(auth, "MARK_ORDER_STAGED")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot stage cases", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (record.phase !== "PICKING") throw new CaseApiError("CASE_NOT_OPEN", "Only a picking case can be staged", 409);
    if (record.pickingUserId !== auth.user.id && !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "This case belongs to another picker", 403);
    const [setting] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "SHORT_PICK_HOLD_LOCATION")).limit(1);
    const physicalLocation = typeof setting?.value === "string" && setting.value.trim() ? setting.value.trim() : "SHORT PICK / HOLD";
    const now = new Date();
    await tx.update(orderCases).set({ phase: "STAGED", physicalState: "SHORT_PICK_HOLD", physicalLocation, stagedAt: now, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "ORDER_STAGED", details: { physicalLocation } });
    const pendingLines = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.caseId, caseId), eq(shortPickLines.state, "FOUND")));
    for (const line of pendingLines) {
      if (line.retrievalState !== "PENDING" && line.retrievalState !== "FAILED") continue;
      const [check] = await tx.select().from(checkTasks).where(and(eq(checkTasks.shortPickLineId, line.id), eq(checkTasks.completionCode, "FOUND")))
        .orderBy(desc(checkTasks.completedAt)).limit(1);
      const checkerId = check?.assignedToUserId ?? check?.claimedByUserId ?? null;
      const [checker] = checkerId ? await tx.select().from(users).where(eq(users.id, checkerId)).limit(1) : [];
      const responsibleUserId = checker?.status === "ACTIVE" && checker.permissions.includes("CONFIRM_RETRIEVAL") ? checker.id : null;
      if (responsibleUserId !== line.retrievalResponsibleUserId) {
        await tx.update(shortPickLines).set({ retrievalResponsibleUserId: responsibleUserId, currentResponsibleUserId: responsibleUserId, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
        await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED", details: { responsibleUserId, previousUserId: line.retrievalResponsibleUserId, casePhase: "STAGED" } });
        if (responsibleUserId) await insertResponsibilityNotification(tx, { recipientUserId: responsibleUserId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED",
          caseId, shortPickLineId: line.id, payload: { orderNumber: record.orderNumber, discoveredLocation: line.discoveredLocation, reassigned: true } });
      }
    }
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "ORDER_STAGED", details: { caseId, physicalLocation } });
    return { caseId, phase: "STAGED" as const, physicalState: "SHORT_PICK_HOLD" as const, physicalLocation };
  });
}

export async function assignRetrieval(auth: AuthContext, caseId: string, lineId: string, userId: string) {
  if (!hasAuthPermission(auth, "ASSIGN_TROUBLESHOOTER")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot assign retrieval", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase !== "STAGED") throw new CaseApiError("CASE_NOT_OPEN", "Retrieval assignment requires a staged case", 409);
    const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    if (line.state !== "FOUND" || !["PENDING", "FAILED"].includes(line.retrievalState)) throw new CaseApiError("RETRIEVAL_NOT_PENDING", "Line is not awaiting retrieval", 409);
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, "ACTIVE"))).limit(1);
    if (!target || !target.permissions.includes("CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee cannot confirm retrieval", 400);
    const now = new Date();
    await tx.update(shortPickLines).set({ retrievalResponsibleUserId: userId, currentResponsibleUserId: userId, retrievalState: "PENDING", updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, lineId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED", details: { responsibleUserId: userId, previousUserId: line.retrievalResponsibleUserId, casePhase: record.phase } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "RETRIEVAL_ASSIGNED", details: { caseId, lineId, userId } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED", caseId, shortPickLineId: lineId,
      payload: { orderNumber: record.orderNumber, discoveredLocation: line.discoveredLocation, reassigned: line.retrievalResponsibleUserId !== userId } });
    return { caseId, lineId, retrievalResponsibleUserId: userId };
  });
}

export async function confirmRetrieval(auth: AuthContext, caseId: string, lineId: string, result: "RETRIEVED" | "FAILED") {
  if (!hasAuthPermission(auth, "CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot confirm retrieval", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    if (line.state !== "FOUND" || !["PENDING", "FAILED"].includes(line.retrievalState)) throw new CaseApiError("RETRIEVAL_NOT_PENDING", "Line is not awaiting retrieval", 409);
    const override = hasAuthPermission(auth, "RETRIEVE_FOR_OTHER_PICKER") && hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES");
    if (line.retrievalResponsibleUserId !== auth.user.id && !override) throw new CaseApiError("CASE_ACCESS_DENIED", "Retrieval belongs to another worker", 403);
    const now = new Date();
    await tx.update(shortPickLines).set({
      state: result === "RETRIEVED" ? "RESOLVED" : "FOUND",
      retrievalState: result, retrievedByUserId: result === "RETRIEVED" ? auth.user.id : null,
      retrievedAt: result === "RETRIEVED" ? now : null, resolvedAt: result === "RETRIEVED" ? now : null,
      currentResponsibleUserId: result === "RETRIEVED" ? null : line.retrievalResponsibleUserId,
      updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, lineId));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    const eventType = result === "RETRIEVED" ? "RETRIEVAL_CONFIRMED" : "RETRIEVAL_FAILED";
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType, details: { discoveredLocation: line.discoveredLocation, casePhase: record.phase } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: eventType, details: { caseId, lineId } });
    return { caseId, lineId, retrievalState: result };
  });
}
