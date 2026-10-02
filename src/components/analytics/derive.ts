"use client";

export type UnknownRow = Record<string, unknown>;

export type VolumePoint = { period: string; cases: number; lines: number; resolved: number };

export type PeriodKind = "day" | "week" | "month";

export function periodKindForRange(fromMs: number, toMs: number): PeriodKind {
  const days = (toMs - fromMs) / 86_400_000;
  return days <= 31 ? "day" : days <= 180 ? "week" : "month";
}

export function periodKeyFor(date: Date, kind: PeriodKind): string {
  const value = new Date(date);
  if (kind === "month") return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
  if (kind === "week") {
    const day = value.getUTCDay() || 7;
    value.setUTCDate(value.getUTCDate() - day + 1);
  }
  return value.toISOString().slice(0, 10);
}

function asDate(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

/**
 * Merges server-aggregated created-cases/lines per period with resolved counts
 * derived from the loaded case-row slice. `resolved` is slice-based by
 * construction; callers MUST label it as such (see analyticsSliceBasedNote).
 */
export function buildVolumeSeries(
  periods: Array<{ label: string; count: number; lines?: number }>,
  caseRows: UnknownRow[],
  kind: PeriodKind,
): VolumePoint[] {
  const resolvedByPeriod = new Map<string, number>();
  for (const row of caseRows) {
    const resolvedAt = asDate(row.resolvedAt);
    if (!resolvedAt) continue;
    const key = periodKeyFor(resolvedAt, kind);
    resolvedByPeriod.set(key, (resolvedByPeriod.get(key) ?? 0) + 1);
  }
  return periods
    .map((point) => ({
      period: point.label,
      cases: point.count,
      lines: point.lines ?? 0,
      resolved: resolvedByPeriod.get(point.label) ?? 0,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function topN<T extends { label: string; count: number }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, n);
}

/** Phase mix over the loaded case-row slice (bounded by ANALYTICS_LIMITS). */
export function phaseMix(caseRows: UnknownRow[]): Array<{ phase: string; count: number }> {
  const grouped = new Map<string, number>();
  for (const row of caseRows) {
    const phase = typeof row.phase === "string" && row.phase ? row.phase : "UNKNOWN";
    grouped.set(phase, (grouped.get(phase) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .map(([phase, count]) => ({ phase, count }))
    .sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase));
}

export type AgingBuckets = { open: number; under1d: number; d1to3: number; d3to7: number; over7d: number };
const DAY_MS = 86_400_000;
/** Aging of still-open cases in the loaded slice. A case counts as open when it has no resolvedAt. */
export function agingBuckets(caseRows: UnknownRow[], nowMs: number): AgingBuckets {
  const buckets: AgingBuckets = { open: 0, under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 };
  for (const row of caseRows) {
    if (asDate(row.resolvedAt)) continue;
    const createdAt = asDate(row.createdAt);
    if (!createdAt) continue;
    const ageMs = nowMs - createdAt.getTime();
    if (ageMs < 0) continue;
    buckets.open += 1;
    if (ageMs < DAY_MS) buckets.under1d += 1;
    else if (ageMs < 3 * DAY_MS) buckets.d1to3 += 1;
    else if (ageMs < 7 * DAY_MS) buckets.d3to7 += 1;
    else buckets.over7d += 1;
  }
  return buckets;
}

/**
 * Reporting volume per reporter over the loaded line-row slice, joined against
 * the user directory for display names. Sorted by volume; callers present this
 * as workload distribution, never as performance.
 */
export function reporterVolume(
  lineRows: UnknownRow[],
  nameOf: (userId: string) => string | null,
  limit: number,
): Array<{ userId: string; label: string; count: number }> {
  const grouped = new Map<string, number>();
  for (const row of lineRows) {
    const reporter = typeof row.reportedByUserId === "string" ? row.reportedByUserId : "";
    if (!reporter) continue;
    grouped.set(reporter, (grouped.get(reporter) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .map(([userId, count]) => ({ userId, label: nameOf(userId) ?? userId, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}
