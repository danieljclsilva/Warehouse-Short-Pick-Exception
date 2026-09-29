import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, checkTasks, configurationAudits, configurationVersions, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { insertMonitoringNotifications, insertResponsibilityNotification } from "@/server/notifications";
import { assertConfigurationPermission, getConfigurationVersion, getCurrentConfiguration, normalizeConfigurationValues } from "@/server/configuration";

export const assignCheckSchema = z.object({ userId: z.string().uuid(), pickerRetrieval: z.boolean().default(false) });
export const completeCheckSchema = z.object({
  code: z.enum(["FOUND", "FOUND_AT_ORIGINAL", "NOT_FOUND", "WRONG_LOCATION", "OTHER"]),
  discoveredLocation: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()).optional(),
}).superRefine((value, context) => {
  if (value.code === "FOUND" && !value.discoveredLocation) {
    context.addIssue({ code: "custom", path: ["discoveredLocation"], message: "A discovered location is required when stock is found" });
  }
  if (value.code === "FOUND_AT_ORIGINAL" && value.discoveredLocation) {
    context.addIssue({ code: "custom", path: ["discoveredLocation"], message: "Found at the original location must not include a discovered location" });
  }
  if ((value.code === "NOT_FOUND" || value.code === "WRONG_LOCATION" || value.code === "OTHER") && value.discoveredLocation) {
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
export const checkListQuerySchema = z.object({
  scope: z.enum(["available", "mine", "active"]).default("available"),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CheckListCursor = { createdAt: string; id: string };

function parseCheckCursor(cursor: string | undefined): CheckListCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CheckListCursor>;
    if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") return null;
    if (Number.isNaN(Date.parse(decoded.createdAt)) || !z.uuid().safeParse(decoded.id).success) return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeCheckCursor(value: CheckListCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export async function listChecks(auth: AuthContext, scope: "available" | "mine" | "active", options: { cursor?: string; limit?: number } = {}) {
  if (scope === "available" && !hasAuthPermission(auth, "VIEW_AVAILABLE_CHECKS") && !hasAuthPermission(auth, "ASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view available checks", 403);
  if (scope === "mine" && !hasAuthPermission(auth, "COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view assigned checks", 403);
  if (scope === "active" && !hasAuthPermission(auth, "REASSIGN_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot view active checks", 403);
  const parsed = checkListQuerySchema.parse({ scope, cursor: options.cursor, limit: options.limit ?? 50 });
  const cursorValue = parseCheckCursor(parsed.cursor);
  if (parsed.cursor && !cursorValue) throw new CaseApiError("CASE_NOT_FOUND", "Invalid pagination cursor", 400);
  const scopePredicate = scope === "available"
    ? and(eq(checkTasks.status, "AVAILABLE"), eq(shortPickLines.state, "OPEN"))
    : scope === "mine"
      ? and(inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"]), sql`(${checkTasks.claimedByUserId} = ${auth.user.id} OR ${checkTasks.assignedToUserId} = ${auth.user.id})`)
      : inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"]);
  // Keyset on millisecond-truncated timestamps: cursors encode millisecond ISO strings, so the
  // ordering key MUST apply the same truncation on both sides. Comparing full-precision
  // created_at against a millisecond cursor skips same-millisecond rows that sort after the
  // cursor row but share its encoded millisecond.
  const cursorPredicate = cursorValue
    ? sql`(date_trunc('milliseconds', ${checkTasks.createdAt}), ${checkTasks.id}) < (date_trunc('milliseconds', ${cursorValue.createdAt}::timestamptz), ${cursorValue.id}::uuid)`
    : undefined;
  const where = and(ne(orderCases.phase, "CLOSED"), scopePredicate, cursorPredicate);
  const db = getDb();
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .where(and(ne(orderCases.phase, "CLOSED"), scopePredicate));
  const total = countRow?.count ?? 0;
  // Fetch one extra row to detect a following page without OFFSET; stable keyset order on
  // (date_trunc('milliseconds', created_at), id), matching the cursor predicate exactly.
  const rows = await db.select({ task: checkTasks, line: shortPickLines, case: orderCases })
    .from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .where(where)
    .orderBy(desc(sql`date_trunc('milliseconds', ${checkTasks.createdAt})`), desc(checkTasks.id)).limit(parsed.limit + 1);
  const page = rows.slice(0, parsed.limit);
  const last = page.length === parsed.limit && rows.length > parsed.limit ? page[page.length - 1] : null;
  const items = page.map((row) => ({ ...row.task, orderNumber: row.case.orderNumber, caseId: row.case.id, casePhase: row.case.phase,
    location: row.line.originalLocation, sku: row.line.sku, quantity: row.line.missingQuantity, lineId: row.line.id }));
  const nextCursor = last ? encodeCheckCursor({ createdAt: last.task.createdAt!.toISOString(), id: last.task.id }) : null;
  return { items, nextCursor, total };
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
    const configuration = await getCurrentConfiguration(tx);
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

export async function assignCheck(auth: AuthContext, taskId: string, userId: string, options: { pickerRetrieval?: boolean } = {}) {
  const pickerRetrieval = options.pickerRetrieval === true;
  const caseId = await taskCaseId(taskId);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const configuration = await getCurrentConfiguration(tx);
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
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType, details: { taskId, assignedToUserId: userId, previousUserId: task.assignedToUserId ?? task.claimedByUserId, pickerRetrieval } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: eventType, details: { caseId, lineId: line.id, taskId, userId, pickerRetrieval } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId,
      shortPickLineId: line.id, payload: { taskId, orderNumber: record.orderNumber, reassigned: isReassignment, pickerRetrieval } });
    return { taskId, caseId, lineId: line.id, status: "ASSIGNED" as const, assignedToUserId: userId, pickerRetrieval };
  });
}

export const discoveredLocationSchema = z.object({
  location: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
  note: z.string().trim().max(500).default(""),
});

export async function reportDiscoveredLocation(auth: AuthContext, caseId: string, lineId: string, input: z.infer<typeof discoveredLocationSchema>) {
  if (!hasAuthPermission(auth, "REPORT_NEW_LOCATION")) throw new CaseApiError("CHECK_RESULT_FORBIDDEN", "Reporting a new location requires the location grant", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
    if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    if (line.state === "RESOLVED" || line.state === "CANCELLED") throw new CaseApiError("CHECK_RESULT_FORBIDDEN", "Location cannot be reported on a terminal line", 409);
    if (input.location === line.originalLocation) throw new CaseApiError("CHECK_RESULT_FORBIDDEN", "A discovered location must differ from the original location", 400);
    const now = new Date();
    const [activeCheck] = await tx.select().from(checkTasks).where(and(eq(checkTasks.shortPickLineId, lineId), ne(checkTasks.status, "COMPLETED"))).for("update").limit(1);
    let reconciledTaskId: string | null = null;
    if (activeCheck) {
      reconciledTaskId = activeCheck.id;
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "FOUND", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, activeCheck.id));
    }
    const [stagedResponsible] = record.phase === "STAGED" && record.currentCaseResponsibleUserId
      ? await tx.select({ id: users.id, role: users.role, permissions: users.permissions }).from(users).where(and(eq(users.id, record.currentCaseResponsibleUserId), eq(users.status, "ACTIVE"))).limit(1)
      : [];
    const ownerFromPhase = record.phase === "PICKING" ? record.pickingUserId
      : stagedResponsible?.role === "TROUBLESHOOTER" && stagedResponsible.permissions.includes("CONFIRM_RETRIEVAL") ? stagedResponsible.id : null;
    await tx.update(shortPickLines).set({
      state: "FOUND", currentResponsibleUserId: ownerFromPhase,
      discoveredLocation: input.location, discoveredByUserId: auth.user.id, discoveredAt: now,
      retrievalState: "PENDING", retrievalResponsibleUserId: ownerFromPhase, updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, lineId));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "NEW_LOCATION_REPORTED",
      details: { location: input.location, note: input.note || null, reconciledTaskId, externalResolution: true, casePhase: record.phase } });
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED",
      details: { responsibleUserId: ownerFromPhase, casePhase: record.phase, source: "DISCOVERED_LOCATION" } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "DISCOVERED_LOCATION_REPORTED",
      details: { caseId, lineId, location: input.location, reconciledTaskId, responsibleUserId: ownerFromPhase } });
    if (ownerFromPhase) {
      await insertResponsibilityNotification(tx, { recipientUserId: ownerFromPhase, type: "RESPONSIBILITY_NEW_LOCATION",
        caseId, shortPickLineId: lineId, payload: { orderNumber: record.orderNumber, discoveredLocation: input.location, finderUserId: auth.user.id } });
    }
    await insertMonitoringNotifications(tx, { type: "NEW_LOCATION", caseId, shortPickLineId: lineId,
      payload: { orderNumber: record.orderNumber, discoveredLocation: input.location }, excludeUserId: auth.user.id });
    return { caseId, lineId, location: input.location, reconciledTaskId, retrievalResponsibleUserId: ownerFromPhase };
  });
}

export async function completeCheck(auth: AuthContext, taskId: string, input: z.infer<typeof completeCheckSchema>) {
  if (!hasAuthPermission(auth, "COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot complete checks", 403);
  const caseId = await taskCaseId(taskId);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    // Completion-time workflow settings (allowed resolution codes, checker retrieval routing)
    // are pinned to the case snapshot; operational claim/capacity controls use current config.
    const snapshot = await getConfigurationVersion(tx, record.configurationVersionId);
    if (snapshot && !snapshot.values.ALLOWED_RESOLUTION_CODES.includes(input.code)) throw new CaseApiError("CASE_ACCESS_DENIED", "This resolution code is disabled", 400);
    const [task] = await tx.select().from(checkTasks).where(eq(checkTasks.id, taskId)).for("update").limit(1);
    if (!task || !["CLAIMED", "ASSIGNED"].includes(task.status)) throw new CaseApiError("CHECK_NOT_AVAILABLE", "Check is not active", 409);
    if ((task.assignedToUserId ?? task.claimedByUserId) !== auth.user.id) throw new CaseApiError("CASE_ACCESS_DENIED", "This check belongs to another worker", 403);
    const [line] = await tx.select().from(shortPickLines).where(eq(shortPickLines.id, task.shortPickLineId)).limit(1);
    if (!line || line.state !== "CHECKING") throw new CaseApiError("CHECK_NOT_AVAILABLE", "Line is not being checked", 409);
    if (input.code === "FOUND" && input.discoveredLocation === line.originalLocation) {
      throw new CaseApiError("CASE_ACCESS_DENIED", "A new location must differ from the original location; use FOUND_AT_ORIGINAL instead", 400);
    }
    const now = new Date();
    await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: input.code, completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, taskId));
    const found = input.code === "FOUND" || input.code === "FOUND_AT_ORIGINAL";
    const foundAtOriginal = input.code === "FOUND_AT_ORIGINAL";
    const [stagedCaseResponsible] = record.phase === "STAGED" && record.currentCaseResponsibleUserId
      ? await tx.select({ id: users.id, role: users.role, permissions: users.permissions }).from(users).where(and(eq(users.id, record.currentCaseResponsibleUserId), eq(users.status, "ACTIVE"))).limit(1)
      : [];
    const [stagedChecker] = record.phase === "STAGED" && (task.assignedToUserId ?? task.claimedByUserId)
      ? await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.id, task.assignedToUserId ?? task.claimedByUserId!)).limit(1)
      : [];
    const stagedResponsible = stagedCaseResponsible?.role === "TROUBLESHOOTER" && stagedCaseResponsible.permissions.includes("CONFIRM_RETRIEVAL") ? stagedCaseResponsible.id
      : stagedChecker?.permissions.includes("CONFIRM_RETRIEVAL") ? stagedChecker.id : null;
    // Assign-time picker-retrieval choice (additive event-details flag): when the latest
    // CHECK_ASSIGNED/CHECK_REASSIGNED for this task requested picker retrieval, route the
    // resulting retrieval ownership to the case picker. Absence of the flag keeps current behavior.
    const [assignChoice] = await tx.select({ details: caseEvents.details }).from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.shortPickLineId, line.id), inArray(caseEvents.eventType, ["CHECK_ASSIGNED", "CHECK_REASSIGNED"])))
      .orderBy(sql`${caseEvents.createdAt} DESC`);
    const assignDetails = assignChoice?.details && typeof assignChoice.details === "object" && !Array.isArray(assignChoice.details) ? assignChoice.details as Record<string, unknown> : {};
    const pickerRetrieval = assignDetails.pickerRetrieval === true && (assignDetails.taskId === undefined || assignDetails.taskId === taskId);
    const checkerUserId = task.assignedToUserId ?? task.claimedByUserId;
    const [pickingChecker] = record.phase === "PICKING" && snapshot?.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED && checkerUserId
      ? await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(and(eq(users.id, checkerUserId), eq(users.status, "ACTIVE"))).limit(1)
      : [];
    const pickingResponsible = pickingChecker?.permissions.includes("CONFIRM_RETRIEVAL") ? pickingChecker.id : record.pickingUserId;
    const retrievalUserId = found ? (pickerRetrieval ? record.pickingUserId : record.phase === "PICKING" ? pickingResponsible : snapshot?.values.CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED ? stagedResponsible : null) : null;
    await tx.update(shortPickLines).set({
      state: found ? "FOUND" : "OPEN", currentResponsibleUserId: retrievalUserId,
      discoveredLocation: input.code === "FOUND" ? input.discoveredLocation ?? null : null,
      discoveredByUserId: found ? auth.user.id : null,
      discoveredAt: found ? now : null, retrievalState: found ? "PENDING" : "NOT_REQUIRED",
      retrievalResponsibleUserId: retrievalUserId, updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, line.id));
    await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "CHECK_COMPLETED", details: { taskId, code: input.code, pickerRetrieval } });
    if (foundAtOriginal) {
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "FOUND_AT_ORIGINAL_VERIFIED", details: { taskId, originalLocation: line.originalLocation } });
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "RETRIEVAL_ASSIGNED", details: { responsibleUserId: retrievalUserId, casePhase: record.phase } });
      if (retrievalUserId) await insertResponsibilityNotification(tx, { recipientUserId: retrievalUserId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED",
        caseId, shortPickLineId: line.id, payload: { taskId, orderNumber: record.orderNumber, location: line.originalLocation, foundAtOriginal: true } });
    } else if (found) {
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
