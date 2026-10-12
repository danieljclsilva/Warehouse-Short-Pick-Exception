"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import styles from "./analytics-dashboard.module.css";
import {
  AgingChart,
  OutcomeBarsChart,
  PhaseDonutChart,
  TopBarsChart,
  VolumeChart,
} from "./analytics/charts";
import {
  agingBuckets,
  buildVolumeSeries,
  periodKindForRange,
  phaseMix,
  hotspotConcentration,
  reportingRangeDays,
  topN,
} from "./analytics/derive";
import {
  AnalyticsFilters,
  isoDay,
  presetRange,
  type ActiveFilterChip,
  type AnalyticsFilterState,
} from "./analytics/filters";

import { isSameLocationReporter } from "@/domain/analytics-same-location";
import { normalizeManagement, type AnalyticsManagement } from "@/domain/analytics-management";
import { ManagementSummary } from "./analytics/management-summary";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

export type AnalyticsFilterOptions = {
  phases?: string[];
  resolutions?: string[];
  sources?: string[];
  configurations?: Array<{ id: string; label?: string; version?: string | number }>;
  pickers?: Array<{ id: string; name: string }>;
  checkers?: Array<{ id: string; name: string }>;
  troubleshooters?: Array<{ id: string; name: string }>;
};

export type SameLocationFoundCounts = { FOUND_AT_ORIGINAL: number; FOUND: number; NOT_FOUND: number; WRONG_LOCATION: number };
export type SameLocationFoundSummary = {
  numerator: number;
  denominator: number;
  percentage: number | null;
  percentageSuppressed: boolean;
  from: string;
  to: string;
  counts: SameLocationFoundCounts;
};
export type SameLocationFoundUser = SameLocationFoundSummary & { userId: string; displayName: string; role: string };
export type AnalyticsUserDirectoryEntry = { id: string; displayName: string; role: string };

export type AnalyticsBucket = { label: string; count: number };
export type AnalyticsDimension = { label: string; count: number };
export type AnalyticsDuplicate = {
  orderNumber: string;
  occurrences: number;
  cases: Array<{ caseId: string; createdAt: string }>;
};
export type RetainedAnalyticsReport = {
  id: string;
  filename: string;
  createdAt: string;
  byteSize: number;
};

export type AnalyticsResponse = {
  management?: AnalyticsManagement;
  filters?: AnalyticsFilterOptions;
  kpis: {
    totalCases: number;
    totalLines: number;
    casesByPeriod: AnalyticsBucket[];
    linesByLocation: AnalyticsDimension[];
    linesBySku: AnalyticsDimension[];
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
    casesByConfigurationVersion: AnalyticsDimension[];
    sameLocationFound?: SameLocationFoundSummary | null;
    sameLocationFoundByUser?: SameLocationFoundUser[];
    userDirectory?: AnalyticsUserDirectoryEntry[];
  };
  duplicates: {
    repeatedOrderCount: number;
    orders: AnalyticsDuplicate[];
  };
  rows: { cases: Record<string, unknown>[]; lines: Record<string, unknown>[] };
  limits: { maxCases: number; maxLines: number; maxEvents: number; casesTruncated: boolean; linesTruncated: boolean; eventsTruncated: boolean; duplicateOrdersTruncated: boolean; derivedMetricsTruncated: boolean };
};

type FilterState = AnalyticsFilterState;

type Props = { tr: Translate; locale: Locale; canExport: boolean };

const phaseLabelKeys: Record<string, MessageKey> = { PICKING: "analyticsPhasePicking", STAGED: "analyticsPhaseStaged", CLOSED: "analyticsPhaseClosed" };
const resolutionLabelKeys: Record<string, MessageKey> = { FOUND: "analyticsResolutionFound", NOT_FOUND: "analyticsResolutionNotFound", WRONG_LOCATION: "analyticsResolutionWrongLocation", OTHER: "analyticsResolutionOther" };
const sourceLabelKeys: Record<string, MessageKey> = { PICKER_REPORT: "analyticsSourcePickerReport", TL_MANUAL: "analyticsSourceTlManual", ASSISTANT_MANUAL: "analyticsSourceAssistantManual", MANAGER_MANUAL: "analyticsSourceManagerManual", ADMIN_MANUAL: "analyticsSourceAdminManual" };

function enumLabel(value: string, labels: Record<string, MessageKey>, tr: Translate) {
  const key = labels[value];
  return key ? tr(key) : value;
}

const EMPTY_KPIS: AnalyticsResponse["kpis"] = {
  totalCases: 0,
  totalLines: 0,
  casesByPeriod: [],
  linesByLocation: [],
  linesBySku: [],
  foundDuringCheck: 0,
  notFound: 0,
  wrongLocation: 0,
  retrieved: 0,
  medianReportToCheckClaimedSeconds: null,
  medianReportToLocationFoundSeconds: null,
  medianReportToRetrievalSeconds: null,
  medianReportToResolutionSeconds: null,
  casesOverThreshold: 0,
  manualCases: 0,
  reopenedCases: 0,
  repeatedOrderNumbers: 0,
  casesByConfigurationVersion: [],
  sameLocationFound: null,
  sameLocationFoundByUser: [],
  userDirectory: [],
};

function defaultFilters(): FilterState {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    from: isoDay(from), to: isoDay(to), orderNumber: "", location: "", sku: "", phase: "", resolution: "", source: "", configVersion: "", pickerUserId: "", checkerUserId: "", troubleshooterUserId: "", role: "",
  };
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBucket(value: unknown): AnalyticsBucket | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = String(row.label ?? row.period ?? row.date ?? "");
  if (!label) return null;
  const lines = row.lines ?? row.quantity;
  const bucket: AnalyticsBucket & { lines?: number } = { label, count: number(row.count ?? row.cases ?? row.value) };
  if (typeof lines === "number" && Number.isFinite(lines)) bucket.lines = lines;
  return bucket;
}

function normalizeDimension(value: unknown): AnalyticsDimension | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = String(row.label ?? row.key ?? row.location ?? row.sku ?? row.version ?? "");
  if (!label) return null;
  return { label, count: number(row.count ?? row.lines ?? row.cases ?? row.value) };
}

function normalizeRetainedReports(value: unknown): { reports: RetainedAnalyticsReport[]; nextCursor: string | null } {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const reports = Array.isArray(root.reports) ? root.reports.map((value) => {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? "");
    const filename = String(row.filename ?? "short-pick-analytics.pdf");
    if (!id) return null;
    return { id, filename, createdAt: String(row.createdAt ?? ""), byteSize: number(row.byteSize) };
  }).filter((report): report is RetainedAnalyticsReport => report !== null) : [];
  const nextCursor = typeof root.nextCursor === "string" && root.nextCursor ? root.nextCursor : null;
  return { reports, nextCursor };
}

function normalizeCounts(value: unknown): SameLocationFoundCounts {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { FOUND_AT_ORIGINAL: number(row.FOUND_AT_ORIGINAL), FOUND: number(row.FOUND), NOT_FOUND: number(row.NOT_FOUND), WRONG_LOCATION: number(row.WRONG_LOCATION) };
}

function normalizeSameLocationSummary(value: unknown): SameLocationFoundSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const denominator = number(row.denominator);
  return {
    numerator: number(row.numerator),
    denominator,
    percentage: typeof row.percentage === "number" && Number.isFinite(row.percentage) ? row.percentage : null,
    percentageSuppressed: Boolean(row.percentageSuppressed),
    from: String(row.from ?? ""),
    to: String(row.to ?? ""),
    counts: normalizeCounts(row.counts),
  };
}

function normalizeSameLocationUser(value: unknown): SameLocationFoundUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const summary = normalizeSameLocationSummary(row);
  if (!summary) return null;
  const userId = String(row.userId ?? "");
  if (!userId) return null;
  return { ...summary, userId, displayName: String(row.displayName ?? userId), role: String(row.role ?? "") };
}

function normalizeDirectory(value: unknown): AnalyticsUserDirectoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!id) return null;
    return { id, displayName: String(row.displayName ?? id), role: String(row.role ?? "") };
  }).filter((entry): entry is AnalyticsUserDirectoryEntry => entry !== null);
}

function normalizeResponse(value: unknown): AnalyticsResponse {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rawKpis = (root.kpis && typeof root.kpis === "object" ? root.kpis : {}) as Record<string, unknown>;
  const rawDuplicates = (root.duplicates && typeof root.duplicates === "object" ? root.duplicates : {}) as Record<string, unknown>;
  const rawRows = (root.rows && typeof root.rows === "object" ? root.rows : {}) as Record<string, unknown>;
  const kpis = { ...EMPTY_KPIS };
  for (const key of ["totalCases", "totalLines", "foundDuringCheck", "notFound", "wrongLocation", "retrieved", "casesOverThreshold", "manualCases", "reopenedCases", "repeatedOrderNumbers"] as const) kpis[key] = number(rawKpis[key]);
  for (const key of ["medianReportToCheckClaimedSeconds", "medianReportToLocationFoundSeconds", "medianReportToRetrievalSeconds", "medianReportToResolutionSeconds"] as const) kpis[key] = rawKpis[key] === null || rawKpis[key] === undefined ? null : number(rawKpis[key]);
  kpis.casesByPeriod = Array.isArray(rawKpis.casesByPeriod) ? rawKpis.casesByPeriod.map(normalizeBucket).filter((row): row is AnalyticsBucket => row !== null) : [];
  kpis.linesByLocation = Array.isArray(rawKpis.linesByLocation) ? rawKpis.linesByLocation.map(normalizeDimension).filter((row): row is AnalyticsDimension => row !== null) : [];
  kpis.linesBySku = Array.isArray(rawKpis.linesBySku) ? rawKpis.linesBySku.map(normalizeDimension).filter((row): row is AnalyticsDimension => row !== null) : [];
  kpis.sameLocationFound = normalizeSameLocationSummary(rawKpis.sameLocationFound);
  kpis.sameLocationFoundByUser = Array.isArray(rawKpis.sameLocationFoundByUser) ? rawKpis.sameLocationFoundByUser.map(normalizeSameLocationUser).filter((row): row is SameLocationFoundUser => row !== null) : [];
  kpis.userDirectory = normalizeDirectory(rawKpis.userDirectory);
  const orders = Array.isArray(rawDuplicates.orders) ? rawDuplicates.orders.map((value) => {
    const row = value as Record<string, unknown>;
    const cases = Array.isArray(row.cases) ? row.cases.map((item) => {
      const itemRow = item as Record<string, unknown>;
      return { caseId: String(itemRow.caseId ?? itemRow.id ?? ""), createdAt: String(itemRow.createdAt ?? "") };
    }) : [];
    return { orderNumber: String(row.orderNumber ?? ""), occurrences: number(row.occurrences, cases.length), cases };
  }).filter((row) => row.orderNumber) : [];
  return {
    management: normalizeManagement(root.management),
    filters: (root.filters && typeof root.filters === "object" ? root.filters : {}) as AnalyticsFilterOptions,
    kpis,
    duplicates: { repeatedOrderCount: number(rawDuplicates.repeatedOrderCount, orders.length), orders },
    rows: { cases: Array.isArray(rawRows.cases) ? rawRows.cases.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [], lines: Array.isArray(rawRows.lines) ? rawRows.lines.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [] },
    limits: { maxCases: number((root.limits as Record<string, unknown> | undefined)?.maxCases), maxLines: number((root.limits as Record<string, unknown> | undefined)?.maxLines), maxEvents: number((root.limits as Record<string, unknown> | undefined)?.maxEvents), casesTruncated: Boolean((root.limits as Record<string, unknown> | undefined)?.casesTruncated), linesTruncated: Boolean((root.limits as Record<string, unknown> | undefined)?.linesTruncated), eventsTruncated: Boolean((root.limits as Record<string, unknown> | undefined)?.eventsTruncated), duplicateOrdersTruncated: Boolean((root.limits as Record<string, unknown> | undefined)?.duplicateOrdersTruncated), derivedMetricsTruncated: Boolean((root.limits as Record<string, unknown> | undefined)?.derivedMetricsTruncated) },
  };
}

function formatDuration(seconds: number | null, tr: Translate) {
  if (seconds === null) return tr("analyticsNotAvailable");
  if (seconds < 60) return tr("analyticsSeconds", { count: String(Math.round(seconds)) });
  const minutes = seconds / 60;
  if (minutes < 60) return tr("analyticsMinutes", { count: String(Math.round(minutes)) });
  return tr("analyticsHours", { count: String(Math.round(minutes / 60)) });
}

function dateLabel(value: string, locale: Locale) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat({ en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" }[locale], { dateStyle: "medium", ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}) }).format(parsed);
}

function rangeLabel(from: string, to: string, locale: Locale, tr: Translate) {
  const days = reportingRangeDays(from, to);
  return days ? tr("analyticsSameLocationDateRangeValue", { from: dateLabel(days.from, locale), to: dateLabel(days.to, locale) }) : "—";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function participantOptions(data: AnalyticsResponse | null) {
  const people = new Map<string, string>();
  for (const entry of data?.kpis.userDirectory ?? []) people.set(entry.id, entry.displayName);
  for (const row of data?.rows.cases ?? []) {
    for (const person of [row.picker, row.responsible]) {
      if (person && typeof person === "object") {
        const value = person as { id?: unknown; displayName?: unknown };
        if (value.id && value.displayName) people.set(String(value.id), String(value.displayName));
      }
    }
  }
  for (const row of data?.rows.lines ?? []) {
    for (const person of [row.picker, row.checker, row.troubleshooter]) {
      if (person && typeof person === "object") {
        const value = person as { id?: unknown; displayName?: unknown };
        if (value.id && value.displayName) people.set(String(value.id), String(value.displayName));
      }
    }
  }
  for (const row of data?.kpis.sameLocationFoundByUser ?? []) people.set(row.userId, row.displayName);
  return [...people.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

const ROLE_OPTIONS = ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER", "MANAGER", "ADMIN"];

export function SameLocationFoundSection({ summary, byUser, tr, locale, canExport, downloading, onDownload, roleLabel }: {
  summary: SameLocationFoundSummary | null | undefined;
  byUser: SameLocationFoundUser[];
  tr: Translate;
  locale: Locale;
  canExport: boolean;
  downloading: string;
  onDownload: (dataset: "same-location-found" | "same-location-found-overall") => void;
  roleLabel: (role: string) => string;
}) {
  if (!summary && !byUser.length) return null;
  const range = summary?.from && summary.to ? rangeLabel(summary.from, summary.to, locale, tr) : "—";
  const formatCount = (value: number) => new Intl.NumberFormat(locale).format(value);
  const formatRate = (value: number | null) => value === null ? tr("analyticsSameLocationCountsOnly") : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
  const sortedByUser = byUser.filter((row) => isSameLocationReporter(row.role)).sort((a, b) => a.displayName.localeCompare(b.displayName, locale));
  const otherOutcomes: Array<{ key: keyof SameLocationFoundCounts; label: MessageKey }> = [
    { key: "FOUND", label: "analyticsSameLocationElsewhere" },
    { key: "NOT_FOUND", label: "analyticsResolutionNotFound" },
    { key: "WRONG_LOCATION", label: "analyticsResolutionWrongLocation" },
  ];
  return <section className={styles.card} aria-labelledby="analytics-same-location-title">
    <div className={styles.sameLocationHead}>
      <div className={styles.sameLocationTitleRow}>
        <h2 id="analytics-same-location-title">{tr("analyticsSameLocationTitle")}</h2>
        {canExport && <div className={styles.reportActions}><button className={styles.exportButton} type="button" onClick={() => onDownload("same-location-found")} disabled={Boolean(downloading)}>{tr("analyticsSameLocationExport")}</button></div>}
      </div>
      <p className={styles.subtle}>{tr("analyticsSameLocationDescription")}</p>
      <p className={styles.subtle}>{tr("analyticsSameLocationScope")}</p>
      <p className={styles.sameLocationRange}><span>{tr("analyticsSameLocationDateRange")}</span> {range}</p>
    </div>
    {summary && <>
      <div className={`${styles.timingGrid} ${styles.sameLocationStats}`}>
        <div className={styles.timing}><span>{tr("analyticsSameLocationFoundCount")}</span><strong>{formatCount(summary.numerator)}</strong></div>
        <div className={styles.timing}><span>{tr("analyticsSameLocationEligible")}</span><strong>{formatCount(summary.denominator)}</strong></div>
        <div className={styles.timing}><span>{tr("analyticsSameLocationRate")}</span><strong className={summary.percentage === null ? styles.suppressedRate : undefined}>{formatRate(summary.percentage)}</strong></div>
      </div>
      <p className={styles.subtle}>{tr("analyticsSameLocationRateNote")}</p>
      <h3 className={styles.sameLocationSubheading}>{tr("analyticsSameLocationOutcomes")}</h3>
      <dl className={styles.sameLocationOtherOutcomes}>{otherOutcomes.map(({ key, label }) => <div key={key}><dt>{tr(label)}</dt><dd>{formatCount(summary.counts[key])}</dd></div>)}</dl>
    </>}
    <h3 className={styles.sameLocationSubheading}>{tr("analyticsSameLocationByReporter")}</h3>
    <p className={styles.subtle}>{tr("analyticsSameLocationReporterNote")}</p>
    {sortedByUser.length ? <>
      <div className={`${styles.tableWrap} ${styles.sameLocationTable}`}><table><thead><tr>
        <th scope="col">{tr("analyticsSameLocationReporter")}</th><th scope="col">{tr("analyticsSameLocationEligible")}</th><th scope="col">{tr("analyticsSameLocationFoundCount")}</th><th scope="col">{tr("analyticsSameLocationRate")}</th>
        {otherOutcomes.map(({ key, label }) => <th scope="col" key={key}>{tr(label)}</th>)}
      </tr></thead><tbody>{sortedByUser.map((row) => <tr key={row.userId}>
        <th scope="row">{row.displayName}<span className={styles.sameLocationPersonMeta}>{roleLabel(row.role)}</span><span className={styles.sameLocationPersonMeta}>{rangeLabel(row.from, row.to, locale, tr)}</span></th>
        <td>{formatCount(row.denominator)}</td><td>{formatCount(row.numerator)}</td><td>{formatRate(row.percentage)}</td>
        {otherOutcomes.map(({ key }) => <td key={key}>{formatCount(row.counts[key])}</td>)}
      </tr>)}</tbody></table></div>
      <ul className={styles.sameLocationMobileList}>{sortedByUser.map((row) => <li className={styles.sameLocationPersonCard} key={row.userId}>
        <div className={styles.sameLocationPersonHead}><strong>{row.displayName}</strong><span>{roleLabel(row.role)}</span></div>
        <p className={styles.sameLocationPersonMeta}>{rangeLabel(row.from, row.to, locale, tr)}</p>
        <dl className={styles.sameLocationPersonStats}>
          <div><dt>{tr("analyticsSameLocationEligible")}</dt><dd>{formatCount(row.denominator)}</dd></div>
          <div><dt>{tr("analyticsSameLocationFoundCount")}</dt><dd>{formatCount(row.numerator)}</dd></div>
          <div><dt>{tr("analyticsSameLocationRate")}</dt><dd className={row.percentage === null ? styles.suppressedRate : undefined}>{formatRate(row.percentage)}</dd></div>
        </dl>
        <dl className={styles.sameLocationPersonOutcomes}>{otherOutcomes.map(({ key, label }) => <div key={key}><dt>{tr(label)}</dt><dd>{formatCount(row.counts[key])}</dd></div>)}</dl>
      </li>)}</ul>
    </> : <p className={styles.empty}>{tr("analyticsNoData")}</p>}
  </section>;
}

export function AnalyticsDashboard({ tr, locale, canExport }: Props) {
  const [filters, setFilters] = useState<FilterState>(() => {
    if (typeof window === "undefined") return defaultFilters();
    const params = new URLSearchParams(window.location.search);
    const initial = defaultFilters();
    for (const key of Object.keys(initial) as Array<keyof FilterState>) {
      const value = params.get(key);
      if (value !== null) initial[key] = value;
    }
    return initial;
  });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const [retainedReports, setRetainedReports] = useState<RetainedAnalyticsReport[]>([]);
  const [retainedReportsLoading, setRetainedReportsLoading] = useState(false);
  const [retainedReportsNextCursor, setRetainedReportsNextCursor] = useState<string | null>(null);
  const [retentionWarning, setRetentionWarning] = useState(false);
  const retainedReportsMutation = useRef(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params.toString();
  }, [filters]);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = query;
    window.history.replaceState(null, "", url);
  }, [query]);
  const update = useCallback((key: keyof FilterState, value: string) => setFilters((current) => ({ ...current, [key]: value })), []);
  const [nowMs] = useState(() => Date.now());
  const applyPreset = useCallback((days: 7 | 30 | 90) => {
    const range = presetRange(days, new Date());
    setFilters((current) => ({ ...current, ...range }));
  }, []);
  const loadRetainedReports = useCallback(async (signal?: AbortSignal, cursor?: string, append = false) => {
    if (!canExport) {
      setRetainedReports([]);
      setRetainedReportsNextCursor(null);
      setRetainedReportsLoading(false);
      return;
    }
    setRetainedReportsLoading(true);
    const mutationAtStart = retainedReportsMutation.current;
    try {
      const url = cursor ? `/api/analytics/reports?cursor=${encodeURIComponent(cursor)}` : "/api/analytics/reports";
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error((body as { error?: string }).error || tr("analyticsRetainedReportsLoadError"));
      const page = normalizeRetainedReports(body);
      if (mutationAtStart !== retainedReportsMutation.current) return;
      setRetainedReports((current) => append ? [...current, ...page.reports.filter((report) => !current.some((existing) => existing.id === report.id))] : page.reports);
      setRetainedReportsNextCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : tr("analyticsRetainedReportsLoadError"));
    } finally {
      if (!signal?.aborted) setRetainedReportsLoading(false);
    }
  }, [canExport, tr]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/analytics${query ? `?${query}` : ""}`, { credentials: "same-origin", cache: "no-store", signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error((body as { error?: string }).error || tr("analyticsLoadError"));
      setData(normalizeResponse(body));
      setLoadedQuery(query);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : tr("analyticsLoadError"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query, tr]);

  const downloadPdf = useCallback(async () => {
    if (exporting) return;
    setExporting("pdf");
    try {
      const response = await fetch(`/api/analytics/export/pdf${query ? `?${query}` : ""}`, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(tr("analyticsExportError"));
      const reportId = response.headers.get("x-report-id");
      const retention = response.headers.get("x-report-retention");
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "short-pick-analytics.pdf";
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      if (retention === "unavailable") setRetentionWarning(true);
      if (reportId) {
        setRetentionWarning(false);
        retainedReportsMutation.current += 1;
        setRetainedReports((current) => [{ id: reportId, filename, createdAt: new Date().toISOString(), byteSize: blob.size }, ...current.filter((report) => report.id !== reportId)]);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("analyticsExportError")); }
    finally { setExporting(""); }
  }, [exporting, query, tr]);

  const removeRetainedReport = useCallback(async (reportId: string) => {
    if (exporting || retainedReportsLoading) return;
    setExporting("retained-delete");
    try {
      const response = await fetch(`/api/analytics/reports/${reportId}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error(tr("analyticsExportError"));
      retainedReportsMutation.current += 1;
      setRetainedReports((current) => current.filter((report) => report.id !== reportId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("analyticsExportError")); }
    finally { setExporting(""); }
  }, [exporting, retainedReportsLoading, tr]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void loadRetainedReports(controller.signal); });
    return () => controller.abort();
  }, [loadRetainedReports]);

  const download = useCallback(async (dataset: "case" | "line" | "event" | "same-location-found" | "same-location-found-overall" | "management") => {
    if (exporting) return;
    setExporting(dataset);
    try {
      const response = await fetch(`/api/analytics/export/csv?dataset=${dataset}${query ? `&${query}` : ""}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(tr("analyticsExportError"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `short-pick-${dataset === "management" ? "summary" : dataset}-analytics.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("analyticsExportError")); }
    finally { setExporting(""); }
  }, [exporting, query, tr]);

  const currentData = Boolean(data) && loadedQuery === query && !loading;
  const options = data?.filters;
  const kpis = data?.kpis ?? EMPTY_KPIS;
  const phases = options?.phases ?? ["PICKING", "STAGED", "CLOSED"];
  const resolutions = options?.resolutions ?? ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"];
  const sources = options?.sources ?? ["PICKER_REPORT", "TL_MANUAL", "ASSISTANT_MANUAL", "MANAGER_MANUAL", "ADMIN_MANUAL"];
  const configOptions = (options?.configurations ?? []).map((option) => ({ value: option.id, label: option.label ?? String(option.version ?? option.id) }));
  if (!configOptions.length) configOptions.push(...kpis.casesByConfigurationVersion.map((option) => ({ value: option.label, label: option.label })));
  const directoryOptions = participantOptions(data);
  const directoryLabel = new Map(directoryOptions.map((option) => [option.value, option.label]));
  const roleLabelKeys: Record<string, MessageKey> = { PICKER: "rolePICKER", TROUBLESHOOTER: "roleTROUBLESHOOTER", ASSISTANT: "roleASSISTANT", TEAM_LEADER: "roleTEAM_LEADER", MANAGER: "roleMANAGER", ADMIN: "roleADMIN" };
  const roleLabel = (role: string) => enumLabel(role, roleLabelKeys, tr);
  const partialDataMessages = data ? [
    data.limits.casesTruncated ? tr("analyticsCasesTruncated") : "",
    data.limits.linesTruncated ? tr("analyticsLinesTruncated") : "",
    data.limits.eventsTruncated ? tr("analyticsEventsTruncated") : "",
    data.limits.duplicateOrdersTruncated ? tr("analyticsDuplicateOrdersTruncated") : "",
    data.limits.derivedMetricsTruncated ? tr("analyticsDerivedMetricsTruncated") : "",
  ].filter(Boolean) : [];

  const chipDefs: Array<{ key: keyof FilterState; label: string; display: (value: string) => string }> = [
    { key: "from", label: tr("analyticsFrom"), display: (value) => dateLabel(value, locale) },
    { key: "to", label: tr("analyticsTo"), display: (value) => dateLabel(value, locale) },
    { key: "orderNumber", label: tr("orderNumber"), display: (value) => value },
    { key: "location", label: tr("location"), display: (value) => value },
    { key: "sku", label: tr("sku"), display: (value) => value },
    { key: "phase", label: tr("analyticsPhase"), display: (value) => enumLabel(value, phaseLabelKeys, tr) },
    { key: "resolution", label: tr("analyticsResolution"), display: (value) => enumLabel(value, resolutionLabelKeys, tr) },
    { key: "source", label: tr("analyticsSource"), display: (value) => enumLabel(value, sourceLabelKeys, tr) },
    { key: "configVersion", label: tr("analyticsConfiguration"), display: (value) => configOptions.find((option) => option.value === value)?.label ?? value },
    { key: "pickerUserId", label: tr("analyticsPicker"), display: (value) => directoryLabel.get(value) ?? value },
    { key: "checkerUserId", label: tr("analyticsChecker"), display: (value) => directoryLabel.get(value) ?? value },
    { key: "troubleshooterUserId", label: tr("analyticsTroubleshooter"), display: (value) => directoryLabel.get(value) ?? value },
    { key: "role", label: tr("analyticsRoleFilter"), display: (value) => roleLabel(value) },
  ];
  const chips: ActiveFilterChip[] = chipDefs
    .filter((def) => filters[def.key])
    .map((def) => ({ key: def.key, label: def.label, display: def.display(filters[def.key]) }));

  const fromMs = new Date(`${filters.from}T00:00:00.000Z`).valueOf();
  const toMs = new Date(`${filters.to}T00:00:00.000Z`).valueOf();
  const periodKind = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs ? periodKindForRange(fromMs, toMs) : "day";
  const sliceNote = data ? tr("analyticsSliceBasedNote", { cases: String(data?.rows.cases.length ?? 0), lines: String(data?.rows.lines.length ?? 0) }) : "";
  const topNote = tr("analyticsTopNNote", { count: "10" });
  // All chart series use the server's bounded cohort; partial data is flagged above.
  const volumeSeries = buildVolumeSeries(kpis.casesByPeriod, data?.rows.cases ?? [], periodKind);
  const phaseData = phaseMix(data?.rows.cases ?? []);
  const buckets = agingBuckets(data?.rows.cases ?? [], nowMs);
  const duplicateOrders = data?.duplicates.orders ?? [];
  const percentFormat = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }), [locale]);
  const hotspotNote = (items: AnalyticsDimension[]) => {
    const share = hotspotConcentration(items, kpis.totalLines, data?.limits.linesTruncated ?? true);
    return share === null ? "" : tr("analyticsTopThreeShare", { share: percentFormat.format(share) });
  };
  const hotspotLocations = hotspotNote(kpis.linesByLocation);
  const hotspotSkus = hotspotNote(kpis.linesBySku);
  return <div className={styles.dashboard}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>{tr("analyticsEyebrow")}</p><h1>{tr("analyticsTitle")}</h1><p className={styles.description}>{tr("analyticsDescription")}</p></div><div className={styles.actions}>{canExport && <><button className={styles.exportButton} type="button" onClick={() => void download("case")} disabled={Boolean(exporting)}>{exporting === "case" ? tr("analyticsExporting") : tr("analyticsExportCases")}</button><button className={styles.exportButton} type="button" onClick={() => void download("line")} disabled={Boolean(exporting)}>{exporting === "line" ? tr("analyticsExporting") : tr("analyticsExportLines")}</button><button className={styles.exportButton} type="button" onClick={() => void download("event")} disabled={Boolean(exporting)}>{exporting === "event" ? tr("analyticsExporting") : tr("analyticsExportEvents")}</button><button className={styles.exportButton} type="button" onClick={() => void downloadPdf()} disabled={Boolean(exporting)}>{exporting === "pdf" ? tr("analyticsExporting") : tr("analyticsExportPdf")}</button></>}</div></div>
    <AnalyticsFilters
      tr={tr}
      filters={filters}
      update={update}
      applyPreset={(preset) => applyPreset(Number(preset) as 7 | 30 | 90)}
      selects={{
        phases: phases.map((value) => ({ value, label: enumLabel(value, phaseLabelKeys, tr) })),
        resolutions: resolutions.map((value) => ({ value, label: enumLabel(value, resolutionLabelKeys, tr) })),
        sources: sources.map((value) => ({ value, label: enumLabel(value, sourceLabelKeys, tr) })),
        configs: configOptions,
        people: directoryOptions,
        roles: ROLE_OPTIONS.map((value) => ({ value, label: roleLabel(value) })),
      }}
      chips={chips}
      removeChip={(key) => update(key, "")}
      onReset={() => setFilters(defaultFilters())}
      resultSummary={currentData ? tr("analyticsDataNote", { cases: String(data?.rows.cases.length ?? 0), lines: String(data?.rows.lines.length ?? 0) }) : ""}
    />
    {error && <div className={styles.alert} role="alert">{error}<button type="button" onClick={() => void load()}>{tr("tryAgain")}</button></div>}
    {retentionWarning && <div className={styles.retentionWarning} role="status">{tr("analyticsRetentionUnavailable")}</div>}
    {currentData && partialDataMessages.length > 0 && <div className={styles.partialNotice} role="status"><strong>{tr("analyticsPartialData")}</strong><ul>{partialDataMessages.map((message) => <li key={message}>{message}</li>)}</ul></div>}
    {loading && <p className={styles.loading} role="status" aria-live="polite">{tr(data ? "analyticsUpdating" : "analyticsLoading")}</p>}
    <div aria-busy={loading}>
    {currentData && <div className={styles.analysis}>
        {data?.management && <ManagementSummary data={data.management} tr={tr} locale={locale} canExport={canExport} exporting={Boolean(exporting)} onExport={() => void download("management")} />}
        <section aria-labelledby="analytics-kpis-title">
          <h2 className={styles.srOnly} id="analytics-kpis-title">{tr("analyticsKpis")}</h2>
          {!data?.management && <div className={styles.kpiGrid}>
            {[["analyticsTotalCases", kpis.totalCases], ["analyticsTotalLines", kpis.totalLines]].map(([label, value]) => <article className={styles.kpi} key={String(label)}><span>{tr(label as MessageKey)}</span><strong>{value}</strong></article>)}
            <article className={styles.kpi}><span>{tr("analyticsOpenCohort")}</span><strong>{buckets.open}</strong><small>{tr("analyticsOpenCohortNote")}</small></article>
            <article className={styles.kpi}><span>{tr("analyticsOverThreshold")}</span><strong>{kpis.casesOverThreshold}</strong><small>{tr("analyticsThresholdNote")}</small></article>
          </div>}
          <dl className={styles.factStrip}>
            {[["analyticsCohortOverThreshold", kpis.casesOverThreshold], ["analyticsRetrieved", kpis.retrieved], ["analyticsManualCases", kpis.manualCases], ["analyticsReopenedCases", kpis.reopenedCases], ["analyticsRepeatedOrders", kpis.repeatedOrderNumbers]].map(([label, value]) => <div className={styles.fact} key={String(label)}><dt>{tr(label as MessageKey)}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
        <section className={styles.card} aria-labelledby="analytics-volume-section-title">
          <div className={styles.sectionHeading}><h2 id="analytics-volume-section-title">{tr("analyticsVolumeTitle")}</h2></div>
          <VolumeChart data={volumeSeries} tr={tr} locale={locale} sliceNote={tr("analyticsVolumeNote")} />
        </section>
        <div className={styles.chartGrid}>
          <section className={styles.card} aria-labelledby="analytics-outcome-title"><div className={styles.sectionHeading}><div><h2 id="analytics-outcome-title">{tr("analyticsOutcomeTitle")}</h2><p className={styles.subtle}>{tr("analyticsOutcomeNote")}</p></div></div><OutcomeBarsChart found={kpis.foundDuringCheck} notFound={kpis.notFound} wrongLocation={kpis.wrongLocation} tr={tr} emptyLabel={tr("analyticsNoData")} /></section>
        <section className={styles.card} aria-labelledby="analytics-timing-title"><div className={styles.sectionHeading}><div><h2 id="analytics-timing-title">{tr("analyticsMedianTiming")}</h2><p className={styles.subtle}>{tr("analyticsTimingNote")}</p></div></div><div className={styles.timingGrid}>{[["analyticsReportToClaim", kpis.medianReportToCheckClaimedSeconds], ["analyticsReportToFound", kpis.medianReportToLocationFoundSeconds], ["analyticsReportToRetrieval", kpis.medianReportToRetrievalSeconds], ["analyticsReportToResolution", kpis.medianReportToResolutionSeconds]].map(([label, value]) => <div className={styles.timing} key={String(label)}><span>{tr(label as MessageKey)}</span><strong>{formatDuration(value as number | null, tr)}</strong></div>)}</div></section>
          <section className={styles.card} aria-labelledby="analytics-phase-mix-title"><div className={styles.sectionHeading}><div><h2 id="analytics-phase-mix-title">{tr("analyticsPhaseMixTitle")}</h2><p className={styles.subtle}>{tr("analyticsPhaseNote")}</p></div><span className={styles.cardMeta}>{sliceNote}</span></div><PhaseDonutChart data={phaseData} tr={tr} emptyLabel={tr("analyticsNoData")} labelFor={(phase) => enumLabel(phase, phaseLabelKeys, tr)} /></section>
          <section className={styles.card} aria-labelledby="analytics-aging-title"><div className={styles.sectionHeading}><div><h2 id="analytics-aging-title">{tr("analyticsAgingTitle")}</h2><p className={styles.subtle}>{tr("analyticsAgingNote")}</p></div></div><AgingChart buckets={buckets} tr={tr} emptyLabel={tr("analyticsNoData")} sliceNote={sliceNote} /></section>
          <section className={styles.card} aria-labelledby="analytics-top-locations-title"><div className={styles.sectionHeading}><h2 id="analytics-top-locations-title">{tr("analyticsTopLocationsTitle")}</h2></div><TopBarsChart data={topN(kpis.linesByLocation, 10)} tr={tr} topNote={topNote} emptyLabel={tr("analyticsNoData")} />{hotspotLocations && <p className={styles.subtle}>{hotspotLocations}</p>}</section>
          <section className={styles.card} aria-labelledby="analytics-top-skus-title"><div className={styles.sectionHeading}><h2 id="analytics-top-skus-title">{tr("analyticsTopSkusTitle")}</h2></div><TopBarsChart data={topN(kpis.linesBySku, 10)} tr={tr} topNote={topNote} emptyLabel={tr("analyticsNoData")} />{hotspotSkus && <p className={styles.subtle}>{hotspotSkus}</p>}</section>
        </div>

        {!data?.management && <details className={`${styles.card} ${styles.details}`}>
          <summary className={styles.detailsSummary}>{tr("analyticsDuplicateOrders")}</summary>
          <p className={styles.subtle}>{tr("analyticsRecurringOrdersNote")}</p>
          {duplicateOrders.length ? <ul className={styles.duplicateList}>{duplicateOrders.map((order) => <li className={styles.duplicateItem} key={order.orderNumber}><div className={styles.duplicateHead}><strong>{order.orderNumber}</strong><span className={styles.cardMeta}>{tr("analyticsOccurrences")}: {order.occurrences}</span></div><p className={styles.duplicateDates}>{order.cases.map((entry) => <time key={entry.caseId} dateTime={entry.createdAt || undefined}>{dateLabel(entry.createdAt, locale)}</time>)}</p></li>)}</ul> : <p className={styles.empty}>{tr("analyticsNoDuplicates")}</p>}
        </details>}
        <SameLocationFoundSection summary={kpis.sameLocationFound} byUser={kpis.sameLocationFoundByUser ?? []} tr={tr} locale={locale} canExport={canExport} downloading={exporting} onDownload={(dataset) => void download(dataset)} roleLabel={roleLabel} />
    </div>}
    </div>
    {canExport && <details className={`${styles.card} ${styles.details}`}>
      <summary className={styles.detailsSummary}>{tr("analyticsRetainedReportsSummary", { count: String(retainedReports.length) })}</summary>
      {retainedReportsLoading && !retainedReports.length ? <p className={styles.loading}>{tr("analyticsLoading")}</p> : retainedReports.length ? <><ul className={styles.reportList}>{retainedReports.map((report) => <li className={styles.reportItem} key={report.id}><div className={styles.reportDetails}><strong className={styles.reportFilename}>{report.filename}</strong><span className={styles.reportMeta}>{report.createdAt ? dateLabel(report.createdAt, locale) : ""}{report.byteSize ? ` · ${formatBytes(report.byteSize)}` : ""}</span></div><div className={styles.reportActions}><a className={`${styles.exportButton} ${exporting ? styles.disabledLink : ""}`} href={`/api/analytics/reports/${report.id}`} download={report.filename} aria-disabled={Boolean(exporting)} tabIndex={exporting ? -1 : 0} onClick={(event) => { if (exporting) event.preventDefault(); }}>{tr("analyticsRetainedReport", { filename: report.filename })}</a><button className={styles.exportButton} type="button" onClick={() => void removeRetainedReport(report.id)} disabled={Boolean(exporting) || retainedReportsLoading}>{exporting === "retained-delete" ? tr("analyticsExporting") : tr("analyticsDeleteRetainedReport")}</button></div></li>)}</ul>{retainedReportsNextCursor && <button className={styles.clearButton} type="button" onClick={() => void loadRetainedReports(undefined, retainedReportsNextCursor, true)} disabled={Boolean(exporting) || retainedReportsLoading}>{retainedReportsLoading ? tr("analyticsLoading") : tr("analyticsLoadMoreRetainedReports")}</button>}</> : <p className={styles.empty}>{tr("analyticsNoRetainedReports")}</p>}
    </details>}
  </div>;
}
