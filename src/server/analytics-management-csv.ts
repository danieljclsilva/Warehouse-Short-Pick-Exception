import type { AnalyticsManagement } from "@/domain/analytics-management";
import { csvCell } from "@/server/analytics";

/** Normalized scopes, with missing percentages/ages left blank rather than guessed. */
export function managementAnalyticsCsv(data: AnalyticsManagement): string {
  const headers = ["section", "metric", "value", "previous", "delta", "percentage", "from", "to_exclusive", "as_of", "order_number",
    "selected_period_occurrences", "first_seen_at", "last_seen_at", "details_truncated", "case_id", "created_at"] as const;
  type Row = Partial<Record<typeof headers[number], string | number | boolean | null>>;
  const rows: Row[] = [];
  const { comparison, backlog, lifetimeRecurrence } = data;
  for (const [metric, change] of Object.entries(comparison.changes)) {
    rows.push({ section: "comparison_current", metric, value: change.current, previous: change.previous, delta: change.delta,
      percentage: change.percentage, from: comparison.current.from, to_exclusive: comparison.current.toExclusive });
    rows.push({ section: "comparison_previous", metric, value: change.previous, from: comparison.previous.from, to_exclusive: comparison.previous.toExclusive });
  }
  for (const metric of ["totalOpen", "picking", "staged", "unassignedStaged", "evaluatedCases"] as const) {
    rows.push({ section: "warehouse_backlog", metric, value: backlog[metric], as_of: backlog.asOf, details_truncated: backlog.truncated });
  }
  rows.push({ section: "warehouse_backlog", metric: "oldestCreatedAt", value: backlog.oldestCreatedAt, as_of: backlog.asOf });
  if (!backlog.truncated) {
    rows.push({ section: "warehouse_backlog", metric: "overThreshold", value: backlog.overThreshold, as_of: backlog.asOf, details_truncated: false });
    for (const [metric, value] of Object.entries(backlog.aging)) rows.push({ section: "warehouse_backlog_aging", metric, value, as_of: backlog.asOf, details_truncated: false });
  }
  rows.push({ section: "lifetime_recurrence", metric: "repeatedOrderCount", value: lifetimeRecurrence.repeatedOrderCount, as_of: lifetimeRecurrence.asOf,
    details_truncated: lifetimeRecurrence.groupsTruncated || lifetimeRecurrence.datesTruncated });
  for (const order of lifetimeRecurrence.orders) {
    rows.push({ section: "lifetime_recurrence", metric: "occurrences", value: order.occurrences, order_number: order.orderNumber,
      selected_period_occurrences: order.selectedPeriodOccurrences, first_seen_at: order.firstSeenAt, last_seen_at: order.lastSeenAt,
      as_of: lifetimeRecurrence.asOf, details_truncated: order.datesTruncated });
    for (const entry of order.cases) rows.push({ section: "lifetime_recurrence_history", order_number: order.orderNumber, case_id: entry.caseId,
      created_at: entry.createdAt, as_of: lifetimeRecurrence.asOf, details_truncated: order.datesTruncated });
  }
  return `\uFEFF${headers.join(",")}\r\n${rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")).join("\r\n")}\r\n`;
}
