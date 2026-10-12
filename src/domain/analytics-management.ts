/** Explicit scopes shared by analytics UI and exports. Timestamps are UTC ISO strings. */
export type PeriodTotals = { from: string; toExclusive: string; cases: number; lines: number; resolvedCases: number };
export type PeriodChange = { current: number; previous: number; delta: number; percentage: number | null };
export type AnalyticsManagement = {
  comparison: {
    current: PeriodTotals;
    previous: PeriodTotals;
    changes: { cases: PeriodChange; lines: PeriodChange; resolvedCases: PeriodChange };
  };
  backlog: {
    asOf: string;
    totalOpen: number;
    picking: number;
    staged: number;
    unassignedStaged: number;
    oldestCreatedAt: string | null;
    evaluatedCases: number;
    truncated: boolean;
    overThreshold: number;
    aging: { under24h: number; h24to72: number; h72to168: number; over168h: number };
  };
  lifetimeRecurrence: {
    asOf: string;
    repeatedOrderCount: number;
    groupsTruncated: boolean;
    datesTruncated: boolean;
    orders: Array<{
      orderNumber: string;
      occurrences: number;
      selectedPeriodOccurrences: number;
      firstSeenAt: string;
      lastSeenAt: string;
      datesTruncated: boolean;
      cases: Array<{ caseId: string; createdAt: string }>;
    }>;
  };
};

export function previousReportingPeriod(from: Date, toExclusive: Date) {
  return { from: new Date(from.valueOf() - (toExclusive.valueOf() - from.valueOf())), toExclusive: new Date(from) };
}

/** A zero baseline has no percentage: distinguish new activity from zero change. */
export function periodChange(current: number, previous: number): PeriodChange {
  return { current, previous, delta: current - previous, percentage: previous === 0 ? null : ((current - previous) / previous) * 100 };
}

/** Reject incomplete API payloads so a missing section cannot render as zero. */
export function normalizeManagement(value: unknown): AnalyticsManagement | undefined {
  const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(new Date(v).valueOf());
  const period = (v: unknown) => record(v) && date(v.from) && date(v.toExclusive) && [v.cases, v.lines, v.resolvedCases].every(count);
  const change = (v: unknown) => record(v) && count(v.current) && count(v.previous) && typeof v.delta === "number" && Number.isFinite(v.delta)
    && (v.percentage === null || typeof v.percentage === "number" && Number.isFinite(v.percentage));
  if (!record(value) || !record(value.comparison) || !record(value.backlog) || !record(value.lifetimeRecurrence)) return undefined;
  const { comparison, backlog, lifetimeRecurrence } = value;
  if (!period(comparison.current) || !period(comparison.previous) || !record(comparison.changes)
    || ![comparison.changes.cases, comparison.changes.lines, comparison.changes.resolvedCases].every(change)) return undefined;
  if (!date(backlog.asOf) || ![backlog.totalOpen, backlog.picking, backlog.staged, backlog.unassignedStaged, backlog.evaluatedCases, backlog.overThreshold].every(count)
    || typeof backlog.truncated !== "boolean" || !(backlog.oldestCreatedAt === null || date(backlog.oldestCreatedAt)) || !record(backlog.aging)
    || ![backlog.aging.under24h, backlog.aging.h24to72, backlog.aging.h72to168, backlog.aging.over168h].every(count)) return undefined;
  if (!date(lifetimeRecurrence.asOf) || !count(lifetimeRecurrence.repeatedOrderCount) || typeof lifetimeRecurrence.groupsTruncated !== "boolean"
    || typeof lifetimeRecurrence.datesTruncated !== "boolean" || !Array.isArray(lifetimeRecurrence.orders)) return undefined;
  if (!lifetimeRecurrence.orders.every((order: unknown) => record(order) && typeof order.orderNumber === "string" && count(order.occurrences)
    && count(order.selectedPeriodOccurrences) && date(order.firstSeenAt) && date(order.lastSeenAt) && typeof order.datesTruncated === "boolean"
    && Array.isArray(order.cases) && order.cases.every((entry: unknown) => record(entry) && typeof entry.caseId === "string" && date(entry.createdAt)))) return undefined;
  return value as AnalyticsManagement;
}
