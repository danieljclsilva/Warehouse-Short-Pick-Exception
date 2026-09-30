import { and, asc, desc, eq, exists, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { caseEvents, checkTasks, configurationVersions, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/case-errors";

/** Dashboard and export limits. They protect the transactional database from unbounded analytical reads. */
export const ANALYTICS_LIMITS = {
  maxCases: 5_000,
  maxLines: 10_000,
  maxEvents: 20_000,
  maxDuplicateOrders: 1_000,
  maxDateRangeDays: 366,
} as const;

/** Conclusive check outcomes per FIELD_FEEDBACK_CONTRACTS.md §3. `OTHER` stays non-conclusive. */
export const CONCLUSIVE_CHECK_OUTCOMES = ["FOUND_AT_ORIGINAL", "FOUND", "NOT_FOUND", "WRONG_LOCATION"] as const;
export type ConclusiveCheckOutcome = (typeof CONCLUSIVE_CHECK_OUTCOMES)[number];
/** Minimum eligible lines before a same-location-found percentage may be shown. */
export const SAME_LOCATION_FOUND_MIN_DENOMINATOR = 20;

const phaseSchema = z.enum(["PICKING", "STAGED", "CLOSED"]);
const sourceSchema = z.enum(["PICKER_REPORT", "TL_MANUAL", "ASSISTANT_MANUAL", "MANAGER_MANUAL", "ADMIN_MANUAL"]);
const uuidParam = z.string().uuid();

export const analyticsFilterSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  orderNumber: z.string().trim().min(1).max(64).optional(),
  location: z.string().trim().min(1).max(128).optional(),
  sku: z.string().trim().min(1).max(128).optional(),
  phase: phaseSchema.optional(),
  // FOUND_AT_ORIGINAL is accepted here whether or not the DB enum migration has
  // landed; predicates compare completion codes as text so the query never casts.
  resolution: z.enum(["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER", "FOUND_AT_ORIGINAL"]).optional(),
  source: sourceSchema.optional(),
  configVersion: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  pickerUserId: uuidParam.optional(),
  checkerUserId: uuidParam.optional(),
  troubleshooterUserId: uuidParam.optional(),
  role: z.enum(["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"]).optional(),
}).superRefine((value, ctx) => {
  if (value.to <= value.from) ctx.addIssue({ code: "custom", path: ["to"], message: "The end date must be after the start date" });
  const days = (value.to.getTime() - value.from.getTime()) / 86_400_000;
  if (days > ANALYTICS_LIMITS.maxDateRangeDays) ctx.addIssue({ code: "custom", path: ["to"], message: `Date range cannot exceed ${ANALYTICS_LIMITS.maxDateRangeDays} days` });
});

export type AnalyticsFilters = z.infer<typeof analyticsFilterSchema> & { toExclusive?: Date };

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  // Date-only values are useful to the dashboard and mean a UTC calendar boundary.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new CaseApiError("INVALID_ANALYTICS_FILTER", "Invalid analytics date", 400);
  return parsed;
}

/** Parse URL filters once so dashboard, CSV, and PDF use the same date and bound rules. */
export function parseAnalyticsFilters(params: URLSearchParams, now = new Date()): AnalyticsFilters {
  const defaultTo = new Date(now);
  const defaultFrom = new Date(now.getTime() - 30 * 86_400_000);
  const rawTo = params.get("to");
  const selectedTo = parseDate(rawTo, defaultTo);
  // A date-only upper bound is inclusive for a user selecting a calendar day,
  // while `to` remains the selected calendar boundary for display consumers.
  const toExclusive = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? new Date(selectedTo.getTime() + 86_400_000) : selectedTo;
  const raw = {
    from: parseDate(params.get("from"), defaultFrom),
    to: selectedTo,
    orderNumber: params.get("orderNumber") ?? undefined,
    location: params.get("location") ?? undefined,
    sku: params.get("sku") ?? undefined,
    phase: params.get("phase") ?? undefined,
    resolution: params.get("resolution") ?? undefined,
    source: params.get("source") ?? undefined,
    configVersion: params.get("configVersion") ?? undefined,
    pickerUserId: params.get("pickerUserId") ?? undefined,
    checkerUserId: params.get("checkerUserId") ?? undefined,
    troubleshooterUserId: params.get("troubleshooterUserId") ?? undefined,
    role: params.get("role") ?? undefined,
  };
  return { ...analyticsFilterSchema.parse({ ...raw, to: toExclusive }), to: selectedTo, toExclusive };
}

type Db = ReturnType<typeof getDb>;
type CaseRow = typeof orderCases.$inferSelect;
type LineRow = typeof shortPickLines.$inferSelect;
type EventRow = typeof caseEvents.$inferSelect;
type TaskRow = typeof checkTasks.$inferSelect;

export type AnalyticsCaseRow = {
  id: string;
  orderNumber: string;
  phase: CaseRow["phase"];
  physicalState: CaseRow["physicalState"];
  physicalLocation: string | null;
  source: CaseRow["source"];
  manualReason: string | null;
  picker: { id: string; displayName: string } | null;
  responsible: { id: string; displayName: string } | null;
  configurationVersion: { id: string; version: number };
  criticalThresholdMinutes: number;
  overThreshold: boolean;
  createdAt: Date;
  stagedAt: Date | null;
  resolvedAt: Date | null;
  reopenedAt: Date | null;
  lineCount: number;
};

export type AnalyticsLineRow = {
  id: string;
  caseId: string;
  orderNumber: string;
  originalLocation: string;
  sku: string;
  missingQuantity: number;
  state: LineRow["state"];
  resolutionCode: string | null;
  retrievalState: string;
  reportedByUserId: string;
  checker: { id: string; displayName: string } | null;
  troubleshooter: { id: string; displayName: string } | null;
  reportedAt: Date;
  discoveredAt: Date | null;
  retrievedAt: Date | null;
  resolvedAt: Date | null;
  configurationVersion: number;
};

export type AnalyticsEventRow = {
  id: string;
  caseId: string;
  lineId: string | null;
  orderNumber: string;
  eventType: string;
  actor: { id: string; displayName: string } | null;
  details: Record<string, unknown>;
  createdAt: Date;
};

export type AnalyticsSeriesPoint = { period: string; cases: number; lines: number; count: number };
export type AnalyticsBreakdown = { key: string; label: string; count: number; lines: number; quantity: number };
export type AnalyticsResponseFilters = AnalyticsFilters & {
  phases: Array<CaseRow["phase"]>;
  resolutions: string[];
  sources: Array<CaseRow["source"]>;
  configurations: Array<{ id: string; label: string; version: number }>;
};

export type SameLocationFoundSummary = {
  numerator: number;
  denominator: number;
  percentage: number | null;
  percentageSuppressed: boolean;
  from: Date;
  to: Date;
  counts: Record<ConclusiveCheckOutcome, number>;
};

export type SameLocationFoundUser = SameLocationFoundSummary & {
  userId: string;
  displayName: string;
  role: string;
};

export type AnalyticsUserDirectoryEntry = { id: string; displayName: string; role: string };

export type AnalyticsData = {
  filters: AnalyticsResponseFilters;
  kpis: {
    totalCases: number;
    totalLines: number;
    casesByPeriod: AnalyticsSeriesPoint[];
    linesByLocation: AnalyticsBreakdown[];
    linesBySku: AnalyticsBreakdown[];
    foundDuringCheck: number;
    notFound: number;
    wrongLocation: number;
    retrieved: number;
    medianReportToCheckClaimedSeconds: number | null;
    medianReportToLocationFoundSeconds: number | null;
    medianReportToRetrievalSeconds: number | null;
    medianReportToResolutionSeconds: number | null;
    casesOverThreshold: number;
    manualCases: number;
    reopenedCases: number;
    repeatedOrderNumbers: number;
    casesByConfigurationVersion: Array<{ version: number; label: string; cases: number; count: number }>;
    sameLocationFound: SameLocationFoundSummary;
    sameLocationFoundByUser: SameLocationFoundUser[];
    userDirectory: AnalyticsUserDirectoryEntry[];
    metricsArePartial: boolean;
    partialMetrics: string[];
  };
  duplicates: {
    repeatedOrderCount: number;
    orders: Array<{ orderNumber: string; occurrences: number; cases: Array<{ caseId: string; createdAt: Date }> }>;
  };
  rows: { cases: AnalyticsCaseRow[]; lines: AnalyticsLineRow[] };
  limits: { maxCases: number; maxLines: number; maxEvents: number; casesTruncated: boolean; linesTruncated: boolean; eventsTruncated: boolean; tasksTruncated: boolean; duplicateOrdersTruncated: boolean; derivedMetricsTruncated: boolean };
};

type EventWithActor = EventRow & { actor: { id: string; displayName: string } | null };

function dateSeconds(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end || end.getTime() < start.getTime()) return null;
  return (end.getTime() - start.getTime()) / 1_000;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function periodKind(filters: AnalyticsFilters): "day" | "week" | "month" {
  const days = ((filters.toExclusive ?? filters.to).getTime() - filters.from.getTime()) / 86_400_000;
  return days <= 31 ? "day" : days <= 180 ? "week" : "month";
}

function periodKey(date: Date, kind: "day" | "week" | "month") {
  const value = new Date(date);
  if (kind === "month") return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
  if (kind === "week") {
    const day = value.getUTCDay() || 7;
    value.setUTCDate(value.getUTCDate() - day + 1);
  }
  return value.toISOString().slice(0, 10);
}

function thresholdFor(values: unknown): number {
  if (!values || typeof values !== "object") return 0;
  const value = (values as Record<string, unknown>).CRITICAL_THRESHOLD_MINUTES;
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function resolutionPredicate(db: Db, code: string) {
  // completionCode is a DB enum; unknown values (e.g. FOUND_AT_ORIGINAL before the
  // migration lands) are matched as text so the query never fails on a cast.
  const matchingTask = db.select({ id: checkTasks.id }).from(checkTasks).where(and(
    eq(checkTasks.shortPickLineId, shortPickLines.id), sql`${checkTasks.completionCode}::text = ${code}`,
  ));
  return or(eq(shortPickLines.resolutionCode, code), exists(matchingTask)) ?? sql`false`;
}

function linePredicate(db: Db, filters: AnalyticsFilters, caseIds?: string[]) {
  const predicates: SQL<unknown>[] = [];
  if (caseIds) predicates.push(inArray(shortPickLines.caseId, caseIds));
  if (filters.location) predicates.push(eq(shortPickLines.originalLocation, filters.location.trim().toUpperCase()));
  if (filters.sku) predicates.push(eq(shortPickLines.sku, filters.sku.trim().toUpperCase()));
  if (filters.resolution) predicates.push(resolutionPredicate(db, filters.resolution));
  return and(...predicates) ?? sql`true`;
}

function buildCasePredicates(db: Db, filters: AnalyticsFilters, includeCreatedDate = true) {
  const predicates = [] as SQL<unknown>[];
  if (includeCreatedDate) predicates.push(gte(orderCases.createdAt, filters.from), lt(orderCases.createdAt, filters.toExclusive ?? filters.to));
  if (filters.orderNumber) predicates.push(eq(orderCases.orderNumber, filters.orderNumber.trim()));
  if (filters.phase) predicates.push(eq(orderCases.phase, filters.phase));
  if (filters.source) predicates.push(eq(orderCases.source, filters.source));
  if (filters.pickerUserId) predicates.push(eq(orderCases.pickingUserId, filters.pickerUserId));
  if (filters.configVersion) predicates.push(eq(configurationVersions.version, filters.configVersion));
  if (filters.location || filters.sku || filters.resolution) {
    const matchingLine = [eq(shortPickLines.caseId, orderCases.id)];
    if (filters.location) matchingLine.push(eq(shortPickLines.originalLocation, filters.location.trim().toUpperCase()));
    if (filters.sku) matchingLine.push(eq(shortPickLines.sku, filters.sku.trim().toUpperCase()));
    if (filters.resolution) matchingLine.push(resolutionPredicate(db, filters.resolution));
    predicates.push(exists(db.select({ id: shortPickLines.id }).from(shortPickLines).where(and(...matchingLine))));
  }
  if (filters.checkerUserId) {
    predicates.push(exists(db.select({ id: checkTasks.id }).from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id)).where(and(
      eq(shortPickLines.caseId, orderCases.id), or(eq(checkTasks.claimedByUserId, filters.checkerUserId), eq(checkTasks.assignedToUserId, filters.checkerUserId)),
    ))));
  }
  if (filters.troubleshooterUserId) predicates.push(or(
    eq(orderCases.currentCaseResponsibleUserId, filters.troubleshooterUserId),
    exists(db.select({ id: shortPickLines.id }).from(shortPickLines).where(and(eq(shortPickLines.caseId, orderCases.id), eq(shortPickLines.retrievalResponsibleUserId, filters.troubleshooterUserId)))),
    exists(db.select({ id: caseEvents.id }).from(caseEvents).where(and(eq(caseEvents.caseId, orderCases.id), sql`${caseEvents.details}->>'responsibleUserId' = ${filters.troubleshooterUserId}`))),
  ) ?? sql`false`);
  return and(...predicates) ?? sql`true`;
}

async function loadUsers(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; displayName: string }>();
  const rows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

function isConclusiveOutcome(code: unknown): code is ConclusiveCheckOutcome {
  return typeof code === "string" && (CONCLUSIVE_CHECK_OUTCOMES as readonly string[]).includes(code);
}

function emptyOutcomeCounts(): Record<ConclusiveCheckOutcome, number> {
  return { FOUND_AT_ORIGINAL: 0, FOUND: 0, NOT_FOUND: 0, WRONG_LOCATION: 0 };
}

function summarizeOutcomes(outcomes: ConclusiveCheckOutcome[], from: Date, to: Date): SameLocationFoundSummary {
  const counts = emptyOutcomeCounts();
  for (const outcome of outcomes) counts[outcome] += 1;
  const denominator = outcomes.length;
  const numerator = counts.FOUND_AT_ORIGINAL;
  const suppressed = denominator > 0 && denominator < SAME_LOCATION_FOUND_MIN_DENOMINATOR;
  return { numerator, denominator, percentage: !suppressed && denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null, percentageSuppressed: suppressed, from, to, counts };
}

export type SameLocationFoundLineInput = { id: string; reportedByUserId: string; reportedAt: Date };
export type SameLocationFoundTaskInput = { shortPickLineId: string; completionCode: unknown; completedAt: Date | null; createdAt: Date };

/**
 * Same-location-found metric over already-fetched lines + tasks.
 * denominator = unique reported lines with a final conclusive outcome;
 * numerator = lines whose latest conclusive outcome is FOUND_AT_ORIGINAL.
 * Latest wins (authorized corrections included); repeat checks never double-count.
 * Excludes unfinished lines, OTHER, and cancelled lines without a conclusive check.
 */
export function computeSameLocationFound(
  lines: SameLocationFoundLineInput[],
  tasks: SameLocationFoundTaskInput[],
  from: Date,
  to: Date,
): { overall: SameLocationFoundSummary; byReporter: Map<string, ConclusiveCheckOutcome[]> } {
  const tasksByLine = new Map<string, SameLocationFoundTaskInput[]>();
  for (const task of tasks) tasksByLine.set(task.shortPickLineId, [...(tasksByLine.get(task.shortPickLineId) ?? []), task]);
  const latestOutcome = new Map<string, ConclusiveCheckOutcome>();
  for (const line of lines) {
    if (line.reportedAt < from || line.reportedAt >= to) continue;
    const conclusive = (tasksByLine.get(line.id) ?? [])
      .filter((task) => isConclusiveOutcome(task.completionCode))
      .sort((a, b) => (a.completedAt ?? a.createdAt).getTime() - (b.completedAt ?? b.createdAt).getTime());
    if (!conclusive.length) continue;
    latestOutcome.set(line.id, conclusive[conclusive.length - 1]!.completionCode as ConclusiveCheckOutcome);
  }
  const byReporter = new Map<string, ConclusiveCheckOutcome[]>();
  const overallOutcomes: ConclusiveCheckOutcome[] = [];
  for (const line of lines) {
    const outcome = latestOutcome.get(line.id);
    if (!outcome) continue;
    overallOutcomes.push(outcome);
    byReporter.set(line.reportedByUserId, [...(byReporter.get(line.reportedByUserId) ?? []), outcome]);
  }
  return { overall: summarizeOutcomes(overallOutcomes, from, to), byReporter };
}

function ensurePermission(auth: AuthContext, permission: "VIEW_ANALYTICS" | "EXPORT_ANALYTICS") {
  if (!hasAuthPermission(auth, permission)) throw new CaseApiError("CASE_ACCESS_DENIED", `${permission} permission required`, 403);
}

async function queryAnalytics(filters: AnalyticsFilters): Promise<AnalyticsData> {
  const db = getDb();
  const caseWhere = buildCasePredicates(db, filters);
  const caseCountResult = await db.select({ count: sql<number>`count(*)::int` }).from(orderCases).innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id)).where(caseWhere);
  const totalCases = Number(caseCountResult[0]?.count ?? 0);
  const caseRowsRaw = await db.select({ case: orderCases, config: configurationVersions,
    pickerId: sql<string | null>`${sql.identifier("picker_users")}.id`, pickerName: sql<string | null>`${sql.identifier("picker_users")}.display_name`,
    responsibleId: sql<string | null>`${sql.identifier("responsible_users")}.id`, responsibleName: sql<string | null>`${sql.identifier("responsible_users")}.display_name`,
  }).from(orderCases)
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
    .leftJoin(sql`users AS picker_users`, sql`picker_users.id = ${orderCases.pickingUserId}`)
    .leftJoin(sql`users AS responsible_users`, sql`responsible_users.id = ${orderCases.currentCaseResponsibleUserId}`)
    .where(caseWhere).orderBy(asc(orderCases.createdAt), asc(orderCases.id)).limit(ANALYTICS_LIMITS.maxCases);
  const caseIds = caseRowsRaw.map((row) => row.case.id);
  const casesTruncated = totalCases > caseRowsRaw.length;
  const lineCountResult = await db.select({ count: sql<number>`count(*)::int` }).from(shortPickLines)
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
    .where(and(caseWhere, linePredicate(db, filters)));
  const totalLines = Number(lineCountResult[0]?.count ?? 0);
  const linesRaw = caseIds.length ? await db.select().from(shortPickLines).where(linePredicate(db, filters, caseIds)).orderBy(asc(shortPickLines.reportedAt), asc(shortPickLines.id)).limit(ANALYTICS_LIMITS.maxLines) : [];
  const linesTruncated = casesTruncated || totalLines > linesRaw.length;
  const lineIds = linesRaw.map((line) => line.id);
  const tasksRaw: TaskRow[] = lineIds.length ? await db.select().from(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds)).orderBy(asc(checkTasks.createdAt), asc(checkTasks.id)).limit(ANALYTICS_LIMITS.maxEvents) : [];
  const taskCountResult = lineIds.length ? await db.select({ count: sql<number>`count(*)::int` }).from(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds)) : [{ count: 0 }];
  const tasksTruncated = Number(taskCountResult[0]?.count ?? 0) > tasksRaw.length;
  const eventsRaw: EventWithActor[] = caseIds.length ? await db.select({ event: caseEvents, actorId: users.id, actorName: users.displayName }).from(caseEvents)
    .leftJoin(users, eq(caseEvents.actorUserId, users.id)).where(inArray(caseEvents.caseId, caseIds)).orderBy(asc(caseEvents.createdAt), asc(caseEvents.id)).limit(ANALYTICS_LIMITS.maxEvents)
    .then((rows) => rows.map((row) => ({ ...row.event, actor: row.actorId ? { id: row.actorId, displayName: row.actorName! } : null }))) : [];
  const eventCountResult = caseIds.length ? await db.select({ count: sql<number>`count(*)::int` }).from(caseEvents).where(inArray(caseEvents.caseId, caseIds)) : [{ count: 0 }];
  const eventsTruncated = Number(eventCountResult[0]?.count ?? 0) > eventsRaw.length;
  const caseById = new Map(caseRowsRaw.map((row) => [row.case.id, row]));
  const tasksByLine = new Map<string, TaskRow[]>();
  for (const task of tasksRaw) tasksByLine.set(task.shortPickLineId, [...(tasksByLine.get(task.shortPickLineId) ?? []), task]);
  const eventsByCase = new Map<string, EventWithActor[]>();
  const eventsByLine = new Map<string, EventWithActor[]>();
  for (const event of eventsRaw) {
    eventsByCase.set(event.caseId, [...(eventsByCase.get(event.caseId) ?? []), event]);
    if (event.shortPickLineId) eventsByLine.set(event.shortPickLineId, [...(eventsByLine.get(event.shortPickLineId) ?? []), event]);
  }
  const participantIds: string[] = [];
  for (const row of caseRowsRaw) { if (row.pickerId) participantIds.push(row.pickerId); if (row.responsibleId) participantIds.push(row.responsibleId); }
  for (const line of linesRaw) { participantIds.push(line.reportedByUserId); for (const task of tasksByLine.get(line.id) ?? []) { if (task.claimedByUserId) participantIds.push(task.claimedByUserId); if (task.assignedToUserId) participantIds.push(task.assignedToUserId); } if (line.retrievalResponsibleUserId) participantIds.push(line.retrievalResponsibleUserId); }
  const people = await loadUsers(db, participantIds);
  const caseRows: AnalyticsCaseRow[] = caseRowsRaw.map((row) => {
    const thresholdMinutes = thresholdFor(row.config.values);
    const end = row.case.resolvedAt ?? new Date();
    return { id: row.case.id, orderNumber: row.case.orderNumber, phase: row.case.phase, physicalState: row.case.physicalState,
      physicalLocation: row.case.physicalLocation, source: row.case.source, manualReason: row.case.manualReason,
      picker: row.pickerId ? { id: row.pickerId, displayName: row.pickerName! } : null,
      responsible: row.responsibleId ? { id: row.responsibleId, displayName: row.responsibleName! } : null,
      configurationVersion: { id: row.config.id, version: row.config.version }, criticalThresholdMinutes: thresholdMinutes,
      overThreshold: thresholdMinutes > 0 && (end.getTime() - row.case.createdAt.getTime()) / 60_000 > thresholdMinutes,
      createdAt: row.case.createdAt, stagedAt: row.case.stagedAt, resolvedAt: row.case.resolvedAt, reopenedAt: row.case.reopenedAt,
      lineCount: linesRaw.filter((line) => line.caseId === row.case.id).length };
  });
  const linesByCase = new Map<string, LineRow[]>();
  for (const line of linesRaw) linesByCase.set(line.caseId, [...(linesByCase.get(line.caseId) ?? []), line]);
  const lineRows: AnalyticsLineRow[] = linesRaw.map((line) => {
    const tasks = tasksByLine.get(line.id) ?? [];
    const checkTask = [...tasks].reverse().find((task) => task.completionCode || task.claimedByUserId || task.assignedToUserId);
    const checkerId = checkTask?.assignedToUserId ?? checkTask?.claimedByUserId ?? null;
    const troubleshooterId = line.retrievalResponsibleUserId;
    const configVersion = caseById.get(line.caseId)?.config.version ?? 0;
    return { id: line.id, caseId: line.caseId, orderNumber: caseById.get(line.caseId)?.case.orderNumber ?? "", originalLocation: line.originalLocation,
      sku: line.sku, missingQuantity: line.missingQuantity, state: line.state, resolutionCode: line.resolutionCode, retrievalState: line.retrievalState,
      reportedByUserId: line.reportedByUserId, checker: checkerId && people.has(checkerId) ? people.get(checkerId)! : null,
      troubleshooter: troubleshooterId && people.has(troubleshooterId) ? people.get(troubleshooterId)! : null,
      reportedAt: line.reportedAt, discoveredAt: line.discoveredAt, retrievedAt: line.retrievedAt, resolvedAt: line.resolvedAt, configurationVersion: configVersion };
  });
  const eventRows: AnalyticsEventRow[] = eventsRaw.map((event) => ({ id: event.id, caseId: event.caseId, lineId: event.shortPickLineId,
    orderNumber: caseById.get(event.caseId)?.case.orderNumber ?? "", eventType: event.eventType, actor: event.actor, details: event.details, createdAt: event.createdAt }));

  const groupedPeriods = new Map<string, AnalyticsSeriesPoint>();
  for (const row of caseRows) { const key = periodKey(row.createdAt, periodKind(filters)); const point = groupedPeriods.get(key) ?? { period: key, cases: 0, lines: 0, count: 0 }; point.cases += 1; point.count += 1; point.lines += linesByCase.get(row.id)?.length ?? 0; groupedPeriods.set(key, point); }
  const breakdown = (keyOf: (line: AnalyticsLineRow) => string): AnalyticsBreakdown[] => {
    const grouped = new Map<string, AnalyticsBreakdown>();
    for (const line of lineRows) { const key = keyOf(line); const current = grouped.get(key) ?? { key, label: key, count: 0, lines: 0, quantity: 0 }; current.count += 1; current.lines += 1; current.quantity += line.missingQuantity; grouped.set(key, current); }
    return [...grouped.values()].sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key)).slice(0, 1_000);
  };
  const eventsForLine = (id: string) => eventsByLine.get(id) ?? [];
  const firstEvent = (id: string, types: string[]) => eventsForLine(id).find((event) => types.includes(event.eventType))?.createdAt ?? null;
  const claimedDurations: number[] = [], foundDurations: number[] = [], retrievalDurations: number[] = [], resolutionDurations: number[] = [];
  for (const line of lineRows) {
    claimedDurations.push(...(function () { const value = dateSeconds(line.reportedAt, firstEvent(line.id, ["CHECK_CLAIMED", "CHECK_ASSIGNED"])); return value === null ? [] : [value]; })());
    foundDurations.push(...(function () { const value = dateSeconds(line.reportedAt, firstEvent(line.id, ["NEW_LOCATION_REPORTED"])); return value === null ? [] : [value]; })());
    retrievalDurations.push(...(function () { const value = dateSeconds(line.reportedAt, firstEvent(line.id, ["RETRIEVAL_CONFIRMED"])); return value === null ? [] : [value]; })());
    // A check finding stock is an intermediate location event. Resolution is the
    // line's terminal timestamp, which also covers administrative resolution.
    resolutionDurations.push(...(function () { const value = dateSeconds(line.reportedAt, line.resolvedAt); return value === null ? [] : [value]; })());
  }
  const codeLines = new Map<string, Set<string>>();
  for (const task of tasksRaw) {
    const code = String(task.completionCode ?? "");
    if (!code) continue;
    codeLines.set(code, new Set([...(codeLines.get(code) ?? []), task.shortPickLineId]));
  }
  const codeCounts = new Map([...codeLines.entries()].map(([code, lineIds]) => [code, lineIds.size]));
  const reopenedCases = new Set(eventRows.filter((event) => event.eventType === "CASE_REOPENED").map((event) => event.caseId)).size;
  const repeatedGroupsQuery = db.select({ orderNumber: orderCases.orderNumber, count: sql<number>`count(*)::int` }).from(orderCases)
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id)).where(caseWhere).groupBy(orderCases.orderNumber).having(sql`count(*) > 1`).orderBy(desc(sql`count(*)`)).limit(ANALYTICS_LIMITS.maxDuplicateOrders);
  const repeatedCountQuery = db.select({ count: sql<number>`count(*)::int` }).from(
    db.select({ orderNumber: orderCases.orderNumber }).from(orderCases)
      .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id)).where(caseWhere).groupBy(orderCases.orderNumber).having(sql`count(*) > 1`).as("repeated_order_groups"),
  );
  const [repeatedCountRow] = await repeatedCountQuery;
  const repeatedOrderCount = Number(repeatedCountRow?.count ?? 0);
  const repeatedGrouped = await repeatedGroupsQuery;
  const duplicateOrders = repeatedGrouped.length ? await db.select({ id: orderCases.id, orderNumber: orderCases.orderNumber, createdAt: orderCases.createdAt }).from(orderCases)
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
    .where(and(caseWhere, inArray(orderCases.orderNumber, repeatedGrouped.map((row) => row.orderNumber)))).orderBy(asc(orderCases.orderNumber), asc(orderCases.createdAt)).limit(ANALYTICS_LIMITS.maxCases) : [];
  const duplicateCounts = new Map(repeatedGrouped.map((row) => [row.orderNumber, Number(row.count)]));
  const duplicates = [...duplicateCounts.entries()].map(([orderNumber, occurrences]) => ({ orderNumber, occurrences, cases: duplicateOrders.filter((row) => row.orderNumber === orderNumber).map((row) => ({ caseId: row.id, createdAt: row.createdAt })) }));
  const duplicateDatesExpected = [...duplicateCounts.values()].reduce((total, count) => total + count, 0);
  const duplicateOrdersTruncated = repeatedOrderCount > repeatedGrouped.length || duplicateOrders.length < duplicateDatesExpected;
  const repeatedOrderNumbers = repeatedOrderCount;
  const casesByConfigurationVersion = [...caseRows.reduce((map, row) => map.set(row.configurationVersion.version, (map.get(row.configurationVersion.version) ?? 0) + 1), new Map<number, number>())].map(([version, cases]) => ({ version, label: String(version), cases, count: cases })).sort((a, b) => a.version - b.version);
  const toExclusive = filters.toExclusive ?? filters.to;
  // Same-location-found runs over its own bounded line+task read so the metric stays
  // exact even when the dashboard row caps truncate the visible tables.
  const metricLineWhere = and(caseWhere, filters.location ? eq(shortPickLines.originalLocation, filters.location.trim().toUpperCase()) : undefined, filters.sku ? eq(shortPickLines.sku, filters.sku.trim().toUpperCase()) : undefined, filters.resolution ? resolutionPredicate(db, filters.resolution) : undefined, gte(shortPickLines.reportedAt, filters.from), lt(shortPickLines.reportedAt, toExclusive));
  const metricLinesRaw = await db.select({ id: shortPickLines.id, reportedByUserId: shortPickLines.reportedByUserId, reportedAt: shortPickLines.reportedAt }).from(shortPickLines)
    .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
    .where(metricLineWhere).limit(ANALYTICS_LIMITS.maxLines);
  const metricLineIds = metricLinesRaw.map((line) => line.id);
  // completionCode is a DB enum: read it as text so FOUND_AT_ORIGINAL survives whether
  // or not the domain A1 enum migration has landed in this checkout.
  const metricTasksRaw = metricLineIds.length ? await db.select({ shortPickLineId: checkTasks.shortPickLineId, completionCode: sql<string | null>`${checkTasks.completionCode}::text`, completedAt: checkTasks.completedAt, createdAt: checkTasks.createdAt }).from(checkTasks).where(inArray(checkTasks.shortPickLineId, metricLineIds)) : [];
  const metric = computeSameLocationFound(metricLinesRaw, metricTasksRaw, filters.from, toExclusive);
  const reporterIds = [...metric.byReporter.keys()];
  const reporterRows = reporterIds.length ? await db.select({ id: users.id, displayName: users.displayName, role: users.role }).from(users).where(inArray(users.id, reporterIds)) : [];
  const reporterById = new Map(reporterRows.map((row) => [row.id, row]));
  const sameLocationFoundByUser: SameLocationFoundUser[] = [...metric.byReporter.entries()]
    .map(([userId, outcomes]) => ({ userId, displayName: reporterById.get(userId)?.displayName ?? userId, role: reporterById.get(userId)?.role ?? "PICKER", ...summarizeOutcomes(outcomes, filters.from, toExclusive) }))
    .filter((entry) => !filters.role || entry.role === filters.role)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const directoryRows = await db.select({ id: users.id, displayName: users.displayName, role: users.role }).from(users).orderBy(asc(users.displayName)).limit(500);
  const userDirectory: AnalyticsUserDirectoryEntry[] = directoryRows
    .filter((row) => !filters.role || row.role === filters.role)
    .map((row) => ({ id: row.id, displayName: row.displayName, role: row.role }));
  const sameLocationFound = filters.role
    ? summarizeOutcomes(sameLocationFoundByUser.flatMap((entry) => Object.entries(entry.counts).flatMap(([code, count]) => Array<ConclusiveCheckOutcome>(count).fill(code as ConclusiveCheckOutcome))), filters.from, toExclusive)
    : metric.overall;
  const partialMetrics = new Set<string>();
  if (casesTruncated) for (const metric of ["casesByPeriod", "casesOverThreshold", "manualCases", "reopenedCases", "casesByConfigurationVersion"]) partialMetrics.add(metric);
  if (linesTruncated) for (const metric of ["linesByLocation", "linesBySku", "foundDuringCheck", "notFound", "wrongLocation", "retrieved", "medianReportToCheckClaimedSeconds", "medianReportToLocationFoundSeconds", "medianReportToRetrievalSeconds", "medianReportToResolutionSeconds"]) partialMetrics.add(metric);
  if (eventsTruncated) for (const metric of ["medianReportToCheckClaimedSeconds", "medianReportToLocationFoundSeconds", "medianReportToRetrievalSeconds", "medianReportToResolutionSeconds", "reopenedCases"]) partialMetrics.add(metric);
  if (tasksTruncated) for (const metric of ["foundDuringCheck", "notFound", "wrongLocation", "medianReportToCheckClaimedSeconds"]) partialMetrics.add(metric);
  if (duplicateOrdersTruncated) partialMetrics.add("duplicates");
  const displayFilters = { ...filters };
  delete displayFilters.toExclusive;
  const responseFilters: AnalyticsResponseFilters = { ...displayFilters, phases: ["PICKING", "STAGED", "CLOSED"], resolutions: ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER", "FOUND_AT_ORIGINAL"], sources: ["PICKER_REPORT", "TL_MANUAL", "ASSISTANT_MANUAL", "MANAGER_MANUAL", "ADMIN_MANUAL"], configurations: caseRows.map((row) => ({ id: String(row.configurationVersion.version), label: String(row.configurationVersion.version), version: row.configurationVersion.version })).filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index) };
  return { filters: responseFilters, kpis: { totalCases, totalLines, casesByPeriod: [...groupedPeriods.values()].sort((a, b) => a.period.localeCompare(b.period)), linesByLocation: breakdown((line) => line.originalLocation), linesBySku: breakdown((line) => line.sku),
    foundDuringCheck: codeCounts.get("FOUND") ?? 0, notFound: codeCounts.get("NOT_FOUND") ?? 0, wrongLocation: codeCounts.get("WRONG_LOCATION") ?? 0, retrieved: lineRows.filter((line) => line.retrievalState === "RETRIEVED").length,
    medianReportToCheckClaimedSeconds: median(claimedDurations), medianReportToLocationFoundSeconds: median(foundDurations), medianReportToRetrievalSeconds: median(retrievalDurations), medianReportToResolutionSeconds: median(resolutionDurations),
    casesOverThreshold: caseRows.filter((row) => row.overThreshold).length, manualCases: caseRows.filter((row) => row.source !== "PICKER_REPORT").length, reopenedCases, repeatedOrderNumbers, casesByConfigurationVersion, sameLocationFound, sameLocationFoundByUser, userDirectory, metricsArePartial: partialMetrics.size > 0, partialMetrics: [...partialMetrics] },
    duplicates: { repeatedOrderCount: repeatedOrderNumbers, orders: duplicates }, rows: { cases: caseRows, lines: lineRows }, limits: { maxCases: ANALYTICS_LIMITS.maxCases, maxLines: ANALYTICS_LIMITS.maxLines, maxEvents: ANALYTICS_LIMITS.maxEvents, casesTruncated, linesTruncated, eventsTruncated, tasksTruncated, duplicateOrdersTruncated, derivedMetricsTruncated: partialMetrics.size > 0 },
  };
}

/** Dashboard query. Routes still authenticate before calling this service. */
export async function getAnalyticsData(auth: AuthContext, filters: AnalyticsFilters): Promise<AnalyticsData> {
  ensurePermission(auth, "VIEW_ANALYTICS");
  return queryAnalytics(filters);
}

/** Export/PDF query with the stronger export permission. */
export async function getAnalyticsReportData(auth: AuthContext, filters: AnalyticsFilters): Promise<AnalyticsData> {
  ensurePermission(auth, "EXPORT_ANALYTICS");
  return queryAnalytics(filters);
}

export async function getAnalyticsEvents(auth: AuthContext, filters: AnalyticsFilters): Promise<{ rows: AnalyticsEventRow[]; truncated: boolean }> {
  ensurePermission(auth, "EXPORT_ANALYTICS");
  const db = getDb();
  const matchingCases = await db.select({ id: orderCases.id }).from(orderCases)
    .innerJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
    .where(buildCasePredicates(db, filters, false)).orderBy(asc(orderCases.createdAt), asc(orderCases.id)).limit(ANALYTICS_LIMITS.maxCases + 1);
  const casesTruncated = matchingCases.length > ANALYTICS_LIMITS.maxCases;
  const caseIds = matchingCases.slice(0, ANALYTICS_LIMITS.maxCases).map((row) => row.id);
  if (!caseIds.length) return { rows: [], truncated: casesTruncated };
  const matchingLines = await db.select({ id: shortPickLines.id }).from(shortPickLines).where(linePredicate(db, filters, caseIds)).orderBy(asc(shortPickLines.reportedAt), asc(shortPickLines.id)).limit(ANALYTICS_LIMITS.maxLines + 1);
  const linesTruncated = matchingLines.length > ANALYTICS_LIMITS.maxLines;
  const lineIds = matchingLines.slice(0, ANALYTICS_LIMITS.maxLines).map((row) => row.id);
  const eventWhere = and(
    inArray(caseEvents.caseId, caseIds),
    gte(caseEvents.createdAt, filters.from), lt(caseEvents.createdAt, filters.toExclusive ?? filters.to),
    or(isNull(caseEvents.shortPickLineId), lineIds.length ? inArray(caseEvents.shortPickLineId, lineIds) : sql`false`),
  ) ?? sql`false`;
  const count = await db.select({ count: sql<number>`count(*)::int` }).from(caseEvents).where(eventWhere);
  const rows = await db.select({ event: caseEvents, orderNumber: orderCases.orderNumber, actorId: users.id, actorName: users.displayName }).from(caseEvents)
    .innerJoin(orderCases, eq(caseEvents.caseId, orderCases.id)).leftJoin(users, eq(caseEvents.actorUserId, users.id)).where(eventWhere).orderBy(asc(caseEvents.createdAt), asc(caseEvents.id)).limit(ANALYTICS_LIMITS.maxEvents);
  return { rows: rows.map((row) => ({ id: row.event.id, caseId: row.event.caseId, lineId: row.event.shortPickLineId, orderNumber: row.orderNumber, eventType: row.event.eventType,
    actor: row.actorId ? { id: row.actorId, displayName: row.actorName! } : null, details: row.event.details, createdAt: row.event.createdAt })), truncated: casesTruncated || linesTruncated || Number(count[0]?.count ?? 0) > rows.length };
}

export type AnalyticsCsvDataset = "case" | "line" | "event" | "same-location-found" | "same-location-found-overall";

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Excel and compatible spreadsheet applications execute these leading characters as formulas.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function analyticsCsv(data: AnalyticsData, dataset: "case" | "line", rows?: AnalyticsCaseRow[] | AnalyticsLineRow[]): string {
  const headers = dataset === "case"
    ? ["case_id", "order_number", "phase", "physical_state", "physical_location", "source", "manual_reason", "picker_user_id", "picker_name", "responsible_user_id", "responsible_name", "configuration_version", "critical_threshold_minutes", "over_threshold", "created_at", "staged_at", "resolved_at", "reopened_at", "line_count"]
    : ["line_id", "case_id", "order_number", "original_location", "sku", "missing_quantity", "state", "resolution_code", "retrieval_state", "reported_by_user_id", "checker_user_id", "checker_name", "troubleshooter_user_id", "troubleshooter_name", "reported_at", "discovered_at", "retrieved_at", "resolved_at", "configuration_version"];
  const selected = rows ?? (dataset === "case" ? data.rows.cases : data.rows.lines);
  const body = dataset === "case"
    ? (selected as AnalyticsCaseRow[]).map((row) => [row.id, row.orderNumber, row.phase, row.physicalState, row.physicalLocation, row.source, row.manualReason, row.picker?.id, row.picker?.displayName, row.responsible?.id, row.responsible?.displayName, row.configurationVersion.version, row.criticalThresholdMinutes, row.overThreshold, row.createdAt, row.stagedAt, row.resolvedAt, row.reopenedAt, row.lineCount])
    : (selected as AnalyticsLineRow[]).map((row) => [row.id, row.caseId, row.orderNumber, row.originalLocation, row.sku, row.missingQuantity, row.state, row.resolutionCode, row.retrievalState, row.reportedByUserId, row.checker?.id, row.checker?.displayName, row.troubleshooter?.id, row.troubleshooter?.displayName, row.reportedAt, row.discoveredAt, row.retrievedAt, row.resolvedAt, row.configurationVersion]);
  return [headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function analyticsEventCsv(rows: AnalyticsEventRow[]): string {
  const headers = ["event_id", "case_id", "line_id", "order_number", "event_type", "actor_user_id", "actor_name", "details_json", "created_at"];
  return [headers, ...rows.map((row) => [row.id, row.caseId, row.lineId, row.orderNumber, row.eventType, row.actor?.id, row.actor?.displayName, row.details, row.createdAt])]
    .map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Per-user same-location-found CSV: one row per reporting picker with identical counts to the dashboard. */
export function sameLocationFoundCsv(summary: SameLocationFoundUser[]): string {
  const headers = ["user_id", "display_name", "role", "numerator_found_at_original", "denominator_eligible_lines", "percentage", "count_found_at_original", "count_found", "count_not_found", "count_wrong_location", "from", "to"];
  const body = summary.map((row) => [row.userId, row.displayName, row.role, row.numerator, row.denominator, row.percentage ?? "", row.counts.FOUND_AT_ORIGINAL, row.counts.FOUND, row.counts.NOT_FOUND, row.counts.WRONG_LOCATION, row.from, row.to]);
  return [headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Overall same-location-found summary row for CSV export parity. */
export function sameLocationFoundOverallCsv(summary: SameLocationFoundSummary): string {
  const headers = ["numerator_found_at_original", "denominator_eligible_lines", "percentage", "count_found_at_original", "count_found", "count_not_found", "count_wrong_location", "from", "to"];
  const body = [[summary.numerator, summary.denominator, summary.percentage ?? "", summary.counts.FOUND_AT_ORIGINAL, summary.counts.FOUND, summary.counts.NOT_FOUND, summary.counts.WRONG_LOCATION, summary.from, summary.to]];
  return [headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
