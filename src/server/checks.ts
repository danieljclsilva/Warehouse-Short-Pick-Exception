import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, checkTasks, configurationAudits, configurationVersions, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { insertMonitoringNotifications, insertResponsibilityNotification } from "@/server/notifications";
import { assertConfigurationPermission, getConfigurationVersion, getCurrentConfiguration, normalizeConfigurationValues } from "@/server/configuration";

export const assignCheckSchema = z.object({ userId: z.string().uuid() });
export const completeCheckSchema = z.object({
  code: z.enum(["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"]),
  discoveredLocation: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()).optional(),
}).superRefine((value, context) => {
  if (value.code === "FOUND" && !value.discoveredLocation) {
    context.addIssue({ code: "custom", path: ["discoveredLocation"], message: "A discovered location is required when stock is found" });
  }
  if (value.code !== "FOUND" && value.discoveredLocation) {
    context.addIssue({ code: "custom", path: ["discoveredLocation"], message: "A discovered location is only valid for FOUND" });
  }
});
export const checkLimitSchema = z.object({ maxSimultaneousChecksPerCase: z.number().int().min(1).max(100).nullable() });

export async function getCheckLimit() {
  return (await getCurrentConfiguration()).values.MAX_SIMULTANEOUS_CHECKS_PER_CASE;
}

export async function setCheckLimit(auth: AuthContext, limit: number | null) {
  const value = checkLimitSchema.parse({ maxSimultaneousChecksPerCase: limit }).maxSimultaneousChecksPerCase;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('short-pick-configuration'))`);
    const [current] = await tx.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1).for("update");
    if (!current) throw new Error("Configuration has not been initialized; run migrations");
    const previous = normalizeConfigurationValues(current.values);
    assertConfigurationPermission(auth, previous);
    const next = { ...previous, MAX_SIMULTANEOUS_CHECKS_PER_CASE: value };
    if (previous.MAX_SIMULTANEOUS_CHECKS_PER_CASE === value) return;
    const [created] = await tx.insert(configurationVersions).values({ version: current.version + 1, values: next, changedByUserId: auth.user.id }).returning({ id: configurationVersions.id, version: configurationVersions.version });
    if (!created) throw new Error("Configuration version was not created");
    await tx.insert(configurationAudits).values({ previousVersionId: current.id, newVersionId: created.id, changedByUserId: auth.user.id, changedValues: { MAX_SIMULTANEOUS_CHECKS_PER_CASE: value } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CONFIGURATION_CHANGED", details: { previousVersion: current.version, newVersion: created.version, changedValues: { MAX_SIMULTANEOUS_CHECKS_PER_CASE: value }, source: "legacy_check_capacity_endpoint" } });
  });
  return value;
}

export async function listChecks(auth: AuthContext, scope: "available" | "mine" | "active") {
  if (scope === "available" && !hasAuthPermission(auth, "VIEW_AVAILABLE_CHECKS") && !hasAuthPermission(auth, "ASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view available checks", 403);
  if (scope === "mine" && !hasAuthPermission(auth, "COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view assigned checks", 403);
  if (scope === "active" && !hasAuthPermission(auth, "REASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view active checks", 403);
  const rows = await getDb().select({ task: checkTasks, line: shortPickLines, case: orderCases })
    .from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .where(and(ne(orderCases.phase, "CLOSED"), scope === "available"
      ? and(eq(checkTasks.status, "AVAILABLE"), eq(shortPickLines.state, "OPEN"))
      : scope === "mine"
        ? and(inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"]), sql`(${checkTasks.claimedByUserId} = ${auth.user.id} OR ${checkTasks.assignedToUserId} = ${auth.user.id})`)
        : inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"])))
    .orderBy(desc(checkTasks.createdAt)).limit(100);
  return rows.map((row) => ({ ...row.task, orderNumber: row.case.orderNumber, caseId: row.case.id, casePhase: row.case.phase,
    location: row.line.originalLocation, sku: row.line.sku, quantity: row.line.missingQuantity, lineId: row.line.id }));
}

async function taskCaseId(taskId: string) {
  const [link] = await getDb().select({ caseId: shortPickLines.caseId }).from(checkTasks)
    .innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id)).where(eq(checkTasks.id, taskId)).limit(1);
  if (!link) throw new CaseApiError("CASE_NOT_FOUND", "Check task not found", 404);
  return link.caseId;
}

export async function claimCheck(auth: AuthContext, taskId: string) {
  if (!hasAuthPermission(auth, "CLAIM_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot claim checks", 403);
  const caseId = await taskCaseId(taskId);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const configuration = await getConfigurationVersion(tx, record.configurationVersionId);
    if (configuration && !configuration.values.CLAIM_CHECKS_ENABLED) throw new CaseApiError("CASE_ACCESS_DENIED", "Claiming checks is disabled", 403);
    const [task] = await tx.select().from(checkTasks).where(eq(checkTasks.id, taskId)).for("update").limit(1);
    if (!task || task.status !== "AVAILABLE") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Check is already claimed or assigned", 409);
    const [line] = await tx.select().from(shortPickLines).where(eq(shortPickLines.id, task.shortPickLineId)).limit(1);
    if (!line || line.state !== "OPEN") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Line is not available for checking", 409);
    const limit = configuration ? configuration.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE : 1;
    const [active] = await tx.select({ count: sql<number>`count(*)::int` }).from(checkTasks)
      .innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
      .where(and(eq(shortPickLines.caseId, caseId), inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"])));
    if (limit !== null && active.count >= limit) throw new CaseApiError("CHECK_CAPACITY_REACHED", "Case check capacity has been reached", 409);
    const now = new Date();
    await tx.update(checkTasks).set({ status: "CLAIMED", claimedByUserId: auth.user.id, claimedAt: now, startedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, taskId));
    await tx.update(shortPickLines).set({ state: "CHECKING", currentResponsibleUserId: auth.user.id, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "CHECK_CLAIMED", details: { taskId } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CHECK_CLAIMED", details: { caseId, lineId: line.id, taskId } });
    await insertMonitoringNotifications(tx, { type: "CHECK_CLAIMED", caseId, shortPickLineId: line.id,
      payload: { taskId, checkerUserId: auth.user.id }, excludeUserId: auth.user.id });
    return { taskId, caseId, lineId: line.id, status: "CLAIMED" as const };
  });
}

export async function assignCheck(auth: AuthContext, taskId: string, userId: string) {
  const caseId = await taskCaseId(taskId);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const configuration = await getConfigurationVersion(tx, record.configurationVersionId);
    const [task] = await tx.select().from(checkTasks).where(eq(checkTasks.id, taskId)).for("update").limit(1);
    if (!task || task.status === "COMPLETED") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Check task is complete", 409);
    const isReassignment = task.status !== "AVAILABLE";
    if (!hasAuthPermission(auth, isReassignment ? "REASSIGN_CHECK" : "ASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot assign this check", 403);
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, "ACTIVE"))).limit(1);
    if (!target || !target.permissions.includes("COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee cannot complete checks", 400);
    const [line] = await tx.select().from(shortPickLines).where(eq(shortPickLines.id, task.shortPickLineId)).limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    if (!isReassignment && line.state !== "OPEN") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Line is not available for checking", 409);
    if (!isReassignment) {
      const limit = configuration ? configuration.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE : 1;
      const [active] = await tx.select({ count: sql<number>`count(*)::int` }).from(checkTasks)
        .innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
        .where(and(eq(shortPickLines.caseId, caseId), inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"])));
      if (limit !== null && active.count >= limit) throw new CaseApiError("CHECK_CAPACITY_REACHED", "Case check capacity has been reached", 409);
    }
    const now = new Date();
    await tx.update(checkTasks).set({ status: "ASSIGNED", assignedToUserId: userId, assignedAt: now, claimedByUserId: null, claimedAt: null, startedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, taskId));
    await tx.update(shortPickLines).set({ state: "CHECKING", currentResponsibleUserId: userId, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    const eventType = isReassignment ? "CHECK_REASSIGNED" : "CHECK_ASSIGNED";
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType, details: { taskId, assignedToUserId: userId, previousUserId: task.assignedToUserId ?? task.claimedByUserId } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: eventType, details: { caseId, lineId: line.id, taskId, userId } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId,
      shortPickLineId: line.id, payload: { taskId, orderNumber: record.orderNumber, reassigned: isReassignment } });
    return { taskId, caseId, lineId: line.id, status: "ASSIGNED" as const, assignedToUserId: userId };
  });
}

export async function completeCheck(auth: AuthContext, taskId: string, input: z.infer<typeof completeCheckSchema>) {
  if (!hasAuthPermission(auth, "COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot complete checks", 403);
  if (input.code === "FOUND" && !hasAuthPermission(auth, "REPORT_NEW_LOCATION")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot report a new location", 403);
  const caseId = await taskCaseId(taskId);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const configuration = await getConfigurationVersion(tx, record.configurationVersionId);
    if (configuration && !configuration.values.ALLOWED_RESOLUTION_CODES.includes(input.code)) throw new CaseApiError("CASE_ACCESS_DENIED", "This resolution code is disabled", 400);
    const [task] = await tx.select().from(checkTasks).where(eq(checkTasks.id, taskId)).for("update").limit(1);
    if (!task || !["CLAIMED", "ASSIGNED"].includes(task.status)) throw new CaseApiError("CHECK_NOT_AVAILABLE", "Check is not active", 409);
    if ((task.assignedToUserId ?? task.claimedByUserId) !== auth.user.id) throw new CaseApiError("CASE_ACCESS_DENIED", "This check belongs to another worker", 403);
    const [line] = await tx.select().from(shortPickLines).where(eq(shortPickLines.id, task.shortPickLineId)).limit(1);
    if (!line || line.state !== "CHECKING") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Line is not being checked", 409);
    const now = new Date();
    await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: input.code, completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, taskId));
    const found = input.code === "FOUND";
    const [stagedCaseResponsible] = record.phase === "STAGED" && record.currentCaseResponsibleUserId
      ? await tx.select({ id: users.id, role: users.role, permissions: users.permissions }).from(users).where(and(eq(users.id, record.currentCaseResponsibleUserId), eq(users.status, "ACTIVE"))).limit(1)
      : [];
    const [stagedChecker] = record.phase === "STAGED" && (task.assignedToUserId ?? task.claimedByUserId)
      ? await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.id, task.assignedToUserId ?? task.claimedByUserId!)).limit(1)
      : [];
    const stagedResponsible = stagedCaseResponsible?.role === "TROUBLESHOOTER" && stagedCaseResponsible.permissions.includes("CONFIRM_RETRIEVAL") ? stagedCaseResponsible.id
      : stagedChecker?.permissions.includes("CONFIRM_RETRIEVAL") ? stagedChecker.id : null;
    const checkerUserId = task.assignedToUserId ?? task.claimedByUserId;
    const [pickingChecker] = record.phase === "PICKING" && configuration?.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED && checkerUserId
      ? await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(and(eq(users.id, checkerUserId), eq(users.status, "ACTIVE"))).limit(1)
      : [];
    const pickingResponsible = pickingChecker?.permissions.includes("CONFIRM_RETRIEVAL") ? pickingChecker.id : record.pickingUserId;
    const retrievalUserId = found ? (record.phase === "PICKING" ? pickingResponsible : configuration?.values.CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED ? stagedResponsible : null) : null;
    await tx.update(shortPickLines).set({
      state: found ? "FOUND" : "OPEN", currentResponsibleUserId: retrievalUserId,
      discoveredLocation: found ? input.discoveredLocation : null, discoveredByUserId: found ? auth.user.id : null,
      discoveredAt: found ? now : null, retrievalState: found ? "PENDING" : "NOT_REQUIRED",
      retrievalResponsibleUserId: retrievalUserId, updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, line.id));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "CHECK_COMPLETED", details: { taskId, code: input.code } });
    if (found) {
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "NEW_LOCATION_REPORTED", details: { taskId, location: input.discoveredLocation } });
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED", details: { responsibleUserId: retrievalUserId, casePhase: record.phase } });
      if (retrievalUserId) await insertResponsibilityNotification(tx, { recipientUserId: retrievalUserId, type: "RESPONSIBILITY_NEW_LOCATION",
        caseId, shortPickLineId: line.id, payload: { taskId, orderNumber: record.orderNumber, discoveredLocation: input.discoveredLocation } });
      await insertMonitoringNotifications(tx, { type: "NEW_LOCATION", caseId, shortPickLineId: line.id,
        payload: { taskId, orderNumber: record.orderNumber, discoveredLocation: input.discoveredLocation }, excludeUserId: auth.user.id });
    }
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CHECK_COMPLETED", details: { caseId, lineId: line.id, taskId, code: input.code, discoveredLocation: input.discoveredLocation } });
    return { taskId, caseId, lineId: line.id, code: input.code, retrievalResponsibleUserId: retrievalUserId };
  });
}

export async function requestAnotherCheck(auth: AuthContext, caseId: string, lineId: string) {
  if (!hasAuthPermission(auth, "ASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot request another check", 403);
  const [link] = await getDb().select({ caseId: shortPickLines.caseId }).from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).limit(1);
  if (!link) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, link.caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const [line] = await tx.select().from(shortPickLines).where(eq(shortPickLines.id, lineId)).limit(1);
    if (!line || line.state !== "OPEN") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Line cannot be checked", 409);
    const [existing] = await tx.select({ id: checkTasks.id }).from(checkTasks).where(and(eq(checkTasks.shortPickLineId, lineId), ne(checkTasks.status, "COMPLETED"))).limit(1);
    if (existing) throw new CaseApiError("CHECK_NOT_AVAILABLE", "An active check already exists", 409);
    const [task] = await tx.insert(checkTasks).values({ shortPickLineId: lineId }).returning({ id: checkTasks.id });
    await tx.insert(caseEvents).values({ caseId: record.id, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "CHECK_REQUESTED", details: { taskId: task!.id } });
    return { taskId: task!.id, lineId, caseId: record.id };
  });
}
