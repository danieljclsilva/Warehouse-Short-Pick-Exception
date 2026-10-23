import { normalizeWarehouseLocation } from "@/domain/warehouse-location";
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, caseMessages, checkTasks, configurationVersions, orderCases, shortPickLines, users } from "@/db/schema";
import { addLineSchema, CaseApiError, createCaseSchema, getCaseForUser, hasCurrentCaseResponsibility, normalizeOrderNumber, projectLines } from "@/server/cases";
import { aggregateCaseDisplayStatus } from "@/domain/case-display-status";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { getConfigurationVersion, getCurrentConfiguration, normalizeConfigurationValues } from "@/server/configuration";
import { elapsedWorkingMinutes, workingHoursFromConfiguration } from "@/domain/working-hours";
import { rerouteCaseRetrievals } from "@/server/retrieval-routing";
import { insertMonitoringNotifications, insertResponsibilityNotification } from "@/server/notifications";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "@/server/pagination";

const activePhase = ne(orderCases.phase, "CLOSED");
const terminalStates = new Set(["RESOLVED", "CANCELLED"]);

export const manualCaseSchema = z.object({
  orderNumber: createCaseSchema.shape.orderNumber,
  firstLine: addLineSchema.omit({ confirmDuplicate: true }),
  originalPickerUserId: z.uuid().optional(),
  phase: z.enum(["PICKING", "STAGED"]).default("STAGED"),
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

export const operationsDashboardQuerySchema = paginationQuerySchema.extend({
  closedPage: z.coerce.number().int().min(1).max(10_000).default(1),
});

export async function getOperationsDashboard(auth: AuthContext, options: { page?: number; pageSize?: number; closedPage?: number } = {}) {
  requireManager(auth);
  const parsed = operationsDashboardQuerySchema.parse({ page: options.page ?? 1, pageSize: options.pageSize ?? 20, closedPage: options.closedPage ?? 1 });
  const db = getDb();
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const configuration = (await getCurrentConfiguration(db)).values;
  const threshold = configuration.CRITICAL_THRESHOLD_MINUTES;
  const [openCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(activePhase);
  const openTotal = openCountRow?.count ?? 0;
  const rows = await db.select().from(orderCases).where(activePhase).orderBy(orderCases.createdAt).limit(parsed.pageSize).offset(paginationOffset(parsed.page, parsed.pageSize));
  const [closedCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(eq(orderCases.phase, "CLOSED"));
  const closedTotal = closedCountRow?.count ?? 0;
  const closedRows = await db.select().from(orderCases).where(eq(orderCases.phase, "CLOSED")).orderBy(desc(orderCases.resolvedAt)).limit(parsed.pageSize).offset(paginationOffset(parsed.closedPage, parsed.pageSize));
  const configurationVersionIds = [...new Set([...rows, ...closedRows].map((row) => row.configurationVersionId))];
  const versionRows = configurationVersionIds.length
    ? await db.select({ id: configurationVersions.id, values: configurationVersions.values }).from(configurationVersions).where(inArray(configurationVersions.id, configurationVersionIds))
    : [];
  const caseConfigurations = new Map(versionRows.map((row) => [row.id, normalizeConfigurationValues(row.values)]));
  const ids = rows.map((row) => row.id);
  const lines = ids.length ? await db.select().from(shortPickLines).where(inArray(shortPickLines.caseId, ids)) : [];
  const lineIds = lines.map((line) => line.id);
  const checks = lineIds.length ? await db.select().from(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds)) : [];
  const checksByLine = new Map<string, typeof checks>();
  for (const check of checks) checksByLine.set(check.shortPickLineId, [...(checksByLine.get(check.shortPickLineId) ?? []), check]);
  const rawPersonIds: Array<string | null> = [];
  for (const row of [...rows, ...closedRows]) rawPersonIds.push(row.pickingUserId, row.currentCaseResponsibleUserId);
  for (const line of lines) rawPersonIds.push(line.reportedByUserId, line.currentResponsibleUserId, line.discoveredByUserId, line.retrievalResponsibleUserId, line.replenishmentActorUserId, line.replenishmentRetrieverUserId);
  for (const check of checks) rawPersonIds.push(check.claimedByUserId, check.assignedToUserId);
  const personIds = [...new Set(rawPersonIds.filter((id): id is string => Boolean(id)))];
  const people = personIds.length ? await db.select({ id: users.id, displayName: users.displayName, identifier: users.identifier }).from(users).where(inArray(users.id, personIds)) : [];
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const identifiers = new Map(people.map((person) => [person.id, person.identifier]));
  const byCase = new Map<string, typeof lines>();
  for (const line of lines) byCase.set(line.caseId, [...(byCase.get(line.caseId) ?? []), line]);
  const cases = rows.map((row) => {
    const caseConfiguration = caseConfigurations.get(row.configurationVersionId);
    if (!caseConfiguration) throw new Error(`Configuration version is missing for case ${row.id}`);
    const workingHours = workingHoursFromConfiguration(caseConfiguration);
    const ownLines = byCase.get(row.id) ?? [];
    const ownChecks = ownLines.flatMap((line) => checksByLine.get(line.id) ?? []);
    const lineProjections = projectLines({ orderNumber: row.orderNumber, phase: row.phase, lines: ownLines, checks: ownChecks, names });
    const aggregate = aggregateCaseDisplayStatus(row.phase, ownLines.map((line) => ({ id: line.id, state: line.state, retrievalState: line.retrievalState, replenishmentState: line.replenishmentState })), lineProjections);
    const currentIssue = aggregate === "WAITING_RETRIEVAL" || aggregate === "RETRIEVING" ? "RETRIEVAL_PENDING" : aggregate;
    const checkingCount = ownLines.filter((line) => line.state === "CHECKING"
      && !(line.replenishmentState === "COMPLETED" && (line.retrievalState === "PENDING" || line.retrievalState === "IN_PROGRESS" || line.retrievalState === "FAILED"))).length;
    const openLineCount = ownLines.filter((line) => !terminalStates.has(line.state)).length;
    const missingCount = ownLines.filter((line) => !terminalStates.has(line.state)).reduce((total, line) => total + line.missingQuantity, 0);
    const ageMinutes = Math.floor((now.getTime() - row.createdAt.getTime()) / 60_000);
    const elapsedWorkingMinutesValue = elapsedWorkingMinutes(row.createdAt, now, workingHours, now);
    const attentionLevel = elapsedWorkingMinutesValue >= caseConfiguration.CRITICAL_THRESHOLD_MINUTES ? "CRITICAL"
      : elapsedWorkingMinutesValue >= caseConfiguration.ATTENTION_THRESHOLD_MINUTES ? "ATTENTION"
        : elapsedWorkingMinutesValue >= caseConfiguration.WARNING_THRESHOLD_MINUTES ? "WARNING" : "NORMAL";
    return { ...row, pickerName: row.pickingUserId ? names.get(row.pickingUserId) ?? null : null,
      pickerIdentifier: row.pickingUserId ? identifiers.get(row.pickingUserId) ?? null : null,
      responsibleName: row.currentCaseResponsibleUserId ? names.get(row.currentCaseResponsibleUserId) ?? null : null,
      responsibleIdentifier: row.currentCaseResponsibleUserId ? identifiers.get(row.currentCaseResponsibleUserId) ?? null : null,
      missingCount, openLineCount, checkingCount, currentIssue, attentionLevel, ageMinutes, workingHours, elapsedWorkingMinutes: elapsedWorkingMinutesValue,
      lines: ownLines.map((line) => ({ ...line, location: line.originalLocation, quantity: line.missingQuantity,
        reporterName: names.get(line.reportedByUserId) ?? null, reporterIdentifier: identifiers.get(line.reportedByUserId) ?? null })),
      projection: { caseId: row.id, orderNumber: row.orderNumber, phase: row.phase, openLineCount, lines: lineProjections }, lineProjections };
  });
  // Global header aggregates: every count below spans ALL open cases, independent of the requested page.
  // Open lines are nonterminal shortage lines (state NOT IN RESOLVED/CANCELLED); piece quantities stay separate.
  const openLineFilter = and(activePhase, notInArray(shortPickLines.state, ["RESOLVED", "CANCELLED"]));
  // Completed replenishment preserves main CHECKING but hides it from the check
  // queue while its retrieval obligation is PENDING/IN_PROGRESS/FAILED.
  const guardedCheckingFilter = and(openLineFilter, eq(shortPickLines.state, "CHECKING"),
    sql`not (${shortPickLines.replenishmentState} = 'COMPLETED' and ${shortPickLines.retrievalState} in ('PENDING', 'IN_PROGRESS', 'FAILED'))`);
  // Pinned-threshold fallback mirrors normalizeConfigurationValues: stored rows merge over
  // CONFIGURATION_DEFAULTS, so a missing/non-numeric CRITICAL_THRESHOLD_MINUTES reads as the default (15).
  const [[resolved], [globalOpenLines], [globalChecking], [globalStaged], [globalMissing]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(and(eq(orderCases.phase, "CLOSED"), gte(orderCases.resolvedAt, today))),
    db.select({ count: sql<number>`count(*)::int` }).from(shortPickLines).innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id)).where(openLineFilter),
    db.select({ count: sql<number>`count(*)::int` }).from(shortPickLines).innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id)).where(guardedCheckingFilter),
    db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(eq(orderCases.phase, "STAGED")),
    db.select({ total: sql<number>`coalesce(sum(${shortPickLines.missingQuantity})::int, 0)` }).from(shortPickLines).innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id)).where(openLineFilter),
  ]);
  // Working-clock over-threshold spans ALL open cases with each case's pinned
  // schedule: minimal id/createdAt/config join counted in JS (no lines/messages).
  const overThresholdRows = await db.select({ id: orderCases.id, createdAt: orderCases.createdAt, values: configurationVersions.values })
    .from(orderCases).innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id)).where(activePhase);
  let globalOverThresholdCount = 0;
  for (const candidate of overThresholdRows) {
    const candidateConfig = normalizeConfigurationValues(candidate.values);
    if (elapsedWorkingMinutes(candidate.createdAt, now, workingHoursFromConfiguration(candidateConfig), now) >= candidateConfig.CRITICAL_THRESHOLD_MINUTES) globalOverThresholdCount += 1;
  }
  const resolvedToday = resolved?.count ?? 0;
  const summary = { openCases: openTotal, openLines: globalOpenLines?.count ?? 0, checking: globalChecking?.count ?? 0,
    staged: globalStaged?.count ?? 0, overThreshold: globalOverThresholdCount, resolvedToday,
    openMissingQuantity: globalMissing?.total ?? 0 };
  const closedSchedules = new Map(versionRows.map((row) => [row.id, workingHoursFromConfiguration(row.values)]));
  return { metrics: {
    openCases: openTotal,
    openShortPicks: summary.openLines,
    openMissingQuantity: summary.openMissingQuantity,
    checking: summary.checking,
    staged: summary.staged,
    overThreshold: summary.overThreshold,
    resolvedToday: summary.resolvedToday,
  }, summary, attentionThresholdMinutes: threshold, thresholds: { warning: configuration.WARNING_THRESHOLD_MINUTES, attention: configuration.ATTENTION_THRESHOLD_MINUTES, critical: configuration.CRITICAL_THRESHOLD_MINUTES }, cases,
    ...paginationMeta(openTotal, parsed.page, parsed.pageSize),
    recentClosedCases: closedRows.map((row) => { const workingHours = closedSchedules.get(row.configurationVersionId) ?? workingHoursFromConfiguration(null);
      return {
        id: row.id, orderNumber: row.orderNumber, phase: "CLOSED" as const, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
        pickerName: row.pickingUserId ? names.get(row.pickingUserId) ?? null : null,
        responsibleName: row.currentCaseResponsibleUserId ? names.get(row.currentCaseResponsibleUserId) ?? null : null,
        workingHours, elapsedWorkingMinutes: elapsedWorkingMinutes(row.createdAt, row.resolvedAt ?? now, workingHours, now),
      }; }),
    closedPagination: paginationMeta(closedTotal, parsed.closedPage, parsed.pageSize) };
}

export async function createManualCase(auth: AuthContext, input: z.infer<typeof manualCaseSchema>) {
  if (!hasAuthPermission(auth, "CREATE_CASE_ON_BEHALF") || !["TEAM_LEADER", "MANAGER", "ASSISTANT", "ADMIN"].includes(auth.user.role)) throw new CaseApiError("CASE_ACCESS_DENIED", "Cannot create a manual case", 403);
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
      const [picker] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.originalPickerUserId), inArray(users.role, ["PICKER", "TROUBLESHOOTER"]), eq(users.status, "ACTIVE"))).limit(1);
      if (!picker) throw new CaseApiError("CASE_ACCESS_DENIED", "Original picker must be an active picker", 400);
    }
    const configuration = await getCurrentConfiguration(tx);
    if (!configuration.values.MANUAL_CASE_CREATION_ENABLED) throw new CaseApiError("CASE_ACCESS_DENIED", "Manual case creation is disabled", 403);
    const physicalLocation = configuration.values.SHORT_PICK_HOLD_LOCATION_NAME;
    const source = auth.user.role === "ADMIN" ? "ADMIN_MANUAL" : auth.user.role === "MANAGER" ? "MANAGER_MANUAL" : auth.user.role === "TEAM_LEADER" ? "TL_MANUAL" : "ASSISTANT_MANUAL";
    const phase = input.phase === "PICKING" ? "PICKING" as const : "STAGED" as const;
    const [record] = await tx.insert(orderCases).values({ orderNumber, phase, physicalState: phase === "STAGED" ? "SHORT_PICK_HOLD" : "WITH_PICKER", physicalLocation: phase === "STAGED" ? physicalLocation : null,
      stagedAt: phase === "STAGED" ? new Date() : null, pickingUserId: input.originalPickerUserId ?? null, currentCaseResponsibleUserId: auth.user.id,
      createdByUserId: auth.user.id, source, manualReason: input.reason, configurationVersionId: configuration.id }).returning({ id: orderCases.id });
    const [line] = await tx.insert(shortPickLines).values({ caseId: record!.id, originalLocation: input.firstLine.location, sku: input.firstLine.sku,
      missingQuantity: input.firstLine.quantity, reportedByUserId: auth.user.id }).returning({ id: shortPickLines.id });
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.insert(caseEvents).values({ caseId: record!.id, actorUserId: auth.user.id, eventType: "CASE_CREATED", details: { orderNumber, source, phase, reason: input.reason, originalPickerUserId: input.originalPickerUserId ?? null } });
    await tx.insert(caseEvents).values({ caseId: record!.id, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: "SHORT_PICK_LINE_ADDED", details: { location: input.firstLine.location, sku: input.firstLine.sku, quantity: input.firstLine.quantity } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_CREATED", details: { caseId: record!.id, source, phase, reason: input.reason } });
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
    if (record.phase === "CLOSED") throw new CaseApiError("CASE_MESSAGE_CLOSED", "This case is closed and no longer accepts messages", 409);
    const isManager = hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES");
    const isPickerParticipant = record.pickingUserId === auth.user.id && hasAuthPermission(auth, "VIEW_OWN_CASES");
    if (!isManager && !isPickerParticipant && !(await hasCurrentCaseResponsibility(tx, auth, record))) {
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
    if (!target || !["TROUBLESHOOTER", "TEAM_LEADER", "MANAGER", "ASSISTANT", "ADMIN"].includes(target.role)) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee must be an active resolver", 400);
    const persisted = { ...record, currentCaseResponsibleUserId: userId, updatedAt: new Date() };
    await tx.update(orderCases).set({ currentCaseResponsibleUserId: userId, updatedAt: persisted.updatedAt, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "RESPONSIBILITY_CHANGED", details: { previousUserId: record.currentCaseResponsibleUserId, responsibleUserId: userId } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "RESPONSIBILITY_CHANGED", details: { caseId, previousUserId: record.currentCaseResponsibleUserId, userId } });
    await insertResponsibilityNotification(tx, { recipientUserId: userId, type: "RESPONSIBILITY_CASE_ASSIGNED", caseId,
      payload: { orderNumber: record.orderNumber, previousUserId: record.currentCaseResponsibleUserId } });
    // STAGED resolver transfer re-derives pending/failed retrieval ownership via the
    // shared helper (same transaction). PICKING stays picker-governed and terminal or
    // already-retrieved obligations are never touched; the helper notifies new owners.
    if (persisted.phase === "STAGED") {
      await rerouteCaseRetrievals(tx, { caseRecord: persisted, actorUserId: auth.user.id, reason: "CASE_RESPONSIBILITY_CHANGED", preserveEligibleManualOwner: false });
    }
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
        replenishmentState: "NONE", replenishmentNote: null, replenishmentActorUserId: null, replenishmentAt: null, replenishmentRetrieverUserId: null,
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

export const overrideCaseSchema = z.object({
  command: z.enum(["RETRY_BLOCKED_CLOSE", "FORCE_RESOLVE_LINE", "RELEASE_STALE_CHECK", "REDERIVE_RETRIEVAL_ROUTING"]),
  reason: z.string().trim().min(5, "A reason of at least 5 characters is required").max(500),
  lineId: z.uuid().optional(),
  administrativeResolutionReason: z.string().trim().min(5, "A reason of at least 5 characters is required").max(500).optional(),
});

const lineStateValues = ["OPEN", "CHECKING", "FOUND", "RETRIEVING", "RESOLVED", "CANCELLED"] as const;
const retrievalStateValues = ["NOT_REQUIRED", "PENDING", "IN_PROGRESS", "RETRIEVED", "FAILED"] as const;

export const repairCaseSchema = z.object({
  command: z.enum(["CORRECT_PHASE", "REASSIGN_CHECK", "RELEASE_CHECK", "CHANGE_RETRIEVAL_OWNER", "CORRECT_LOCATION", "CANCEL_LINE", "REOPEN_LINE", "CLOSE_CASE", "REOPEN_CASE"]),
  reason: z.string().trim().min(5, "A reason of at least 5 characters is required").max(500),
  preview: z.boolean().default(false),
  lineId: z.uuid().optional(),
  phase: z.enum(["PICKING", "STAGED", "CLOSED"]).optional(),
  physicalState: z.enum(["WITH_PICKER", "SHORT_PICK_HOLD", "OTHER_KNOWN_LOCATION", "UNKNOWN"]).optional(),
  physicalLocation: z.string().trim().max(128).nullable().optional(),
  userId: z.uuid().optional(),
  location: z.string().trim().min(1).max(128).transform(normalizeWarehouseLocation).optional(),
  discoveredLocation: z.string().trim().max(128).transform(normalizeWarehouseLocation).nullable().optional(),
  lineState: z.enum(lineStateValues).optional(),
  retrievalState: z.enum(retrievalStateValues).optional(),
  responsibleUserId: z.uuid().optional(),
});

function requireOverride(auth: AuthContext) {
  if (!hasAuthPermission(auth, "OVERRIDE_CASE_STATE")) throw new CaseApiError("CASE_ACCESS_DENIED", "Stuck-state override requires the override grant", 403);
}

function requireRepair(auth: AuthContext) {
  if (!hasAuthPermission(auth, "REPAIR_CASE_DATA")) throw new CaseApiError("CASE_ACCESS_DENIED", "Case repair requires the Admin repair grant", 403);
}

function requireRepairReason(reason: string | undefined) {
  if (!reason || reason.trim().length < 5) throw new CaseApiError("REPAIR_REASON_REQUIRED", "A reason of at least 5 characters is required", 400);
}

async function assertNoOpenCaseConflict(tx: Pick<ReturnType<typeof getDb>, "select">, orderNumber: string, excludeCaseId: string) {
  const [conflict] = await tx.select({ id: orderCases.id }).from(orderCases)
    .where(and(eq(orderCases.orderNumber, orderNumber), activePhase, ne(orderCases.id, excludeCaseId))).limit(1);
  if (conflict) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Another open case exists for this order", 409, { activeCaseId: conflict.id });
}

async function assertNoActiveCheckConflict(tx: Pick<ReturnType<typeof getDb>, "select">, lineId: string) {
  const [active] = await tx.select({ id: checkTasks.id }).from(checkTasks)
    .where(and(eq(checkTasks.shortPickLineId, lineId), ne(checkTasks.status, "COMPLETED"))).limit(1);
  if (active) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "An active check already exists for this line", 409, { lineId });
}

export async function overrideCaseState(auth: AuthContext, caseId: string, input: z.infer<typeof overrideCaseSchema>) {
  requireOverride(auth);
  requireRepairReason(input.reason);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${record.orderNumber}`}))`);
    const now = new Date();
    if (input.command === "RETRY_BLOCKED_CLOSE") {
      if (record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is already closed", 409);
      if (!input.administrativeResolutionReason) throw new CaseApiError("REPAIR_REASON_REQUIRED", "An administrative resolution is required to retry a blocked close", 400);
      const before = { phase: record.phase };
      const lines = await tx.select().from(shortPickLines).where(eq(shortPickLines.caseId, caseId)).for("update");
      const unresolved = lines.filter((line) => !terminalStates.has(line.state));
      if (!unresolved.length) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "No blocked lines remain on this case", 409);
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` })
        .where(and(inArray(checkTasks.shortPickLineId, unresolved.map((line) => line.id)), ne(checkTasks.status, "COMPLETED")));
      await tx.update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED", currentResponsibleUserId: null, resolutionCode: "ADMINISTRATIVE", resolvedAt: now, updatedAt: now, version: sql`${shortPickLines.version} + 1` })
        .where(inArray(shortPickLines.id, unresolved.map((line) => line.id)));
      await tx.update(orderCases).set({ phase: "CLOSED", resolvedAt: now, resolvedByUserId: auth.user.id, currentCaseResponsibleUserId: auth.user.id, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
      await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "CASE_REPAIRED",
        details: { command: input.command, reason: input.reason, before, after: { phase: "CLOSED" }, resolvedLineIds: unresolved.map((line) => line.id), administrativeResolutionReason: input.administrativeResolutionReason } });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REPAIRED",
        details: { caseId, command: input.command, reason: input.reason, before, after: { phase: "CLOSED" } } });
      return { caseId, command: input.command, phase: "CLOSED" as const };
    }
    if (input.command === "FORCE_RESOLVE_LINE") {
      if (!input.lineId) throw new CaseApiError("CASE_NOT_FOUND", "A line is required to force-resolve", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      if (terminalStates.has(line.state)) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Line is already terminal", 409);
      const before = { lineId: line.id, state: line.state };
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` })
        .where(and(eq(checkTasks.shortPickLineId, line.id), ne(checkTasks.status, "COMPLETED")));
      await tx.update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED", currentResponsibleUserId: null, resolutionCode: "ADMINISTRATIVE", resolvedAt: now, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "CASE_REPAIRED",
        details: { command: input.command, reason: input.reason, before, after: { lineId: line.id, state: "CANCELLED" } } });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REPAIRED",
        details: { caseId, command: input.command, reason: input.reason, before, after: { lineId: line.id, state: "CANCELLED" } } });
      return { caseId, lineId: line.id, state: "CANCELLED" as const };
    }
    if (input.command === "RELEASE_STALE_CHECK") {
      if (!input.lineId) throw new CaseApiError("CASE_NOT_FOUND", "A line is required to release its check", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      const [stale] = await tx.select().from(checkTasks).where(and(eq(checkTasks.shortPickLineId, line.id), ne(checkTasks.status, "COMPLETED"))).for("update").limit(1);
      if (!stale) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "No active check claim to release", 409);
      const before = { taskId: stale.id, status: stale.status, lineState: line.state };
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, stale.id));
      await tx.update(shortPickLines).set({ state: "OPEN", currentResponsibleUserId: null, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await tx.insert(checkTasks).values({ shortPickLineId: line.id });
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: line.id, actorUserId: auth.user.id, eventType: "CASE_REPAIRED",
        details: { command: input.command, reason: input.reason, before, after: { taskId: stale.id, status: "COMPLETED", lineState: "OPEN" } } });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REPAIRED",
        details: { caseId, command: input.command, reason: input.reason, before, after: { taskId: stale.id, status: "COMPLETED" } } });
      return { caseId, lineId: line.id, releasedTaskId: stale.id };
    }
    if (record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is closed", 409);
    const [line] = input.lineId
      ? await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).limit(1)
      : [null];
    if (input.lineId && !line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
    const scope = input.lineId && line ? await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, line.id), eq(shortPickLines.caseId, caseId))) : null;
    const scopeBefore = { phase: record.phase, lines: (scope ?? []).map((item) => ({ lineId: item.id, retrievalResponsibleUserId: item.retrievalResponsibleUserId })) };
    // Shared re-derivation covers every pending/failed retrieval obligation under the
    // persisted phase, preserves eligible STAGED manual owners, and only emits
    // events/notifications for lines whose owner actually changes (idempotent).
    const rerouted = await rerouteCaseRetrievals(tx, { caseRecord: record, actorUserId: auth.user.id, reason: "OVERRIDE_REDERIVE",
      preserveEligibleManualOwner: true, ...(input.lineId ? { lineIds: [input.lineId] } : {}) });
    const before = input.lineId ? scopeBefore : { phase: record.phase, lines: rerouted.map((result) => ({ lineId: result.lineId, retrievalResponsibleUserId: result.previousOwnerId })) };
    const routingChanged = rerouted.some((result) => result.changed);
    if (routingChanged) {
      await tx.update(orderCases).set({ updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    }
    await tx.insert(caseEvents).values({ caseId, actorUserId: auth.user.id, eventType: "CASE_REPAIRED",
      details: { command: input.command, reason: input.reason, before, after: { phase: record.phase }, ...(input.lineId ? { lineId: input.lineId } : {}) } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REPAIRED",
      details: { caseId, command: input.command, reason: input.reason, before, after: { phase: record.phase }, ...(input.lineId ? { lineId: input.lineId } : {}) } });
    return { caseId, command: input.command, rederived: rerouted.filter((result) => result.changed).map((result) => result.lineId) };
  });
}

export async function previewRepair(auth: AuthContext, caseId: string, input: z.infer<typeof repairCaseSchema>) {
  requireRepair(auth);
  requireRepairReason(input.reason);
  const db = getDb();
  const [record] = await db.select().from(orderCases).where(eq(orderCases.id, caseId)).limit(1);
  if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
  return describeRepairConsequence(record, input);
}

function describeRepairConsequence(record: typeof orderCases.$inferSelect, input: z.infer<typeof repairCaseSchema>) {
  const consequence: Record<string, unknown> = { command: input.command, reason: input.reason, phase: record.phase, orderNumber: record.orderNumber };
  if (input.command === "CORRECT_PHASE") consequence.after = { phase: input.phase ?? record.phase, physicalState: input.physicalState ?? record.physicalState };
  if (input.command === "CLOSE_CASE" || input.command === "REOPEN_CASE") consequence.after = { command: input.command };
  if (input.lineId) consequence.lineId = input.lineId;
  if (input.userId) consequence.userId = input.userId;
  return { caseId: record.id, preview: true as const, consequence };
}

export async function repairCase(auth: AuthContext, caseId: string, input: z.infer<typeof repairCaseSchema>) {
  requireRepair(auth);
  requireRepairReason(input.reason);
  if (input.preview) return previewRepair(auth, caseId, input);
  const stateBreaking = new Set(["CORRECT_PHASE", "CLOSE_CASE", "REOPEN_CASE", "CANCEL_LINE", "REOPEN_LINE"]);
  if (stateBreaking.has(input.command)) requireOverride(auth);
  return getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${record.orderNumber}`}))`);
    const now = new Date();
    const recordEvent = async (details: Record<string, unknown>, lineId?: string) => {
      await tx.insert(caseEvents).values({ caseId, shortPickLineId: lineId ?? null, actorUserId: auth.user.id, eventType: "CASE_REPAIRED", details });
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_REPAIRED", details: { caseId, ...details } });
    };
    if (input.command === "CORRECT_PHASE") {
      if (!input.phase) throw new CaseApiError("CASE_NOT_FOUND", "A target phase is required", 400);
      // Phase-only correction must never bypass closure/reopen invariants: closing needs
      // reasoned CLOSE_CASE terminalization; reopening needs REOPEN_CASE. Both stay PICKING<->STAGED only here.
      if (input.phase === "CLOSED") throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Closing a case requires the explicit CLOSE_CASE command with a reason", 409, { command: input.command });
      if (record.phase === "CLOSED") throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Reopening a closed case requires the explicit REOPEN_CASE command", 409, { command: input.command });
      await assertNoOpenCaseConflict(tx, record.orderNumber, caseId);
      const phaseChanged = input.phase !== record.phase;
      const before = { phase: record.phase, physicalState: record.physicalState, physicalLocation: record.physicalLocation };
      // Only a real phase change resets the physical defaults; an explicit nonclosed
      // repair override for physicalState/physicalLocation is honored, and a
      // same-phase repair retains fields only when omitted.
      const configuration = await getConfigurationVersion(tx, record.configurationVersionId);
      if (!configuration) throw new Error("Case configuration version is missing");
      const after = phaseChanged
        ? { phase: input.phase,
            physicalState: input.physicalState ?? (input.phase === "PICKING" ? "WITH_PICKER" : "SHORT_PICK_HOLD"),
            physicalLocation: input.physicalLocation !== undefined
              ? input.physicalLocation
              : (input.phase === "PICKING" ? null : configuration.values.SHORT_PICK_HOLD_LOCATION_NAME) }
        // Same-phase repair keeps persisted physical fields only when omitted;
        // explicitly supplied fields are honored (null location clears).
        : { phase: record.phase,
            physicalState: input.physicalState ?? record.physicalState,
            physicalLocation: input.physicalLocation !== undefined ? input.physicalLocation : record.physicalLocation };
      const persisted = { ...record, phase: after.phase, physicalState: after.physicalState, physicalLocation: after.physicalLocation, updatedAt: now };
      await tx.update(orderCases).set({ phase: persisted.phase, physicalState: persisted.physicalState, physicalLocation: persisted.physicalLocation, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
      // Phase correction re-derives pending/failed retrievals under the persisted phase
      // in the same transaction: a real phase change drops stale manual pins, while a
      // same-phase STAGED correction preserves still-eligible manual owners.
      await rerouteCaseRetrievals(tx, { caseRecord: persisted, actorUserId: auth.user.id, reason: "CORRECT_PHASE", preserveEligibleManualOwner: !phaseChanged });
      await recordEvent({ command: input.command, reason: input.reason, before, after });
      return { caseId, command: input.command, before, after };
    }
    if (input.command === "REASSIGN_CHECK" || input.command === "RELEASE_CHECK") {
      if (!input.lineId) throw new CaseApiError("CASE_NOT_FOUND", "A line is required", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      const [active] = await tx.select().from(checkTasks).where(and(eq(checkTasks.shortPickLineId, line.id), ne(checkTasks.status, "COMPLETED"))).for("update").limit(1);
      if (!active) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "No active check on this line", 409);
      if (input.command === "RELEASE_CHECK") {
        const before = { taskId: active.id, status: active.status };
        await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, active.id));
        await tx.update(shortPickLines).set({ state: "OPEN", currentResponsibleUserId: null, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
        await tx.insert(checkTasks).values({ shortPickLineId: line.id });
        await recordEvent({ command: input.command, reason: input.reason, before, after: { taskId: active.id, status: "COMPLETED" } }, line.id);
        return { caseId, lineId: line.id, command: input.command };
      }
      if (!input.userId) throw new CaseApiError("CASE_NOT_FOUND", "A target user is required", 400);
      const [target] = await tx.select().from(users).where(and(eq(users.id, input.userId), eq(users.status, "ACTIVE"))).limit(1);
      if (!target || !target.permissions.includes("COMPLETE_CHECK")) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee cannot complete checks", 400);
      const before = { taskId: active.id, assignedToUserId: active.assignedToUserId, claimedByUserId: active.claimedByUserId };
      await tx.update(checkTasks).set({ status: "ASSIGNED", assignedToUserId: target.id, assignedAt: now, claimedByUserId: null, claimedAt: null, startedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` }).where(eq(checkTasks.id, active.id));
      await tx.update(shortPickLines).set({ state: "CHECKING", currentResponsibleUserId: target.id, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await recordEvent({ command: input.command, reason: input.reason, before, after: { taskId: active.id, assignedToUserId: target.id } }, line.id);
      await insertResponsibilityNotification(tx, { recipientUserId: target.id, type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId, shortPickLineId: line.id, payload: { taskId: active.id, orderNumber: record.orderNumber, repair: true } });
      return { caseId, lineId: line.id, command: input.command, assignedToUserId: target.id };
    }
    if (input.command === "CHANGE_RETRIEVAL_OWNER") {
      if (!input.lineId || !input.userId) throw new CaseApiError("CASE_NOT_FOUND", "A line and user are required", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      const [target] = await tx.select().from(users).where(and(eq(users.id, input.userId), eq(users.status, "ACTIVE"))).limit(1);
      if (!target || !target.permissions.includes("CONFIRM_RETRIEVAL")) throw new CaseApiError("CASE_ACCESS_DENIED", "Assignee cannot confirm retrieval", 400);
      const before = { retrievalResponsibleUserId: line.retrievalResponsibleUserId };
      await tx.update(shortPickLines).set({ retrievalResponsibleUserId: target.id, currentResponsibleUserId: target.id, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await recordEvent({ command: input.command, reason: input.reason, before, after: { retrievalResponsibleUserId: target.id } }, line.id);
      await insertResponsibilityNotification(tx, { recipientUserId: target.id, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED", caseId, shortPickLineId: line.id, payload: { orderNumber: record.orderNumber, repair: true } });
      return { caseId, lineId: line.id, command: input.command, retrievalResponsibleUserId: target.id };
    }
    if (input.command === "CORRECT_LOCATION") {
      if (!input.lineId || !input.location) throw new CaseApiError("CASE_NOT_FOUND", "A line and location are required", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      const before = { originalLocation: line.originalLocation, discoveredLocation: line.discoveredLocation };
      const after = input.discoveredLocation === null
        ? { originalLocation: line.originalLocation, discoveredLocation: null }
        : { originalLocation: input.location, discoveredLocation: input.discoveredLocation ?? line.discoveredLocation };
      await tx.update(shortPickLines).set({ originalLocation: after.originalLocation, discoveredLocation: after.discoveredLocation, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await recordEvent({ command: input.command, reason: input.reason, before, after }, line.id);
      return { caseId, lineId: line.id, command: input.command, before, after };
    }
    if (input.command === "CANCEL_LINE" || input.command === "REOPEN_LINE") {
      if (!input.lineId) throw new CaseApiError("CASE_NOT_FOUND", "A line is required", 400);
      const [line] = await tx.select().from(shortPickLines).where(and(eq(shortPickLines.id, input.lineId), eq(shortPickLines.caseId, caseId))).for("update").limit(1);
      if (!line) throw new CaseApiError("CASE_NOT_FOUND", "Line not found", 404);
      if (input.command === "CANCEL_LINE") {
        if (terminalStates.has(line.state)) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Line is already terminal", 409);
        const before = { state: line.state };
        await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` })
          .where(and(eq(checkTasks.shortPickLineId, line.id), ne(checkTasks.status, "COMPLETED")));
        await tx.update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED", currentResponsibleUserId: null, resolutionCode: input.lineState ?? "ADMINISTRATIVE", resolvedAt: now, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
        await recordEvent({ command: input.command, reason: input.reason, before, after: { state: "CANCELLED" } }, line.id);
        return { caseId, lineId: line.id, command: input.command, state: "CANCELLED" as const };
      }
      if (!terminalStates.has(line.state)) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Only a terminal line can be reopened", 409);
      if (record.phase === "CLOSED") throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "Reopen the case before reopening its line", 409);
      await assertNoActiveCheckConflict(tx, line.id);
      const before = { state: line.state };
      await tx.update(shortPickLines).set({ state: "OPEN", currentResponsibleUserId: null, discoveredLocation: null, discoveredByUserId: null, discoveredAt: null,
        retrievalState: "NOT_REQUIRED", retrievalResponsibleUserId: null, retrievedByUserId: null, retrievedAt: null,
        replenishmentState: "NONE", replenishmentNote: null, replenishmentActorUserId: null, replenishmentAt: null, replenishmentRetrieverUserId: null,
        resolvedAt: null, resolutionCode: null, updatedAt: now, version: sql`${shortPickLines.version} + 1` }).where(eq(shortPickLines.id, line.id));
      await tx.insert(checkTasks).values({ shortPickLineId: line.id });
      await recordEvent({ command: input.command, reason: input.reason, before, after: { state: "OPEN" } }, line.id);
      return { caseId, lineId: line.id, command: input.command, state: "OPEN" as const };
    }
    if (input.command === "CLOSE_CASE") {
      if (record.phase === "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is already closed", 409);
      const before = { phase: record.phase };
      const lines = await tx.select().from(shortPickLines).where(eq(shortPickLines.caseId, caseId)).for("update");
      const unresolved = lines.filter((line) => !terminalStates.has(line.state));
      if (!unresolved.length) throw new CaseApiError("REPAIR_INVARIANT_VIOLATION", "No open lines remain; use ordinary close", 409);
      await tx.update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: now, updatedAt: now, version: sql`${checkTasks.version} + 1` })
        .where(and(inArray(checkTasks.shortPickLineId, unresolved.map((line) => line.id)), ne(checkTasks.status, "COMPLETED")));
      await tx.update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED", currentResponsibleUserId: null, resolutionCode: "ADMINISTRATIVE", resolvedAt: now, updatedAt: now, version: sql`${shortPickLines.version} + 1` })
        .where(inArray(shortPickLines.id, unresolved.map((line) => line.id)));
      await tx.update(orderCases).set({ phase: "CLOSED", resolvedAt: now, resolvedByUserId: auth.user.id, currentCaseResponsibleUserId: auth.user.id, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
      await recordEvent({ command: input.command, reason: input.reason, before, after: { phase: "CLOSED" } });
      return { caseId, command: input.command, phase: "CLOSED" as const };
    }
    if (record.phase !== "CLOSED") throw new CaseApiError("CASE_NOT_OPEN", "Case is not closed", 409);
    await assertNoOpenCaseConflict(tx, record.orderNumber, caseId);
    const targetPhase = input.phase ?? "PICKING";
    const before = { phase: record.phase };
    await tx.update(orderCases).set({ phase: targetPhase, currentCaseResponsibleUserId: input.responsibleUserId ?? record.currentCaseResponsibleUserId,
      reopenedAt: now, resolvedAt: null, resolvedByUserId: null, updatedAt: now, version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    await recordEvent({ command: input.command, reason: input.reason, before, after: { phase: targetPhase } });
    return { caseId, command: input.command, phase: targetPhase };
  });
}
