import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, caseMessages, checkTasks, configurationVersions, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { insertMonitoringNotifications } from "@/server/notifications";
import { getCurrentConfiguration } from "@/server/configuration";
import { elapsedWorkingMinutes, workingHoursFromConfiguration } from "@/domain/working-hours";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "@/server/pagination";
import { CaseApiError } from "@/server/case-errors";
import { aggregateCaseDisplayStatus } from "@/domain/case-display-status";

export const orderNumberSchema = z.string().trim().regex(/^\d+$/, "Order number must contain digits only").max(64);
export const lookupOrderSchema = z.object({ orderNumber: orderNumberSchema });
export const addLineSchema = z.object({
  location: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
  sku: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
  quantity: z.number().int().positive().max(1_000_000),
  confirmDuplicate: z.boolean().default(false),
});
export const createCaseSchema = z.object({
  orderNumber: orderNumberSchema,
  firstLine: addLineSchema.omit({ confirmDuplicate: true }),
  confirmedHistoricalCaseIds: z.array(z.string().uuid()).max(1000).default([]),
});

export { CaseApiError } from "@/server/case-errors";

export function normalizeOrderNumber(value: string) {
  return orderNumberSchema.parse(value);
}

export type NextActionCode = "CLAIM_CHECK" | "COMPLETE_CHECK" | "REQUEST_CHECK" | "RETRIEVE" | "STAGE_ORDER" | "REPLENISH" | "RESOLVE" | "WAIT" | "NONE";
export type BlockingReasonCode = "CAPACITY_REACHED" | "CHECK_CLAIMED" | "AWAITING_RETRIEVAL" | "AWAITING_REPLENISHMENT" | "NO_ACTIVE_CHECK" | "CASE_CLOSED" | null;
export type LineDisplayStatus = "OPEN" | "CHECKING" | "FOUND" | "FOUND_AT_ORIGINAL" | "WAITING_RETRIEVAL" | "RETRIEVING" | "RETRIEVAL_FAILED" | "RETRIEVED" | "NOT_FOUND" | "WRONG_LOCATION" | "TROUBLESHOOTING" | "RESOLVED" | "CANCELLED";
export type ReplenishmentState = "NONE" | "WAITING" | "COMPLETED";
export type LineProjection = {
  lineId: string; caseId: string; orderNumber: string;
  displayStatus: LineDisplayStatus;
  originalLocation: string; knownNewLocation: string | null;
  reporterUserId: string; reporterName: string | null;
  checkerUserId: string | null; checkerName: string | null;
  retrieverUserId: string | null; retrieverName: string | null;
  replenishment: { state: ReplenishmentState; note: string | null; actorName: string | null; at: string | null };
  nextActionCode: NextActionCode; nextActionParams: Record<string, string>;
  actionOwnerUserId: string | null; actionOwnerName: string | null;
  blockingReasonCode: BlockingReasonCode;
};
export type CaseProjection = {
  caseId: string; orderNumber: string; phase: "PICKING" | "STAGED" | "CLOSED";
  openLineCount: number; lines: LineProjection[];
};
export type DashboardSummary = {
  openCases: number; openLines: number; checking: number; staged: number; overThreshold: number; resolvedToday: number;
};

type ShortPickLineRow = typeof shortPickLines.$inferSelect;
type CheckTaskRow = typeof checkTasks.$inferSelect;

function displayStatusForLine(line: ShortPickLineRow, latestCompletionCode: string | null): LineDisplayStatus {
  if (line.state === "RESOLVED") return line.retrievalState === "RETRIEVED" ? "RETRIEVED" : "RESOLVED";
  if (line.state === "CANCELLED") return "CANCELLED";
  // A nonterminal completed replenishment carries a pending/failed retrieval obligation.
  // Surface it as waiting retrieval/retry before any active-check or replenishment hint, without mutating main state.
  // FOUND lines keep their own branch below so a nonfailed FOUND_AT_ORIGINAL stays distinct; FAILED still dominates there.
  if (line.state !== "FOUND" && line.replenishmentState === "COMPLETED" && (line.retrievalState === "PENDING" || line.retrievalState === "IN_PROGRESS" || line.retrievalState === "FAILED")) {
    return line.retrievalState === "FAILED" ? "RETRIEVAL_FAILED" : line.retrievalState === "IN_PROGRESS" ? "RETRIEVING" : "WAITING_RETRIEVAL";
  }
  if (line.state === "CHECKING") return "CHECKING";
  if (line.state === "RETRIEVING") return line.retrievalState === "FAILED" ? "RETRIEVAL_FAILED" : "RETRIEVING";
  if (line.state === "FOUND") {
    // Failure dominates an original-location finding: a failed retry must read as a retry, never as a ready hint.
    if (line.retrievalState === "FAILED") return "RETRIEVAL_FAILED";
    if (latestCompletionCode === "FOUND_AT_ORIGINAL" && !line.discoveredLocation) return "FOUND_AT_ORIGINAL";
    if (line.retrievalState === "IN_PROGRESS") return "RETRIEVING";
    if (line.retrievalState === "RETRIEVED") return "RETRIEVED";
    if (line.retrievalState === "PENDING") return "WAITING_RETRIEVAL";
    return "FOUND";
  }
  if (line.state === "OPEN") {
    if (latestCompletionCode === "NOT_FOUND") return "NOT_FOUND";
    if (latestCompletionCode === "WRONG_LOCATION") return "WRONG_LOCATION";
    return "OPEN";
  }
  return "TROUBLESHOOTING";
}

function nextActionForLine(line: ShortPickLineRow, phase: "PICKING" | "STAGED" | "CLOSED", activeTask: CheckTaskRow | null, hasNonCompletedTask: boolean): {
  nextActionCode: NextActionCode; nextActionParams: Record<string, string>; actionOwnerUserId: string | null; blockingReasonCode: BlockingReasonCode;
} {
  if (phase === "CLOSED") return { nextActionCode: "NONE", nextActionParams: {}, actionOwnerUserId: null, blockingReasonCode: "CASE_CLOSED" };
  if (line.state === "RESOLVED" || line.state === "CANCELLED") return { nextActionCode: "NONE", nextActionParams: {}, actionOwnerUserId: null, blockingReasonCode: null };
  // A materialized completed-replenishment obligation outranks check/replenishment hints.
  // A COMPLETED marker without a materialized retrieval obligation has no pickup to
  // promise: it waits on the named replenishment retriever (tracked backfill covers
  // legacy rows). REPLENISH is only ever projected while replenishment is WAITING.
  if (line.replenishmentState === "COMPLETED"
    && (line.retrievalState === "PENDING" || line.retrievalState === "IN_PROGRESS" || line.retrievalState === "FAILED")) {
    return { nextActionCode: "RETRIEVE", nextActionParams: { lineId: line.id }, actionOwnerUserId: line.retrievalResponsibleUserId, blockingReasonCode: "AWAITING_RETRIEVAL" };
  }
  if (line.state === "OPEN" && line.replenishmentState === "COMPLETED") {
    return { nextActionCode: "WAIT", nextActionParams: { lineId: line.id }, actionOwnerUserId: line.replenishmentRetrieverUserId, blockingReasonCode: "AWAITING_RETRIEVAL" };
  }
  if (line.state === "CHECKING" || activeTask) {
    const owner = activeTask ? (activeTask.assignedToUserId ?? activeTask.claimedByUserId) : line.currentResponsibleUserId;
    return { nextActionCode: "COMPLETE_CHECK", nextActionParams: { lineId: line.id }, actionOwnerUserId: owner, blockingReasonCode: "CHECK_CLAIMED" };
  }
  if ((line.state === "FOUND" && (line.retrievalState === "PENDING" || line.retrievalState === "FAILED" || line.retrievalState === "IN_PROGRESS")) || line.state === "RETRIEVING") {
    return { nextActionCode: "RETRIEVE", nextActionParams: { lineId: line.id }, actionOwnerUserId: line.retrievalResponsibleUserId, blockingReasonCode: "AWAITING_RETRIEVAL" };
  }
  if (line.state === "OPEN" && line.replenishmentState === "WAITING") {
    return { nextActionCode: "REPLENISH", nextActionParams: { lineId: line.id }, actionOwnerUserId: line.replenishmentRetrieverUserId, blockingReasonCode: "AWAITING_REPLENISHMENT" };
  }
  if (line.state === "OPEN") {
    // Task availability is authoritative: never project CLAIM_CHECK without an AVAILABLE task.
    // OPEN with no noncompleted task is an explicit coded manager follow-up (ASSIGN_CHECK holders request it).
    if (!hasNonCompletedTask) return { nextActionCode: "REQUEST_CHECK", nextActionParams: { lineId: line.id, requiredPermission: "ASSIGN_CHECK" }, actionOwnerUserId: null, blockingReasonCode: "NO_ACTIVE_CHECK" };
    return { nextActionCode: "CLAIM_CHECK", nextActionParams: { lineId: line.id }, actionOwnerUserId: null, blockingReasonCode: null };
  }
  return { nextActionCode: "WAIT", nextActionParams: { lineId: line.id }, actionOwnerUserId: line.currentResponsibleUserId, blockingReasonCode: null };
}

export function projectLines(args: {
  orderNumber: string; phase: "PICKING" | "STAGED" | "CLOSED";
  lines: ShortPickLineRow[]; checks: CheckTaskRow[]; names: Map<string, string | null>;
}): LineProjection[] {
  const latestCompletion: Record<string, string | null> = {};
  const ordered = [...args.checks].sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  for (const check of ordered) {
    if (check.status === "COMPLETED" && latestCompletion[check.shortPickLineId] === undefined) latestCompletion[check.shortPickLineId] = check.completionCode;
  }
  // Availability is derived from tasks, never from stale line fields: CLAIMED/ASSIGNED wins over AVAILABLE on the same line.
  const activeTaskByLine: Record<string, CheckTaskRow> = {};
  const hasNonCompletedTask: Record<string, true> = {};
  for (const check of args.checks) {
    if (check.status === "COMPLETED") continue;
    hasNonCompletedTask[check.shortPickLineId] = true;
    if ((check.status === "CLAIMED" || check.status === "ASSIGNED") && activeTaskByLine[check.shortPickLineId] === undefined) activeTaskByLine[check.shortPickLineId] = check;
  }
  return args.lines.map((line) => {
    const code = latestCompletion[line.id] ?? null;
    const checker = activeTaskByLine[line.id] ?? null;
    const checkerUserId = checker ? (checker.assignedToUserId ?? checker.claimedByUserId) : null;
    const action = nextActionForLine(line, args.phase, checker, hasNonCompletedTask[line.id] === true);
    const replenishmentState: ReplenishmentState = line.replenishmentState === "WAITING" || line.replenishmentState === "COMPLETED" ? line.replenishmentState : "NONE";
    return {
      lineId: line.id, caseId: line.caseId, orderNumber: args.orderNumber,
      displayStatus: displayStatusForLine(line, code),
      originalLocation: line.originalLocation, knownNewLocation: line.discoveredLocation,
      reporterUserId: line.reportedByUserId, reporterName: args.names.get(line.reportedByUserId) ?? null,
      checkerUserId, checkerName: checkerUserId ? (args.names.get(checkerUserId) ?? null) : null,
      retrieverUserId: line.retrievalResponsibleUserId, retrieverName: line.retrievalResponsibleUserId ? (args.names.get(line.retrievalResponsibleUserId) ?? null) : null,
      replenishment: { state: replenishmentState, note: line.replenishmentNote, actorName: line.replenishmentActorUserId ? (args.names.get(line.replenishmentActorUserId) ?? null) : null, at: line.replenishmentAt ? line.replenishmentAt.toISOString() : null },
      nextActionCode: action.nextActionCode, nextActionParams: action.nextActionParams,
      actionOwnerUserId: action.actionOwnerUserId, actionOwnerName: action.actionOwnerUserId ? (args.names.get(action.actionOwnerUserId) ?? null) : null,
      blockingReasonCode: action.blockingReasonCode,
    };
  });
}

export function summarizeDashboard(cases: Array<{ phase: string; openLineCount: number; checkingCount: number; attentionLevel?: string }>, resolvedToday: number): DashboardSummary {
  return {
    openCases: cases.length,
    openLines: cases.reduce((total, item) => total + item.openLineCount, 0),
    checking: cases.reduce((total, item) => total + item.checkingCount, 0),
    staged: cases.filter((item) => item.phase === "STAGED").length,
    overThreshold: cases.filter((item) => item.attentionLevel === "CRITICAL").length,
    resolvedToday,
  };
}

const isOpen = ne(orderCases.phase, "CLOSED");

export const caseTimelineQuerySchema = paginationQuerySchema;

export type CaseTimelinePage = { page?: number; pageSize?: number };

async function readCase(db: Pick<ReturnType<typeof getDb>, "select">, caseId: string, includeMessages: boolean, timeline: CaseTimelinePage = {}) {
  const [record] = await db.select().from(orderCases).where(eq(orderCases.id, caseId)).limit(1);
  if (!record) return null;
  const [versionRow] = await db.select().from(configurationVersions).where(eq(configurationVersions.id, record.configurationVersionId)).limit(1);
  const workingHours = workingHoursFromConfiguration(versionRow?.values);
  const lines = await db.select().from(shortPickLines).where(eq(shortPickLines.caseId, caseId)).orderBy(shortPickLines.createdAt, shortPickLines.id);
  const checks = lines.length ? await db.select().from(checkTasks).where(inArray(checkTasks.shortPickLineId, lines.map((line) => line.id))).orderBy(checkTasks.createdAt, checkTasks.id) : [];
  const timelineParsed = caseTimelineQuerySchema.parse({ page: timeline.page ?? 1, pageSize: timeline.pageSize ?? 50 });
  const timelineWhere = eq(caseEvents.caseId, caseId);
  const [eventCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(caseEvents).where(timelineWhere);
  const eventTotal = eventCountRow?.count ?? 0;
  // Keyset would fit a feed better, but offset keeps the contract uniform; created_at+id order is stable.
  const events = await db.select({ id: caseEvents.id, shortPickLineId: caseEvents.shortPickLineId, actorUserId: caseEvents.actorUserId, actorName: users.displayName, eventType: caseEvents.eventType, details: caseEvents.details, createdAt: caseEvents.createdAt })
    .from(caseEvents).leftJoin(users, eq(caseEvents.actorUserId, users.id)).where(timelineWhere).orderBy(caseEvents.createdAt, caseEvents.id)
    .limit(timelineParsed.pageSize).offset(paginationOffset(timelineParsed.page, timelineParsed.pageSize));
  const locationByLine = new Map(lines.map((line) => [line.id, { originalLocation: line.originalLocation, discoveredLocation: line.discoveredLocation }]));
  const shapedEvents = events.map((event) => {
    const raw = (event.details ?? {}) as Record<string, unknown>;
    const pickString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
    const lineId = typeof event.shortPickLineId === "string" ? event.shortPickLineId : null;
    const lineLocations = lineId ? locationByLine.get(lineId) : undefined;
    const completionCode = pickString(raw.code);
    const discoveredLocation = pickString(raw.location) ?? pickString(raw.discoveredLocation)
      ?? (event.eventType === "CHECK_COMPLETED" && completionCode === "FOUND" ? (lineLocations?.discoveredLocation ?? null) : null);
    const originalLocation = pickString(raw.originalLocation)
      ?? (event.eventType === "CHECK_COMPLETED" && completionCode === "FOUND_AT_ORIGINAL" ? (lineLocations?.originalLocation ?? null) : null);
    const resultMessage = event.eventType === "CHECK_COMPLETED" ? pickString(raw.message) : null;
    return { ...event, completionCode, taskId: pickString(raw.taskId), discoveredLocation, originalLocation, resultMessage };
  });
  const messages = includeMessages ? await db.select({ id: caseMessages.id, shortPickLineId: caseMessages.shortPickLineId, authorUserId: caseMessages.authorUserId, authorName: users.displayName, message: caseMessages.message, createdAt: caseMessages.createdAt })
    .from(caseMessages).innerJoin(users, eq(caseMessages.authorUserId, users.id)).where(eq(caseMessages.caseId, caseId)).orderBy(caseMessages.createdAt, caseMessages.id) : [];
  const eventAssigneeIds = events.flatMap((event) => {
    const raw = (event.details ?? {}) as Record<string, unknown>;
    return [raw.assignedToUserId, raw.responsibleUserId, raw.userId, raw.checkerUserId].filter((id): id is string => typeof id === "string" && id.length > 0);
  });
  const personIds = [...new Set([record.pickingUserId, record.currentCaseResponsibleUserId,
    ...lines.flatMap((line) => [line.reportedByUserId, line.currentResponsibleUserId, line.discoveredByUserId, line.retrievalResponsibleUserId, line.replenishmentActorUserId, line.replenishmentRetrieverUserId]),
    ...checks.flatMap((check) => [check.claimedByUserId, check.assignedToUserId]),
    ...eventAssigneeIds,
  ].filter((id): id is string => Boolean(id)))];
  const people = personIds.length ? await db.select({ id: users.id, displayName: users.displayName, identifier: users.identifier }).from(users).where(inArray(users.id, personIds)) : [];
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const identifiers = new Map(people.map((person) => [person.id, person.identifier]));
  const detailsByEventId = new Map(events.map((entry) => [entry.id, { details: (entry.details ?? {}) as Record<string, unknown>, actorUserId: entry.actorUserId }]));
  const shapedWithAssignee = shapedEvents.map((event) => {
    const entry = detailsByEventId.get(event.id);
    const raw = entry?.details ?? {};
    const explicitId = [raw.assignedToUserId, raw.responsibleUserId, raw.userId, raw.checkerUserId].find((id): id is string => typeof id === "string" && id.length > 0) ?? null;
    // CHECK_CLAIMED details carry only { taskId }; the event actor is the claimer.
    const assigneeUserId = explicitId ?? (event.eventType === "CHECK_CLAIMED" && typeof entry?.actorUserId === "string" ? entry.actorUserId : null);
    return { ...event, assigneeName: assigneeUserId ? (names.get(assigneeUserId) ?? null) : null };
  });
  const lineProjections = projectLines({ orderNumber: record.orderNumber, phase: record.phase, lines, checks, names });
  const aggregate = aggregateCaseDisplayStatus(record.phase, lines.map((line) => ({ id: line.id, state: line.state, retrievalState: line.retrievalState, replenishmentState: line.replenishmentState })), lineProjections);
  const checkingCount = lines.filter((line) => line.state === "CHECKING"
    && !(line.replenishmentState === "COMPLETED" && (line.retrievalState === "PENDING" || line.retrievalState === "IN_PROGRESS" || line.retrievalState === "FAILED"))).length;
  // Compatibility: the only consumer renders `issue_${currentIssue}` and labels
  // exist only for RETRIEVAL_PENDING (never WAITING_RETRIEVAL/RETRIEVING), so map
  // both retrieval projections onto it. All closed cases read CLOSED.
  const currentIssue = aggregate === "WAITING_RETRIEVAL" || aggregate === "RETRIEVING" ? "RETRIEVAL_PENDING" : aggregate;
  const unresolvedLines = lines.filter((line) => line.state !== "RESOLVED" && line.state !== "CANCELLED");
  const projection: CaseProjection = { caseId: record.id, orderNumber: record.orderNumber, phase: record.phase, openLineCount: unresolvedLines.length, lines: lineProjections };
  const now = new Date();
  const elapsedWorkingMinutesValue = elapsedWorkingMinutes(record.createdAt, record.resolvedAt ?? now, workingHours, now);
  return { ...record, pickerName: record.pickingUserId ? names.get(record.pickingUserId) ?? null : null,
    pickerIdentifier: record.pickingUserId ? identifiers.get(record.pickingUserId) ?? null : null,
    responsibleName: record.currentCaseResponsibleUserId ? names.get(record.currentCaseResponsibleUserId) ?? null : null,
    responsibleIdentifier: record.currentCaseResponsibleUserId ? identifiers.get(record.currentCaseResponsibleUserId) ?? null : null,
    missingCount: unresolvedLines.reduce((total, line) => total + line.missingQuantity, 0), checkingCount, currentIssue,
    lines: lines.map((line) => ({ ...line, location: line.originalLocation, quantity: line.missingQuantity,
      responsibleName: line.currentResponsibleUserId ? (names.get(line.currentResponsibleUserId) ?? null) : null,
      reporterName: names.get(line.reportedByUserId) ?? null, reporterIdentifier: identifiers.get(line.reportedByUserId) ?? null })),
    checks: checks.map((check) => { const workerId = check.assignedToUserId ?? check.claimedByUserId; return { ...check, assigneeName: workerId ? (names.get(workerId) ?? null) : null }; }),
    events: shapedWithAssignee, eventsPagination: paginationMeta(eventTotal, timelineParsed.page, timelineParsed.pageSize), messages, projection, lineProjections,
    workingHours, elapsedWorkingMinutes: elapsedWorkingMinutesValue };
}

function canReadCase(auth: AuthContext, row: typeof orderCases.$inferSelect) {
  return hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")
    || (row.pickingUserId === auth.user.id && hasAuthPermission(auth, "VIEW_OWN_CASES"));
}

export async function hasCurrentCaseResponsibility(
  db: Pick<ReturnType<typeof getDb>, "select">,
  auth: AuthContext,
  row: typeof orderCases.$inferSelect,
) {
  if (row.currentCaseResponsibleUserId === auth.user.id) return true;
  const [retrieval] = await db.select({ id: shortPickLines.id }).from(shortPickLines).where(and(
    eq(shortPickLines.caseId, row.id), eq(shortPickLines.retrievalResponsibleUserId, auth.user.id),
    inArray(shortPickLines.retrievalState, ["PENDING", "FAILED"]),
    ne(shortPickLines.state, "RESOLVED"), ne(shortPickLines.state, "CANCELLED"),
    or(eq(shortPickLines.state, "FOUND"), eq(shortPickLines.replenishmentState, "COMPLETED")),
  )).limit(1);
  if (retrieval) return true;
  const [check] = await db.select({ id: checkTasks.id }).from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .where(and(eq(shortPickLines.caseId, row.id), eq(shortPickLines.state, "CHECKING"), inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"]),
      sql`(${checkTasks.claimedByUserId} = ${auth.user.id} OR ${checkTasks.assignedToUserId} = ${auth.user.id})`)).limit(1);
  return Boolean(check);
}

export async function isRecordedCaseParticipant(
  db: Pick<ReturnType<typeof getDb>, "select">,
  auth: AuthContext,
  row: typeof orderCases.$inferSelect,
) {
  if (row.pickingUserId === auth.user.id) return true;
  const [reporter] = await db.select({ id: shortPickLines.id }).from(shortPickLines)
    .where(and(eq(shortPickLines.caseId, row.id), eq(shortPickLines.reportedByUserId, auth.user.id))).limit(1);
  if (reporter) return true;
  const [check] = await db.select({ id: checkTasks.id }).from(checkTasks)
    .innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .where(and(eq(shortPickLines.caseId, row.id), sql`(${checkTasks.claimedByUserId} = ${auth.user.id} OR ${checkTasks.assignedToUserId} = ${auth.user.id})`)).limit(1);
  if (check) return true;
  const [completed] = await db.select({ id: caseEvents.id }).from(caseEvents)
    .where(and(eq(caseEvents.caseId, row.id), eq(caseEvents.actorUserId, auth.user.id),
      inArray(caseEvents.eventType, ["CHECK_COMPLETED", "FOUND_AT_ORIGINAL_VERIFIED", "NEW_LOCATION_REPORTED"]))).limit(1);
  if (completed) return true;
  const [retrieval] = await db.select({ id: shortPickLines.id }).from(shortPickLines)
    .where(and(eq(shortPickLines.caseId, row.id), sql`(${shortPickLines.retrievalResponsibleUserId} = ${auth.user.id} OR ${shortPickLines.retrievedByUserId} = ${auth.user.id} OR ${shortPickLines.discoveredByUserId} = ${auth.user.id} OR ${shortPickLines.replenishmentActorUserId} = ${auth.user.id} OR ${shortPickLines.replenishmentRetrieverUserId} = ${auth.user.id})`)).limit(1);
  return Boolean(retrieval);
}

export async function lookupOrder(auth: AuthContext, rawOrderNumber: string) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  const db = getDb();
  const [open] = await db.select().from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), isOpen)).limit(1);
  if (open) {
    if (!canReadCase(auth, open)) throw new CaseApiError("OPEN_CASE_NOT_ACCESSIBLE", "An open case exists for this order, but you cannot access it", 403);
    return { kind: "OPEN" as const, case: await readCase(db, open.id, hasAuthPermission(auth, "VIEW_CASE_MESSAGES")) };
  }
  const history = await db.select({ id: orderCases.id, createdAt: orderCases.createdAt, phase: orderCases.phase })
    .from(orderCases).where(eq(orderCases.orderNumber, orderNumber)).orderBy(desc(orderCases.createdAt));
  return history.length
    ? { kind: "HISTORY" as const, normalizedOrderNumber: orderNumber, history }
    : { kind: "NEW" as const, normalizedOrderNumber: orderNumber };
}

export async function createCase(auth: AuthContext, rawOrderNumber: string, confirmedHistoricalCaseIds: string[], firstLine: z.infer<typeof createCaseSchema>["firstLine"]) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Serialize all create attempts for this normalized identifier; the partial unique index remains the final invariant.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${orderNumber}`}))`);
    const [open] = await tx.select().from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), isOpen)).limit(1);
    if (open) return { kind: "OPEN_EXISTS" as const, caseId: open.id, accessible: canReadCase(auth, open) };
    const history = await tx.select({ id: orderCases.id, createdAt: orderCases.createdAt, phase: orderCases.phase })
      .from(orderCases).where(eq(orderCases.orderNumber, orderNumber)).orderBy(desc(orderCases.createdAt));
    const expectedIds = history.map((row) => row.id).sort();
    const confirmedIds = [...new Set(confirmedHistoricalCaseIds)].sort();
    if (expectedIds.length !== confirmedIds.length || expectedIds.some((id, index) => id !== confirmedIds[index])) {
      return { kind: "HISTORY_CONFIRMATION_REQUIRED" as const, history };
    }
    const configuration = await getCurrentConfiguration(tx);
    const [created] = await tx.insert(orderCases).values({ orderNumber, pickingUserId: auth.user.id, currentCaseResponsibleUserId: auth.user.id, createdByUserId: auth.user.id, source: "PICKER_REPORT", configurationVersionId: configuration.id }).returning();
    const [line] = await tx.insert(shortPickLines).values({
      caseId: created!.id, originalLocation: firstLine.location, sku: firstLine.sku,
      missingQuantity: firstLine.quantity, reportedByUserId: auth.user.id,
    }).returning({ id: shortPickLines.id });
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.insert(caseEvents).values({ caseId: created!.id, actorUserId: auth.user.id, eventType: "CASE_CREATED", details: { orderNumber, source: "PICKER_REPORT" } });
    await tx.insert(caseEvents).values({ caseId: created!.id, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: "SHORT_PICK_LINE_ADDED", details: { lineId: line!.id, location: firstLine.location, sku: firstLine.sku, quantity: firstLine.quantity } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_CREATED", details: { caseId: created!.id, orderNumber, source: "PICKER_REPORT" } });
    await insertMonitoringNotifications(tx, { type: "NEW_SHORT_PICK", caseId: created!.id, shortPickLineId: line!.id,
      payload: { orderNumber, location: firstLine.location, sku: firstLine.sku, quantity: firstLine.quantity }, excludeUserId: auth.user.id });
    return { kind: "CREATED" as const, caseId: created!.id };
  });
  if (result.kind === "OPEN_EXISTS") {
    if (!result.accessible) throw new CaseApiError("OPEN_CASE_NOT_ACCESSIBLE", "An open case exists for this order, but you cannot access it", 403);
    throw new CaseApiError("OPEN_CASE_EXISTS", "An open case already exists for this order", 409, { case: await readCase(db, result.caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES")) });
  }
  if (result.kind === "HISTORY_CONFIRMATION_REQUIRED") throw new CaseApiError("HISTORICAL_CONFIRMATION_REQUIRED", "Confirm the current historical cases before creating another case", 409, { history: result.history });
  return readCase(db, result.caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES"));
}

export async function addCaseLine(auth: AuthContext, caseId: string, input: z.infer<typeof addLineSchema>) {
  const db = getDb();
  const normalizedLocation = input.location.trim().toUpperCase();
  const normalizedSku = input.sku.trim().toUpperCase();
  const result = await db.transaction(async (tx) => {
    // Locking the case row serializes concurrent line submissions before duplicate detection.
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    const canManage = hasAuthPermission(auth, "REPORT_SHORT_PICK") && (
      (record.pickingUserId === auth.user.id && hasAuthPermission(auth, "VIEW_OWN_CASES"))
      || hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")
    );
    if (!canManage) {
      throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot add lines to this case", 403);
    }
    if (record.phase !== "PICKING") throw new CaseApiError("CASE_NOT_OPEN", "This case is no longer accepting new lines", 409);
    const [duplicate] = await tx.select().from(shortPickLines).where(and(
      eq(shortPickLines.caseId, caseId), eq(shortPickLines.originalLocation, normalizedLocation), eq(shortPickLines.sku, normalizedSku),
      inArray(shortPickLines.state, ["OPEN", "CHECKING", "FOUND", "RETRIEVING"]),
    )).limit(1);
    const mayOverride = (auth.user.role === "TEAM_LEADER" || auth.user.role === "MANAGER" || auth.user.role === "ADMIN")
      && hasAuthPermission(auth, "OVERRIDE_DUPLICATE_SHORT_PICK_LINE");
    if (duplicate && (!input.confirmDuplicate || !mayOverride)) {
      return { kind: "DUPLICATE" as const, duplicate, mayOverride };
    }
    const [line] = await tx.insert(shortPickLines).values({ caseId, originalLocation: normalizedLocation, sku: normalizedSku, missingQuantity: input.quantity, reportedByUserId: auth.user.id }).returning();
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.update(orderCases).set({ updatedAt: new Date(), version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    const details = { lineId: line!.id, location: normalizedLocation, sku: normalizedSku, quantity: input.quantity, ...(duplicate ? { duplicateOfLineId: duplicate.id, override: true } : {}) };
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: duplicate ? "SHORT_PICK_LINE_DUPLICATE_OVERRIDE_USED" : "SHORT_PICK_LINE_ADDED", details });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: duplicate ? "SHORT_PICK_LINE_DUPLICATE_OVERRIDE_USED" : "SHORT_PICK_LINE_ADDED", details: { caseId, ...details } });
    // D1: one monitoring emission per successful insertion (authorized duplicates included).
    // Preferences and actor exclusion apply inside; rejected duplicates return above without emitting.
    await insertMonitoringNotifications(tx, { type: "NEW_SHORT_PICK", caseId, shortPickLineId: line!.id,
      payload: { lineId: line!.id, orderNumber: record.orderNumber, location: normalizedLocation, sku: normalizedSku, quantity: input.quantity }, excludeUserId: auth.user.id });
    return { kind: "CREATED" as const, line: line! };
  });
  if (result.kind === "DUPLICATE") {
    const line = { ...result.duplicate, location: result.duplicate.originalLocation, quantity: result.duplicate.missingQuantity };
    if (input.confirmDuplicate && !result.mayOverride) throw new CaseApiError("DUPLICATE_OVERRIDE_FORBIDDEN", "You are not authorized to add a duplicate unresolved line", 403, { line });
    throw new CaseApiError("DUPLICATE_LINE", "This item is already reported on this order", 409, { line, overrideAllowed: result.mayOverride });
  }
  return { ...result.line, location: result.line.originalLocation, quantity: result.line.missingQuantity };
}

export async function getCaseForUser(auth: AuthContext, caseId: string, timeline: CaseTimelinePage = {}) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).limit(1);
    if (!row) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (row.phase === "CLOSED") {
      const isManager = hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES");
      const isParticipant = hasAuthPermission(auth, "VIEW_OWN_CASES") && (await isRecordedCaseParticipant(tx, auth, row));
      if (!isManager && !isParticipant) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot access this closed case", 403);
      const detail = await readCase(tx, caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES"), timeline);
      return { ...detail, readOnly: true as const };
    }
    if (!canReadCase(auth, row)) {
      if (!hasAuthPermission(auth, "VIEW_OWN_CASES") || !(await hasCurrentCaseResponsibility(tx, auth, row))) {
        throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot access this case", 403);
      }
    }
    return readCase(tx, caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES"), timeline);
  });
}

export const caseListQuerySchema = paginationQuerySchema.extend({
  scope: z.enum(["mine", "active"]).default("mine"),
});

export async function listCasesForUser(auth: AuthContext, scope: "mine" | "active", options: { page?: number; pageSize?: number } = {}) {
  const db = getDb();
  if (scope === "active" && !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot view all active cases", 403);
  if (scope === "mine" && !hasAuthPermission(auth, "VIEW_OWN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot view your cases", 403);
  const parsed = caseListQuerySchema.parse({ scope, page: options.page ?? 1, pageSize: options.pageSize ?? 20 });
  const where = and(isOpen, ...(scope === "mine" ? [or(eq(orderCases.pickingUserId, auth.user.id), eq(orderCases.currentCaseResponsibleUserId, auth.user.id))] : []));
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(where);
  const total = countRow?.count ?? 0;
  // Empty pages stay empty: no clamping to the last page, so filters survive paging.
  const rows = await db.select().from(orderCases).where(where).orderBy(desc(orderCases.updatedAt)).limit(parsed.pageSize).offset(paginationOffset(parsed.page, parsed.pageSize));
  const ids = rows.map((row) => row.id);
  const lines = ids.length ? await db.select().from(shortPickLines).where(inArray(shortPickLines.caseId, ids)).orderBy(shortPickLines.createdAt) : [];
  const grouped = new Map<string, typeof lines>();
  for (const line of lines) grouped.set(line.caseId, [...(grouped.get(line.caseId) ?? []), line]);
  const versionIds = [...new Set(rows.map((row) => row.configurationVersionId))];
  const versionRows = versionIds.length
    ? await db.select({ id: configurationVersions.id, values: configurationVersions.values }).from(configurationVersions).where(inArray(configurationVersions.id, versionIds))
    : [];
  const schedules = new Map(versionRows.map((row) => [row.id, workingHoursFromConfiguration(row.values)]));
  const now = new Date();
  const cases = rows.map((row) => { const workingHours = schedules.get(row.configurationVersionId) ?? workingHoursFromConfiguration(null);
    return { ...row, workingHours, elapsedWorkingMinutes: elapsedWorkingMinutes(row.createdAt, row.resolvedAt ?? now, workingHours, now),
      lines: (grouped.get(row.id) ?? []).map((line) => ({ id: line.id, state: line.state, quantity: line.missingQuantity, location: line.originalLocation, sku: line.sku })) }; });
  return { cases, ...paginationMeta(total, parsed.page, parsed.pageSize) };
}

export async function listCaseHistoryForUser(auth: AuthContext, options: { page?: number; pageSize?: number } = {}) {
  const db = getDb();
  if (!hasAuthPermission(auth, "VIEW_OWN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot view your case history", 403);
  const parsed = paginationQuerySchema.parse(options);
  const where = and(eq(orderCases.phase, "CLOSED"), eq(orderCases.pickingUserId, auth.user.id));
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).where(where);
  const total = countRow?.count ?? 0;
  const rows = await db.select({ id: orderCases.id, orderNumber: orderCases.orderNumber, createdAt: orderCases.createdAt, resolvedAt: orderCases.resolvedAt, configurationVersionId: orderCases.configurationVersionId })
    .from(orderCases).where(where).orderBy(desc(orderCases.resolvedAt), desc(orderCases.createdAt))
    .limit(parsed.pageSize).offset(paginationOffset(parsed.page, parsed.pageSize));
  const historyVersionIds = [...new Set(rows.map((row) => row.configurationVersionId))];
  const historyVersions = historyVersionIds.length
    ? await db.select({ id: configurationVersions.id, values: configurationVersions.values }).from(configurationVersions).where(inArray(configurationVersions.id, historyVersionIds))
    : [];
  const historySchedules = new Map(historyVersions.map((row) => [row.id, workingHoursFromConfiguration(row.values)]));
  const historyNow = new Date();
  return { cases: rows.map((row) => { const workingHours = historySchedules.get(row.configurationVersionId) ?? workingHoursFromConfiguration(null);
    return { ...row, workingHours, elapsedWorkingMinutes: elapsedWorkingMinutes(row.createdAt, row.resolvedAt ?? historyNow, workingHours, historyNow) }; }), ...paginationMeta(total, parsed.page, parsed.pageSize) };
}
