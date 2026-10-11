import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, checkTasks, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError, hasCurrentCaseResponsibility, isRecordedCaseParticipant } from "@/server/cases";
import { insertInformationalNotification, insertResponsibilityNotification } from "@/server/notifications";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "@/server/pagination";
import { getConfigurationVersion } from "@/server/configuration";
import {
  isEligibleRetrievalOwner,
  loadCandidate,
  loadExplicitPickerOverride,
  loadOriginCheck,
  loadRoutingConfig,
  MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE,
  rerouteCaseRetrievals,
  resolveRetrievalOwner,
} from "@/server/retrieval-routing";
import type { RetrievalTx } from "@/server/retrieval-routing";

export const stageCaseSchema = z.object({ confirmedPhysicalPlacement: z.boolean().default(false) });
export const phaseCaseSchema = z.object({ phase: z.enum(["PICKING", "STAGED"]), confirmedPhysicalPlacement: z.boolean().default(false) });
export const retrievalSchema = z.object({ result: z.enum(["RETRIEVED", "FAILED"]) });
export const assignRetrievalSchema = z.object({ userId: z.uuid() });

export const replenishmentSchema = z.object({
  state: z.enum(["WAITING", "COMPLETED"]),
  note: z.string().trim().max(500).nullable().optional(),
  retrieverUserId: z.uuid().nullable().optional(),
});

export const retrievalListQuerySchema = paginationQuerySchema;

export async function listMyRetrievals(auth: AuthContext, options: { page?: number; pageSize?: number } = {}) {
  if (!hasAuthPermission(auth, "CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view retrievals", 403);
  const parsed = retrievalListQuerySchema.parse({ page: options.page ?? 1, pageSize: options.pageSize ?? 20 });
  const where = and(eq(shortPickLines.retrievalResponsibleUserId, auth.user.id),
    inArray(shortPickLines.retrievalState, ["PENDING", "IN_PROGRESS", "FAILED"]),
    ne(shortPickLines.state, "RESOLVED"), ne(shortPickLines.state, "CANCELLED"),
    sql`(${shortPickLines.state} = 'FOUND' OR ${shortPickLines.state} = 'OPEN' OR ${shortPickLines.state} = 'CHECKING' OR ${shortPickLines.replenishmentState} = 'COMPLETED')`,
    sql`${orderCases.phase} <> 'CLOSED'`);
  const db = getDb();
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(shortPickLines)
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id)).where(where);
  const total = countRow?.count ?? 0;
  const rows = await db.select({ line: shortPickLines, case: orderCases }).from(shortPickLines)
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .where(where)
    .orderBy(desc(shortPickLines.updatedAt)).limit(parsed.pageSize).offset(paginationOffset(parsed.page, parsed.pageSize));
  const retrievals = rows.map((row) => ({ lineId: row.line.id, caseId: row.case.id, orderNumber: row.case.orderNumber,
    casePhase: row.case.phase, location: row.line.originalLocation, physicalLocation: row.case.physicalLocation,
    originalLocation: row.line.originalLocation, discoveredLocation: row.line.discoveredLocation,
    retrievalLocation: row.line.discoveredLocation ?? row.line.originalLocation,
    sku: row.line.sku, quantity: row.line.missingQuantity, retrievalState: row.line.retrievalState,
    lineState: row.line.state, replenishmentState: row.line.replenishmentState }));
  return { retrievals, ...paginationMeta(total, parsed.page, parsed.pageSize) };
}

export async function stageCase(auth: AuthContext, caseId: string, confirmedPhysicalPlacement = false) {
  if (!hasAuthPermission(auth, "MARK_ORDER_STAGED")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot stage cases", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (record.phase !== "PICKING") throw new CaseApiError("CASE_NOT_OPEN", "Only a picking case can be staged", 409);
    if (record.pickingUserId !== auth.user.id && record.currentCaseResponsibleUserId !== auth.user.id && !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "This case belongs to another picker", 403);
    const configuration = await getConfigurationVersion(tx, record.configurationVersionId);
    if (!configuration) throw new Error("Case configuration version is missing");
    if (configuration.values.REQUIRE_STAGING_CONFIRMATION && !confirmedPhysicalPlacement) throw new CaseApiError("CASE_NOT_OPEN", "Physical staging confirmation is required", 400);
    const physicalLocation = configuration.values.SHORT_PICK_HOLD_LOCATION_NAME;
    const now = new Date();
    const stagedVersion = record.version + 1;
    await tx.update(orderCases).set({ phase: "STAGED", physicalState: "SHORT_PICK_HOLD", physicalLocation, stagedAt: now, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "ORDER_STAGED", details: { physicalLocation } });
    // Staging recomputes every pending/failed retrieval under the persisted STAGED
    // row; staged rules (explicit resolver, then configured checker) can clear an
    // owner the picking rule had set.
    const rerouted = await rerouteCaseRetrievals(tx, {
      caseRecord: { ...record, phase: "STAGED", physicalState: "SHORT_PICK_HOLD", physicalLocation, stagedAt: now, updatedAt: now },
      actorUserId: auth.user.id, reason: "STAGED",
      config: { checkerDuringPickingEnabled: false, checkerWhenStagedEnabled: configuration.values.CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED },
    });
    const conveyed = new Set(rerouted.filter((result) => result.changed && result.ownerId).map((result) => result.ownerId as string));
    const candidateIds = new Set<string>();
    const activeChecks = await tx.select({ assignedToUserId: checkTasks.assignedToUserId, claimedByUserId: checkTasks.claimedByUserId })
      .from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
      .where(and(eq(shortPickLines.caseId, caseId), inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"])));
    for (const task of activeChecks) {
      const checker = task.assignedToUserId ?? task.claimedByUserId;
      if (checker) candidateIds.add(checker);
    }
    if (record.currentCaseResponsibleUserId) candidateIds.add(record.currentCaseResponsibleUserId);
    for (const result of rerouted) {
      if (!result.changed && result.ownerId) candidateIds.add(result.ownerId);
    }
    candidateIds.delete(auth.user.id);
    for (const ownerId of conveyed) candidateIds.delete(ownerId);
    for (const recipientId of candidateIds) {
      await insertInformationalNotification(tx, { recipientUserId: recipientId, type: "ORDER_STAGED",
        caseId, excludeActorId: auth.user.id, dedupeKey: `ORDER_STAGED:${caseId}:${stagedVersion}:${recipientId}`,
        payload: { orderNumber: record.orderNumber, casePhase: "STAGED", physicalLocation } });
    }
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "ORDER_STAGED", details: { caseId, physicalLocation } });
    return { caseId, phase: "STAGED" as const, physicalState: "SHORT_PICK_HOLD" as const, physicalLocation };
  });
}
export async function updateCasePhase(auth: AuthContext, caseId: string, phase: "PICKING" | "STAGED", confirmedPhysicalPlacement = false) {
  if (!hasAuthPermission(auth, "MARK_ORDER_STAGED")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot change the order status", 403);
  if (phase !== "STAGED" && !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "Returning an order to picking requires manager access", 403);
  if (phase === "STAGED") {
    const staged = await stageCase(auth, caseId, confirmedPhysicalPlacement);
    return { ...staged, previousPhase: "PICKING" as const };
  }
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    if (record.phase === "PICKING") return { caseId, phase: "PICKING" as const, physicalState: record.physicalState, physicalLocation: record.physicalLocation, previousPhase: "PICKING" as const };
    const before = { phase: record.phase, physicalState: record.physicalState, physicalLocation: record.physicalLocation };
    const now = new Date();
    await tx.update(orderCases).set({ phase: "PICKING", physicalState: "WITH_PICKER", physicalLocation: null, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "ORDER_RETURNED_TO_PICKING", details: { before } });
    // A real return-to-picking follows the picker rule: recompute every
    // pending/failed retrieval under the persisted PICKING row, without
    // preserving staged manual assignments.
    const persisted = { ...record, phase: "PICKING" as const, physicalState: "WITH_PICKER" as const, physicalLocation: null, updatedAt: now };
    await rerouteCaseRetrievals(tx, { caseRecord: persisted, actorUserId: auth.user.id, reason: "RETURNED_TO_PICKING" });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "ORDER_RETURNED_TO_PICKING", details: { caseId, before } });
    return { caseId, phase: "PICKING" as const, physicalState: "WITH_PICKER" as const, physicalLocation: null, previousPhase: before.phase };
  });
}

type ReplenishmentLine = typeof shortPickLines.$inferSelect;

/**
 * Case access for replenishment recording and candidate listing: manager
 * view-all, or the case picker / current responsible / line reporter / current
 * task or retrieval participant via the existing access helpers.
 */
export async function assertReplenishmentCaseAccess(
  tx: RetrievalTx,
  auth: AuthContext,
  record: typeof orderCases.$inferSelect,
) {
  if (hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) return;
  if (record.pickingUserId === auth.user.id || record.currentCaseResponsibleUserId === auth.user.id) return;
  if (await hasCurrentCaseResponsibility(tx, auth, record)) return;
  if (await isRecordedCaseParticipant(tx, auth, record)) return;
  throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot access this case", 403);
}

/**
 * Pending physical-retrieval obligation: a FOUND line awaiting retrieval, or a
 * nonterminal replenishment-COMPLETED line whose materialized PENDING/FAILED
 * retrieval holds regardless of the main line state.
 */
function assertRetrievalPending(line: ReplenishmentLine) {
  if (line.state === "RESOLVED" || line.state === "CANCELLED") {
    throw new CaseApiError("RETRIEVAL_NOT_PENDING", "Line is not awaiting retrieval", 409);
  }
  if (line.retrievalState !== "PENDING" && line.retrievalState !== "IN_PROGRESS" && line.retrievalState !== "FAILED") {
    throw new CaseApiError("RETRIEVAL_NOT_PENDING", "Line is not awaiting retrieval", 409);
  }
  if (line.state !== "FOUND" && line.replenishmentState !== "COMPLETED") {
    throw new CaseApiError("RETRIEVAL_NOT_PENDING", "Line is not awaiting retrieval", 409);
  }
}

/**
 * Shared COMPLETED owner derivation. Named targets validate eligibility plus
 * phase: STAGED accepts any eligible worker (manual retrieval assignment);
 * PICKING accepts the eligible picker by default, the eligible originating
 * checker only when the case snapshot enables checker retrieval during
 * picking, and pins the picker when an explicit authorized picker-retrieval
 * choice exists on the origin task. Unnamed completion derives the same way
 * and fails clearly when no eligible phase owner exists — never an unowned
 * completion. Rejects incompatible named users; never silently substitutes.
 */
async function deriveCompletionOwner(
  tx: RetrievalTx,
  record: typeof orderCases.$inferSelect,
  line: ReplenishmentLine,
  explicitTargetId: string | null,
): Promise<{ ownerId: string; manualAssignment: boolean; reusedPreviousOwner: boolean }> {
  if (explicitTargetId) {
    const target = await loadCandidate(tx, explicitTargetId);
    if (!isEligibleRetrievalOwner(target)) {
      throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "Named retriever must be an active user who can confirm retrieval", 400, { targetUserId: explicitTargetId });
    }
    if (record.phase === "STAGED") return { ownerId: target.id, manualAssignment: true, reusedPreviousOwner: false };
    const config = await loadRoutingConfig(tx, record.configurationVersionId);
    const origin = await loadOriginCheck(tx, line.id);
    const explicitPickerOverride = await loadExplicitPickerOverride(tx, record.id, line.id, origin?.taskId ?? null);
    const [picker, checker] = await Promise.all([
      loadCandidate(tx, record.pickingUserId),
      loadCandidate(tx, origin?.checkerUserId ?? null),
    ]);
    const eligiblePickerId = isEligibleRetrievalOwner(picker) ? picker.id : null;
    const eligibleCheckerId = isEligibleRetrievalOwner(checker) ? checker.id : null;
    if (explicitPickerOverride) {
      if (target.id === eligiblePickerId) return { ownerId: target.id, manualAssignment: false, reusedPreviousOwner: false };
      throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "An explicit picker-retrieval choice on this line only supports the eligible picker", 409, { targetUserId: explicitTargetId });
    }
    if (target.id === eligiblePickerId) return { ownerId: target.id, manualAssignment: false, reusedPreviousOwner: false };
    if (config.checkerDuringPickingEnabled && eligibleCheckerId && target.id === eligibleCheckerId) {
      return { ownerId: target.id, manualAssignment: false, reusedPreviousOwner: false };
    }
    throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "Named retriever is not valid for the current picking phase", 409, { targetUserId: explicitTargetId });
  }
  // A reused WAITING name is only kept when it still validates for the CURRENT
  // phase (same rules as an explicit target); otherwise fall through to a
  // fresh safe-phase derivation or a clear failure — never a stale owner.
  const previousOwnerId = line.replenishmentRetrieverUserId ?? line.retrievalResponsibleUserId;
  if (previousOwnerId) {
    const previousOwner = await loadCandidate(tx, previousOwnerId);
    if (isEligibleRetrievalOwner(previousOwner)) {
      const reuseCheck = await deriveCompletionOwner(tx, record, line, previousOwnerId).catch((error: unknown) => {
        if (error instanceof CaseApiError && error.code === "REPLENISHMENT_FORBIDDEN") return null;
        throw error;
      });
      if (reuseCheck && reuseCheck.ownerId === previousOwnerId && !reuseCheck.reusedPreviousOwner) {
        return { ownerId: previousOwnerId, manualAssignment: record.phase === "STAGED", reusedPreviousOwner: true };
      }
    }
  }

  const config = await loadRoutingConfig(tx, record.configurationVersionId);
  const ownerId = await resolveRetrievalOwner(tx, { caseRecord: record, lineId: line.id, config });
  if (ownerId) return { ownerId, manualAssignment: false, reusedPreviousOwner: false };
  throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "No eligible retrieval owner is available for this phase; name one explicitly", 409);
}

export async function assignRetrieval(auth: AuthContext, caseId: string, lineId: string, userId: string) {
  if (!hasAuthPermission(auth, "ASSIGN_TROUBLESHOOTER")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot assign retrieval", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase !== "STAGED") throw new CaseApiError("CASE_NOT_OPEN", "Retrieval assignment requires a staged case", 409);
    const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    assertRetrievalPending(line);
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, "ACTIVE"))).limit(1);
    if (!target || !target.permissions.includes("CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee cannot confirm retrieval", 400);
    const now = new Date();
    await tx.update(shortPickLines).set({ retrievalResponsibleUserId: userId, currentResponsibleUserId: userId, retrievalState: "PENDING", updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, lineId));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED", details: { responsibleUserId: userId, previousUserId: line.retrievalResponsibleUserId, casePhase: record.phase, source: MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "RETRIEVAL_ASSIGNED", details: { caseId, lineId, userId } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED", caseId, shortPickLineId: lineId,
      payload: { orderNumber: record.orderNumber, casePhase: record.phase, physicalLocation: record.physicalLocation,
        originalLocation: line.originalLocation, discoveredLocation: line.discoveredLocation,
        retrievalLocation: line.discoveredLocation ?? line.originalLocation, location: line.originalLocation,
        replenished: line.replenishmentState === "COMPLETED", reassigned: line.retrievalResponsibleUserId !== userId } });
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
    assertRetrievalPending(line);
    const override = hasAuthPermission(auth, "RETRIEVE_FOR_OTHER_PICKER") && hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES");
    if (line.retrievalResponsibleUserId !== auth.user.id && !override) throw new CaseApiError("CASE_ACCESS_DENIED", "Retrieval belongs to another worker", 403);
    const now = new Date();
    const replenished = line.replenishmentState === "COMPLETED";
    if (result === "RETRIEVED") {
      await tx.update(shortPickLines).set({
        state: "RESOLVED", retrievalState: "RETRIEVED", retrievedByUserId: auth.user.id,
        retrievedAt: now, resolvedAt: now, currentResponsibleUserId: null,
        updatedAt: now, version: sql`${shortPickLines.version} + 1`,
      }).where(eq(shortPickLines.id, lineId));
    } else {
      // FAILED keeps the main state unchanged for replenished lines so the
      // obligation stays retryable; FOUND lines keep their existing behavior.
      await tx.update(shortPickLines).set({
        state: replenished ? line.state : "FOUND",
        retrievalState: "FAILED",
        currentResponsibleUserId: line.retrievalResponsibleUserId,
        updatedAt: now, version: sql`${shortPickLines.version} + 1`,
      }).where(eq(shortPickLines.id, lineId));
    }
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    // Success-only reconciliation: FAILED keeps outstanding check tasks live
    // and retryable; only a physical RETRIEVED success completes them as OTHER.
    let reconciled: { id: string; claimedByUserId: string | null; assignedToUserId: string | null }[] = [];
    if (result === "RETRIEVED") {
      const outstanding = await tx.select({ id: checkTasks.id, claimedByUserId: checkTasks.claimedByUserId, assignedToUserId: checkTasks.assignedToUserId })
        .from(checkTasks).where(and(eq(checkTasks.shortPickLineId, lineId), ne(checkTasks.status, "COMPLETED"))).for("update");
      if (outstanding.length > 0) {
        const reconciledRows = await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now,
          updatedAt: now, version: sql`${checkTasks.version} + 1` })
          .where(and(eq(checkTasks.shortPickLineId, lineId), ne(checkTasks.status, "COMPLETED")))
          .returning({ id: checkTasks.id });
        const checkerById: Record<string, string | null> = {};
        for (const task of outstanding) checkerById[task.id] = task.assignedToUserId ?? task.claimedByUserId ?? null;
        reconciled = reconciledRows.map((task) => ({ id: task.id, claimedByUserId: null, assignedToUserId: checkerById[task.id] ?? null }));
        for (const task of reconciled) {
          await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "CHECK_COMPLETED",
            details: { taskId: task.id, code: "OTHER", source: "REPLENISHMENT_RETRIEVAL", previousCheckerUserId: task.assignedToUserId, nonconclusive: true } });
          await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CHECK_COMPLETED",
            details: { caseId, lineId, taskId: task.id, code: "OTHER", source: "REPLENISHMENT_RETRIEVAL", previousCheckerUserId: task.assignedToUserId, nonconclusive: true } });
        }
      }
    }
    const eventType = result === "RETRIEVED" ? "RETRIEVAL_CONFIRMED" : "RETRIEVAL_FAILED";
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType,
      details: { discoveredLocation: line.discoveredLocation, retrievalLocation: line.discoveredLocation ?? line.originalLocation,
        replenished, reconciledCheckTaskIds: reconciled.map((task) => task.id), casePhase: record.phase } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: eventType, details: { caseId, lineId, replenished } });
    return { caseId, lineId, retrievalState: result, lineState: result === "RETRIEVED" ? "RESOLVED" : replenished ? line.state : "FOUND",
      replenished, reconciledCheckTaskIds: reconciled.map((task) => task.id),
      nextAction: result === "RETRIEVED" ? "CLOSE_CASE_WHEN_READY" : "RETRY_RETRIEVAL" };
  });
}

export async function recordReplenishment(auth: AuthContext, caseId: string, lineId: string, input: z.infer<typeof replenishmentSchema>) {
  if (!hasAuthPermission(auth, "RECORD_REPLENISHMENT")) throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "Recording replenishment requires the replenishment grant", 403);
  const explicitTarget = input.retrieverUserId ?? null;
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    await assertReplenishmentCaseAccess(tx, auth, record);
    const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    const note = input.note === undefined ? line.replenishmentNote : input.note?.trim() || null;
    if (line.state === "RESOLVED" || line.state === "CANCELLED") throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "Replenishment is not available on a terminal line", 409);
    const current = line.replenishmentState === "WAITING" || line.replenishmentState === "COMPLETED" ? line.replenishmentState : "NONE";
    const allowed = (current === "NONE" && (input.state === "WAITING" || input.state === "COMPLETED"))
      || (current === "WAITING" && input.state === "COMPLETED");
    if (!allowed) throw new CaseApiError("REPLENISHMENT_FORBIDDEN", `Replenishment cannot move from ${current} to ${input.state}`, 409, { current, requested: input.state });
    const now = new Date();
    if (input.state === "WAITING") {
      // WAITING records progress context (note, named owner, actor, time)
      // without transferring current or retrieval ownership. A named target
      // validates eligibility only; deriving a progress owner is not a transfer.
      let waitingOwnerId: string | null = null;
      if (explicitTarget) {
        const target = await loadCandidate(tx, explicitTarget);
        if (!isEligibleRetrievalOwner(target)) {
          throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "Named retriever must be an active user who can confirm retrieval", 400, { targetUserId: explicitTarget });
        }
        waitingOwnerId = target.id;
      } else {
        const config = await loadRoutingConfig(tx, record.configurationVersionId);
        waitingOwnerId = await resolveRetrievalOwner(tx, { caseRecord: record, lineId, config });
      }
      await tx.update(shortPickLines).set({
        replenishmentState: "WAITING", replenishmentNote: note, replenishmentActorUserId: auth.user.id,
        replenishmentAt: now, replenishmentRetrieverUserId: waitingOwnerId, updatedAt: now, version: sql`${shortPickLines.version} + 1`,
      }).where(eq(shortPickLines.id, lineId));
      await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "REPLENISHMENT_WAITING",
        details: { previousState: current, state: "WAITING", note, namedRetrieverUserId: waitingOwnerId, casePhase: record.phase } });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "REPLENISHMENT_WAITING",
        details: { caseId, lineId, previousState: current, state: "WAITING", note, namedRetrieverUserId: waitingOwnerId } });
      const [waitingOwner] = waitingOwnerId ? await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, waitingOwnerId)).limit(1) : [];
      return { caseId, lineId, previousState: current, state: "WAITING" as const, at: now.toISOString(),
        note, ownerName: waitingOwner?.displayName ?? null, retrievalResponsibleUserId: line.retrievalResponsibleUserId, retrievalLocation: null,
        nextAction: "COMPLETE_REPLENISHMENT_AND_ASSIGN_RETRIEVAL" as const };
    }
    // COMPLETED materializes a PENDING physical-retrieval obligation without
    // touching the main line state or inventing a discovered location. An
    // completed physical retrieval (RETRIEVED) stays finished.
    if (line.retrievalState === "RETRIEVED") {
      throw new CaseApiError("REPLENISHMENT_FORBIDDEN", "A completed physical retrieval already exists for this line", 409, { current, requested: input.state });
    }
    const derived = await deriveCompletionOwner(tx, record, line, explicitTarget);
    const ownerId = derived.ownerId;
    const manualAssignment = derived.manualAssignment;
    const reusePrevious = derived.reusedPreviousOwner;
    const retrievalLocation = line.discoveredLocation ?? line.originalLocation;
    await tx.update(shortPickLines).set({
      replenishmentState: "COMPLETED", replenishmentNote: note, replenishmentActorUserId: auth.user.id,
      replenishmentAt: now, replenishmentRetrieverUserId: ownerId,
      retrievalState: "PENDING",
      retrievalResponsibleUserId: ownerId,
      currentResponsibleUserId: ownerId,
      updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, lineId));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "REPLENISHMENT_COMPLETED",
      details: { previousState: current, state: "COMPLETED", note, namedRetrieverUserId: ownerId,
        reusedPreviousOwner: reusePrevious === true, manualAssignment,
        retrievalResponsibleUserId: ownerId, previousRetrievalResponsibleUserId: line.retrievalResponsibleUserId,
        retrievalLocation, physicalLocation: record.physicalLocation, originalLocation: line.originalLocation,
        ...(line.discoveredLocation ? { discoveredLocation: line.discoveredLocation } : {}),
        casePhase: record.phase } });
    // Every fresh completion assigns the retrieval: RETRIEVAL_ASSIGNED carries
    // the manual source for explicit or reused STAGED names, else the
    // replenishment-completion source — always with previous/new owner/phase.
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED",
      details: { responsibleUserId: ownerId,
        previousUserId: line.retrievalResponsibleUserId, casePhase: record.phase,
        source: manualAssignment ? MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE : "REPLENISHMENT_COMPLETION",
        replenishmentCompletion: true, previousPhase: line.state, newPhase: line.state } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "REPLENISHMENT_COMPLETED",
      details: { caseId, lineId, previousState: current, state: "COMPLETED", note, namedRetrieverUserId: ownerId } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "RETRIEVAL_ASSIGNED",
      details: { caseId, lineId, responsibleUserId: ownerId, previousUserId: line.retrievalResponsibleUserId,
        casePhase: record.phase, source: manualAssignment ? MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE : "REPLENISHMENT_COMPLETION" } });
    const finalOwnerId = ownerId;
    const [owner] = finalOwnerId ? await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, finalOwnerId)).limit(1) : [];
    if (finalOwnerId) {
      await insertResponsibilityNotification(tx, { recipientUserId: finalOwnerId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED",
        caseId, shortPickLineId: lineId,
        payload: { orderNumber: record.orderNumber, replenished: true, reassigned: line.retrievalResponsibleUserId !== finalOwnerId,
          retrievalLocation, location: retrievalLocation, physicalLocation: record.physicalLocation, originalLocation: line.originalLocation,
          ...(line.discoveredLocation ? { discoveredLocation: line.discoveredLocation } : {}),
          casePhase: record.phase } });
    }
    return { caseId, lineId, previousState: current, state: "COMPLETED" as const, at: now.toISOString(),
      note, retrievalResponsibleUserId: finalOwnerId, retrievalResponsibleName: owner?.displayName ?? null,
      ownerName: owner?.displayName ?? null, retrievalLocation,
      nextAction: "RETRIEVE_AT_LOCATION" as const };
  });
}
