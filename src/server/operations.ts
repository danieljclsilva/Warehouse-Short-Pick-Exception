import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appSettings, auditLog, caseEvents, caseMessages, checkTasks, orderCases, shortPickLines, users } from "@/db/schema";
import { addLineSchema, CaseApiError, createCaseSchema, getCaseForUser, hasCurrentCaseResponsibility, normalizeOrderNumber } from "@/server/cases";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { insertMonitoringNotifications, insertResponsibilityNotification } from "@/server/notifications";

const activePhase = ne(orderCases.phase, "CLOSED");
const terminalStates = new Set(["RESOLVED", "CANCELLED"]);

export const manualCaseSchema = z.object({
  orderNumber: createCaseSchema.shape.orderNumber,
  firstLine: addLineSchema.omit({ confirmDuplicate: true }),
  originalPickerUserId: z.uuid().optional(),
  reason: z.string().trim().min(1).max(500).default("PHYSICAL_HOLD_WITHOUT_DIGITAL_REPORT"),
  confirmedHistoricalCaseIds: z.array(z.uuid()).max(1000).default([]),
});
export const messageSchema = z.object({ message: z.string().trim().min(1).max(2000), lineId: z.uuid().optional() });
export const closeCaseSchema = z.object({ administrativeResolutionReason: z.string().trim().min(5).max(500).optional() });
export const reopenCaseSchema = z.object({ phase: z.enum(["PICKING", "STAGED"]), responsibleUserId: z.uuid(), lineIds: z.array(z.uuid()).min(1).max(100) });
export const caseResponsibilitySchema = z.object({ userId: z.uuid() });

function requireManager(auth: AuthContext) {
  if (!hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "Manager access required", 403);
}

export async function getOperationsDashboard(auth: AuthContext) {
  requireManager(auth);
  const db = getDb();
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const [setting] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "DASHBOARD_ATTENTION_CRITICAL_MINUTES")).limit(1);
  const threshold = typeof setting?.value === "number" && Number.isFinite(setting.value) && setting.value > 0 ? setting.value : 15;
  const rows = await db.select().from(orderCases).where(activePhase).orderBy(orderCases.createdAt).limit(500);
  const closedRows = await db.select().from(orderCases).where(eq(orderCases.phase, "CLOSED")).orderBy(desc(orderCases.resolvedAt)).limit(50);
  const ids = rows.map((row) => row.id);
  const lines = ids.length ? await db.select().from(shortPickLines).where(inArray(shortPickLines.caseId, ids)) : [];
  const userIds = [...new Set([...rows, ...closedRows].flatMap((row) => [row.pickingUserId, row.currentCaseResponsibleUserId]).filter((id): id is string => Boolean(id)))];
  const people = userIds.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, userIds)) : [];
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const byCase = new Map<string, typeof lines>();
  for (const line of lines) byCase.set(line.caseId, [...(byCase.get(line.caseId) ?? []), line]);
  const cases = rows.map((row) => {
    const ownLines = byCase.get(row.id) ?? [];
    const missingCount = ownLines.filter((line) => !terminalStates.has(line.state)).reduce((total, line) => total + line.missingQuantity, 0);
    const checkingCount = ownLines.filter((line) => line.state === "CHECKING").length;
    const currentIssue = ownLines.some((line) => line.retrievalState === "FAILED") ? "RETRIEVAL_FAILED"
      : ownLines.some((line) => line.state === "FOUND") ? "RETRIEVAL_PENDING"
        : checkingCount ? "CHECKING" : missingCount ? "OPEN" : "READY_TO_CLOSE";
    return { ...row, pickerName: row.pickingUserId ? names.get(row.pickingUserId) ?? null : null,
      responsibleName: row.currentCaseResponsibleUserId ? names.get(row.currentCaseResponsibleUserId) ?? null : null,
      missingCount, checkingCount, currentIssue,
      lines: ownLines.map((line) => ({ ...line, location: line.originalLocation, quantity: line.missingQuantity })) };
  });
  const [resolved] = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(and(eq(orderCases.phase, "CLOSED"), gte(orderCases.resolvedAt, today)));
  return { metrics: {
    openCases: cases.length,
    openShortPicks: cases.reduce((total, item) => total + item.missingCount, 0),
    checking: cases.reduce((total, item) => total + item.checkingCount, 0),
    staged: cases.filter((item) => item.phase === "STAGED").length,
    overThreshold: cases.filter((item) => now.getTime() - item.createdAt.getTime() >= threshold * 60_000).length,
    resolvedToday: resolved?.count ?? 0,
  }, attentionThresholdMinutes: threshold, cases,
    recentClosedCases: closedRows.map((row) => ({
      id: row.id, orderNumber: row.orderNumber, phase: "CLOSED" as const, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
      pickerName: row.pickingUserId ? names.get(row.pickingUserId) ?? null : null,
      responsibleName: row.currentCaseResponsibleUserId ? names.get(row.currentCaseResponsibleUserId) ?? null : null,
    })) };
}

export async function createManualCase(auth: AuthContext, input: z.infer<typeof manualCaseSchema>) {
  if (!hasAuthPermission(auth, "CREATE_CASE_ON_BEHALF") || !["TEAM_LEADER", "ASSISTANT", "ADMIN"].includes(auth.user.role)) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot create a manual case", 403);
  const orderNumber = normalizeOrderNumber(input.orderNumber);
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${orderNumber}`}))`);
    const [open] = await tx.select({ id: orderCases.id }).from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), activePhase)).limit(1);
    if (open) return { kind: "OPEN_EXISTS" as const, id: open.id };
    const history = await tx.select({ id: orderCases.id, createdAt: orderCases.createdAt, phase: orderCases.phase }).from(orderCases).where(eq(orderCases.orderNumber, orderNumber)).orderBy(desc(orderCases.createdAt));
    const expected = history.map((row) => row.id).sort();
    const confirmed = [...new Set(input.confirmedHistoricalCaseIds)].sort();
    if (expected.length !== confirmed.length || expected.some((id, index) => id !== confirmed[index])) return { kind: "HISTORY" as const, history };
    if (input.originalPickerUserId) {
      const [picker] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.originalPickerUserId), eq(users.role, "PICKER"), eq(users.status, "ACTIVE"))).limit(1);
      if (!picker) throw new CaseApiError("CASE_ACCESS_DENIED", "Original picker must be an active picker", 400);
    }
    const [setting] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "SHORT_PICK_HOLD_LOCATION")).limit(1);
    const physicalLocation = typeof setting?.value === "string" && setting.value.trim() ? setting.value.trim() : "SHORT PICK / HOLD";
    const source = auth.user.role === "ADMIN" ? "ADMIN_MANUAL" : auth.user.role === "TEAM_LEADER" ? "TL_MANUAL" : "ASSISTANT_MANUAL";
    const [record] = await tx.insert(orderCases).values({ orderNumber, phase: "STAGED", physicalState: "SHORT_PICK_HOLD", physicalLocation,
      stagedAt: new Date(), pickingUserId: input.originalPickerUserId ?? null, currentCaseResponsibleUserId: auth.user.id,
      createdByUserId: auth.user.id, source, manualReason: input.reason }).returning({ id: orderCases.id });
    const [line] = await tx.insert(shortPickLines).values({ caseId: record!.id, originalLocation: input.firstLine.location, sku: input.firstLine.sku,
      missingQuantity: input.firstLine.quantity, reportedByUserId: auth.user.id }).returning({ id: shortPickLines.id });
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.insert(caseEvents).values({ caseId: record!.id, actorUserId: auth.user.id, eventType: "CASE_CREATED", details: { orderNumber, source, reason: input.reason, originalPickerUserId: input.originalPickerUserId ?? null } });
    await tx.insert(caseEvents).values({ caseId: record!.id, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: "SHORT_PICK_LINE_ADDED", details: { location: input.firstLine.location, sku: input.firstLine.sku, quantity: input.firstLine.quantity } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_CREATED", details: { caseId: record!.id, source, reason: input.reason } });
    await insertMonitoringNotifications(tx, { type: "NEW_SHORT_PICK", caseId: record!.id, shortPickLineId: line!.id,
      payload: { orderNumber, location: input.firstLine.location, sku: input.firstLine.sku, quantity: input.firstLine.quantity }, excludeUserId: auth.user.id });
    return { kind: "CREATED" as const, id: record!.id };
  });
  if (result.kind === "OPEN_EXISTS") throw new CaseApiError("OPEN_CASE_EXISTS", "An open case already exists", 409, { case: await getCaseForUser(auth, result.id) });
  if (result.kind === "HISTORY") throw new CaseApiError("HISTORICAL_CONFIRMATION_REQUIRED", "Confirm historical cases", 409, { history: result.history });
  return getCaseForUser(auth, result.id);
}

export async function addCaseMessage(auth: AuthContext, caseId: string, input: z.infer<typeof messageSchema>) {
  if (!hasAuthPermission(auth, "ADD_CASE_MESSAGE")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot add case messages", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    if (!hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES") && !(await hasCurrentCaseResponsibility(tx, auth, record))) {
      throw new CaseApiError("CASE_ACCESS_DENIED", "Case is not assigned to you", 403);
    }
    if (input.lineId) {
      const [line] = await tx.select({ id: shortPickLines.id }).from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    }
    const [message] = await tx.insert(caseMessages).values({ caseId, shortPickLineId: input.lineId ?? null, authorUserId: auth.user.id, message: input.message }).returning();
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: input.lineId ?? null, actorUserId: auth.user.id, eventType: "CASE_MESSAGE_ADDED", details: { messageId: message!.id } });
    await insertMonitoringNotifications(tx, { type: "TROUBLESHOOTER_MESSAGE", caseId, shortPickLineId: input.lineId ?? null,
      payload: { messageId: message!.id }, excludeUserId: auth.user.id });
    return { ...message!, authorName: auth.user.displayName };
  });
}

export async function assignCaseResponsibility(auth: AuthContext, caseId: string, userId: string) {
  if (!hasAuthPermission(auth, "ASSIGN_TROUBLESHOOTER")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot assign case responsibility", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, "ACTIVE"))).limit(1);
    if (!target || !["TROUBLESHOOTER", "TEAM_LEADER", "ASSISTANT", "ADMIN"].includes(target.role)) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee must be an active resolver", 400);
    await tx.update(orderCases).set({ currentCaseResponsibleUserId: userId, updatedAt: new Date(), version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "RESPONSIBILITY_CHANGED", details: { previousUserId: record.currentCaseResponsibleUserId, responsibleUserId: userId } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "RESPONSIBILITY_CHANGED", details: { caseId, previousUserId: record.currentCaseResponsibleUserId, userId } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_CASE_ASSIGNED", caseId,
      payload: { orderNumber: record.orderNumber, previousUserId: record.currentCaseResponsibleUserId } });
    return { caseId, responsibleUserId: userId };
  });
}

export async function closeCase(auth: AuthContext, caseId: string, input: z.infer<typeof closeCaseSchema>) {
  if (!hasAuthPermission(auth, "RESOLVE_CASE")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot close cases", 403);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed or missing", 409);
    const manager = hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES");
    const responsible = record.currentCaseResponsibleUserId === auth.user.id || record.pickingUserId === auth.user.id;
    if (!manager && !responsible) throw new CaseApiError("CASE_ACCESS_DENIED", "Case is not your responsibility", 403);
    if (input.administrativeResolutionReason && !manager) throw new CaseApiError("CASE_ACCESS_DENIED", "Administrative closure requires manager access", 403);
    const lines = await tx.select().from(shortPickLines).where(eq(shortPickLines.caseId, caseId));
    const unresolved = lines.filter((line) => !terminalStates.has(line.state));
    if (unresolved.length && !input.administrativeResolutionReason) throw new CaseApiError("CASE_NOT_CLOSABLE", "Resolve every line or provide an administrative resolution", 409, { unresolvedLineIds: unresolved.map((line) => line.id) });
    const now = new Date();
    if (unresolved.length) {
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` })
        .where(and(inArray(checkTasks.shortPickLineId, unresolved.map((line) => line.id)), ne(checkTasks.status, "COMPLETED")));
      await tx.update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED", currentResponsibleUserId: null, resolutionCode: "ADMINISTRATIVE", resolvedAt: now, updatedAt: now, version: sql`${shortPickLines.version} + 1` })
        .where(inArray(shortPickLines.id, unresolved.map((line) => line.id)));
      for (const line of unresolved) await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "SHORT_PICK_LINE_ADMINISTRATIVELY_RESOLVED", details: { reason: input.administrativeResolutionReason } });
    }
    await tx.update(orderCases).set({ phase: "CLOSED", resolvedAt: now, resolvedByUserId: auth.user.id, currentCaseResponsibleUserId: auth.user.id, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "CASE_CLOSED", details: { administrativeResolutionReason: input.administrativeResolutionReason ?? null } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_CLOSED", details: { caseId, administrativeResolutionReason: input.administrativeResolutionReason ?? null } });
    await insertMonitoringNotifications(tx, { type: "CASE_RESOLVED", caseId,
      payload: { orderNumber: record.orderNumber, administrative: Boolean(input.administrativeResolutionReason) }, excludeUserId: auth.user.id });
    return { caseId, phase: "CLOSED" as const };
  });
}

export async function reopenCase(auth: AuthContext, caseId: string, input: z.infer<typeof reopenCaseSchema>) {
  if (!hasAuthPermission(auth, "REOPEN_CASE") || !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot reopen cases", 403);
  const result = await getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record || record.phase !== "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is not closed", 409);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${record.orderNumber}`}))`);
    const [another] = await tx.select({ id: orderCases.id }).from(orderCases).where(and(eq(orderCases.orderNumber, record.orderNumber), activePhase)).limit(1);
    if (another) throw new CaseApiError("CASE_REOPEN_CONFLICT", "Another active case exists for this order", 409, { activeCaseId: another.id });
    const [target] = await tx.select().from(users).where(and(eq(users.id, input.responsibleUserId), eq(users.status, "ACTIVE"))).limit(1);
    if (!target) throw new CaseApiError("CASE_ACCESS_DENIED", "Responsible user must be active", 400);
    if (input.phase === "PICKING" && target.role !== "PICKER") throw new CaseApiError("CASE_ACCESS_DENIED", "Picking responsibility requires a picker", 400);
    const lineIds = [...new Set(input.lineIds)];
    const lines = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.caseId, caseId), inArray(shortPickLines.id, lineIds)));
    if (lines.length !== lineIds.length || lines.some((line) => !terminalStates.has(line.state))) throw new CaseApiError("CASE_NOT_CLOSABLE", "Select terminal lines from this case", 400);
    const now = new Date();
    await tx.update(orderCases).set({ phase: input.phase, physicalState: input.phase === "PICKING" ? "WITH_PICKER" : "SHORT_PICK_HOLD",
      physicalLocation: input.phase === "PICKING" ? null : record.physicalLocation,
      currentCaseResponsibleUserId: input.responsibleUserId, pickingUserId: input.phase === "PICKING" ? input.responsibleUserId : record.pickingUserId,
      reopenedAt: now, resolvedAt: null, resolvedByUserId: null, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    for (const line of lines) {
      await tx.update(shortPickLines).set({ state: "OPEN", currentResponsibleUserId: null, discoveredLocation: null, discoveredByUserId: null,
        discoveredAt: null, retrievalState: "NOT_REQUIRED", retrievalResponsibleUserId: null, retrievedByUserId: null, retrievedAt: null,
        resolvedAt: null, resolutionCode: null, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await tx.insert(checkTasks).values({ shortPickLineId: line.id });
    }
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "CASE_REOPENED", details: { phase: input.phase, responsibleUserId: input.responsibleUserId, lineIds } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REOPENED", details: { caseId, lineIds, responsibleUserId: input.responsibleUserId } });
    await insertResponsibilityNotification(tx, { recipientUserId: input.responsibleUserId,
      type: "RESPONSIBILITY_CASE_REOPENED", caseId, payload: { orderNumber: record.orderNumber, phase: input.phase, lineIds } });
    return { caseId, phase: input.phase };
  });
  return result;
}
