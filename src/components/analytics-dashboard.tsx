"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import styles from "./analytics-dashboard.module.css";

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

export type AnalyticsBucket = { label: string; count: number };
export type AnalyticsDimension = { label: string; count: number };
export type AnalyticsDuplicate = {
  orderNumber: string;
  occurrences: number;
  cases: Array<{ caseId: string; createdAt: string }>;
};

export type AnalyticsResponse = {
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
  };
  duplicates: {
    repeatedOrderCount: number;
    orders: AnalyticsDuplicate[];
  };
  rows: { cases: Record<string, unknown>[]; lines: Record<string, unknown>[] };
  limits: { maxCases: number; maxLines: number; maxEvents: number; casesTruncated: boolean; linesTruncated: boolean; eventsTruncated: boolean; duplicateOrdersTruncated: boolean; derivedMetricsTruncated: boolean };
};

type FilterState = {
  from: string;
  to: string;
  orderNumber: string;
  location: string;
  sku: string;
  phase: string;
  resolution: string;
  source: string;
  configVersion: string;
  pickerUserId: string;
  checkerUserId: string;
  troubleshooterUserId: string;
};

type Props = { tr: Translate; locale: Locale; canExport: boolean };

const phaseLabelKeys: Record<string, MessageKey> = { PICKING: "analyticsPhasePicking", STAGED: "analyticsPhaseStaged", CLOSED: "analyticsPhaseClosed" };
const resolutionLabelKeys: Record<string, MessageKey> = { FOUND: "analyticsResolutionFound", NOT_FOUND: "analyticsResolutionNotFound", WRONG_LOCATION: "analyticsResolutionWrongLocation", OTHER: "analyticsResolutionOther" };
const sourceLabelKeys: Record<string, MessageKey> = { PICKER_REPORT: "analyticsSourcePickerReport", TL_MANUAL: "analyticsSourceTlManual", ASSISTANT_MANUAL: "analyticsSourceAssistantManual", ADMIN_MANUAL: "analyticsSourceAdminManual" };

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
};

function isoDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultFilters(): FilterState {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    from: isoDate(from), to: isoDate(to), orderNumber: "", location: "", sku: "", phase: "", resolution: "", source: "", configVersion: "", pickerUserId: "", checkerUserId: "", troubleshooterUserId: "",
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
  return { label, count: number(row.count ?? row.cases ?? row.value) };
}

function normalizeDimension(value: unknown): AnalyticsDimension | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = String(row.label ?? row.key ?? row.location ?? row.sku ?? row.version ?? "");
  if (!label) return null;
  return { label, count: number(row.count ?? row.lines ?? row.cases ?? row.value) };
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
  kpis.casesByConfigurationVersion = Array.isArray(rawKpis.casesByConfigurationVersion) ? rawKpis.casesByConfigurationVersion.map(normalizeDimension).filter((row): row is AnalyticsDimension => row !== null) : [];
  const orders = Array.isArray(rawDuplicates.orders) ? rawDuplicates.orders.map((value) => {
    const row = value as Record<string, unknown>;
    const cases = Array.isArray(row.cases) ? row.cases.map((item) => {
      const itemRow = item as Record<string, unknown>;
      return { caseId: String(itemRow.caseId ?? itemRow.id ?? ""), createdAt: String(itemRow.createdAt ?? "") };
    }) : [];
    return { orderNumber: String(row.orderNumber ?? ""), occurrences: number(row.occurrences, cases.length), cases };
  }).filter((row) => row.orderNumber) : [];
  return {
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
  return new Intl.DateTimeFormat({ en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" }[locale], { dateStyle: "medium" }).format(parsed);
}

function ChartBars({ data, emptyLabel }: { data: AnalyticsBucket[] | AnalyticsDimension[]; emptyLabel: string }) {
  const max = Math.max(...data.map((item) => item.count), 0);
  if (!data.length) return <p className={styles.empty}>{emptyLabel}</p>;
  return <div className={styles.bars} role="list">{data.map((item) => <div className={styles.barRow} role="listitem" key={item.label}><span className={styles.barLabel} title={item.label}>{item.label}</span><span className={styles.barTrack}><span className={styles.barFill} style={{ width: `${max ? Math.max(4, (item.count / max) * 100) : 0}%` }} /></span><strong>{item.count}</strong></div>)}</div>;
}

function SelectFilter({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className={styles.field}><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">—</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
}

function participantOptions(data: AnalyticsResponse | null, role: "picker" | "checker" | "troubleshooter") {
  const people = new Map<string, string>();
  for (const row of data?.rows.cases ?? []) {
    const person = role === "picker" ? row.picker : role === "troubleshooter" ? row.responsible : undefined;
    if (person && typeof person === "object") {
      const value = person as { id?: unknown; displayName?: unknown };
      if (value.id && value.displayName) people.set(String(value.id), String(value.displayName));
    }
  }
  for (const row of data?.rows.lines ?? []) {
    const person = row[role];
    if (person && typeof person === "object") {
      const value = person as { id?: unknown; displayName?: unknown };
      if (value.id && value.displayName) people.set(String(value.id), String(value.displayName));
    }
  }
  return [...people.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function AnalyticsDashboard({ tr, locale, canExport }: Props) {
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const query = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params.toString();
  }, [filters]);
  const update = useCallback((key: keyof FilterState, value: string) => setFilters((current) => ({ ...current, [key]: value })), []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/analytics${query ? `?${query}` : ""}`, { credentials: "same-origin", cache: "no-store", signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error((body as { error?: string }).error || tr("analyticsLoadError"));
      setData(normalizeResponse(body));
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : tr("analyticsLoadError"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query, tr]);

  const downloadPdf = useCallback(async () => {
    setExporting("pdf");
    try {
      const response = await fetch(`/api/analytics/export/pdf${query ? `?${query}` : ""}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(tr("analyticsExportError"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "short-pick-analytics.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("analyticsExportError")); }
    finally { setExporting(""); }
  }, [query, tr]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => controller.abort();
  }, [load]);

  const download = useCallback(async (dataset: "case" | "line" | "event") => {
    setExporting(dataset);
    try {
      const response = await fetch(`/api/analytics/export/csv?dataset=${dataset}${query ? `&${query}` : ""}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(tr("analyticsExportError"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `short-pick-${dataset}-analytics.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("analyticsExportError")); }
    finally { setExporting(""); }
  }, [query, tr]);

  const options = data?.filters;
  const kpis = data?.kpis ?? EMPTY_KPIS;
  const phases = options?.phases ?? ["PICKING", "STAGED", "CLOSED"];
  const resolutions = options?.resolutions ?? ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"];
  const sources = options?.sources ?? ["PICKER_REPORT", "TL_MANUAL", "ASSISTANT_MANUAL", "ADMIN_MANUAL"];
  const configOptions = (options?.configurations ?? []).map((option) => ({ value: option.id, label: option.label ?? String(option.version ?? option.id) }));
  if (!configOptions.length) configOptions.push(...kpis.casesByConfigurationVersion.map((option) => ({ value: option.label, label: option.label })));
  const pickerOptions = participantOptions(data, "picker");
  const checkerOptions = participantOptions(data, "checker");
  const troubleshooterOptions = participantOptions(data, "troubleshooter");
  const partialDataMessages = data ? [
    data.limits.casesTruncated ? tr("analyticsCasesTruncated") : "",
    data.limits.linesTruncated ? tr("analyticsLinesTruncated") : "",
    data.limits.eventsTruncated ? tr("analyticsEventsTruncated") : "",
    data.limits.duplicateOrdersTruncated ? tr("analyticsDuplicateOrdersTruncated") : "",
    data.limits.derivedMetricsTruncated ? tr("analyticsDerivedMetricsTruncated") : "",
  ].filter(Boolean) : [];

  return <div className={styles.dashboard}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>{tr("analyticsEyebrow")}</p><h1>{tr("analyticsTitle")}</h1><p className={styles.description}>{tr("analyticsDescription")}</p></div><div className={styles.actions}>{canExport && <><button className={styles.exportButton} type="button" onClick={() => void download("case")} disabled={Boolean(exporting)}>{exporting === "case" ? tr("analyticsExporting") : tr("analyticsExportCases")}</button><button className={styles.exportButton} type="button" onClick={() => void download("line")} disabled={Boolean(exporting)}>{exporting === "line" ? tr("analyticsExporting") : tr("analyticsExportLines")}</button><button className={styles.exportButton} type="button" onClick={() => void download("event")} disabled={Boolean(exporting)}>{exporting === "event" ? tr("analyticsExporting") : tr("analyticsExportEvents")}</button><button className={styles.exportButton} type="button" onClick={() => void downloadPdf()} disabled={Boolean(exporting)}>{exporting === "pdf" ? tr("analyticsExporting") : tr("analyticsExportPdf")}</button></>}</div></div>
    <section className={styles.filters} aria-labelledby="analytics-filters-title"><div className={styles.sectionHeading}><h2 id="analytics-filters-title">{tr("analyticsFilters")}</h2><button className={styles.clearButton} type="button" onClick={() => setFilters(defaultFilters())}>{tr("analyticsClearFilters")}</button></div><div className={styles.filterGrid}>
      <label className={styles.field}><span>{tr("analyticsFrom")}</span><input type="date" value={filters.from} onChange={(event) => update("from", event.target.value)} /></label><label className={styles.field}><span>{tr("analyticsTo")}</span><input type="date" value={filters.to} onChange={(event) => update("to", event.target.value)} /></label><label className={styles.field}><span>{tr("orderNumber")}</span><input inputMode="numeric" value={filters.orderNumber} onChange={(event) => update("orderNumber", event.target.value)} placeholder={tr("orderNumberPlaceholder")} /></label><label className={styles.field}><span>{tr("location")}</span><input value={filters.location} onChange={(event) => update("location", event.target.value.toUpperCase())} /></label><label className={styles.field}><span>{tr("sku")}</span><input value={filters.sku} onChange={(event) => update("sku", event.target.value.toUpperCase())} /></label><SelectFilter label={tr("analyticsPhase")} value={filters.phase} options={phases.map((value) => ({ value, label: enumLabel(value, phaseLabelKeys, tr) }))} onChange={(value) => update("phase", value)} /><SelectFilter label={tr("analyticsResolution")} value={filters.resolution} options={resolutions.map((value) => ({ value, label: enumLabel(value, resolutionLabelKeys, tr) }))} onChange={(value) => update("resolution", value)} /><SelectFilter label={tr("analyticsSource")} value={filters.source} options={sources.map((value) => ({ value, label: enumLabel(value, sourceLabelKeys, tr) }))} onChange={(value) => update("source", value)} /><SelectFilter label={tr("analyticsConfiguration")} value={filters.configVersion} options={configOptions} onChange={(value) => update("configVersion", value)} /><SelectFilter label={tr("analyticsPicker")} value={filters.pickerUserId} options={pickerOptions} onChange={(value) => update("pickerUserId", value)} /><SelectFilter label={tr("analyticsChecker")} value={filters.checkerUserId} options={checkerOptions} onChange={(value) => update("checkerUserId", value)} /><SelectFilter label={tr("analyticsTroubleshooter")} value={filters.troubleshooterUserId} options={troubleshooterOptions} onChange={(value) => update("troubleshooterUserId", value)} />
    </div></section>
    {error && <div className={styles.alert} role="alert">{error}<button type="button" onClick={() => void load()}>{tr("tryAgain")}</button></div>}
    {partialDataMessages.length > 0 && <div className={styles.partialNotice} role="status"><strong>{tr("analyticsPartialData")}</strong><ul>{partialDataMessages.map((message) => <li key={message}>{message}</li>)}</ul></div>}
    {loading && !data ? <p className={styles.loading} aria-live="polite">{tr("analyticsLoading")}</p> : <>
      <section aria-labelledby="analytics-kpis-title"><h2 className={styles.srOnly} id="analytics-kpis-title">{tr("analyticsKpis")}</h2><div className={styles.kpiGrid}>{[["analyticsTotalCases", kpis.totalCases], ["analyticsTotalLines", kpis.totalLines], ["analyticsFound", kpis.foundDuringCheck], ["analyticsNotFound", kpis.notFound], ["analyticsWrongLocation", kpis.wrongLocation], ["analyticsRetrieved", kpis.retrieved], ["analyticsOverThreshold", kpis.casesOverThreshold], ["analyticsManualCases", kpis.manualCases], ["analyticsReopenedCases", kpis.reopenedCases], ["analyticsRepeatedOrders", kpis.repeatedOrderNumbers]].map(([label, value]) => <article className={styles.kpi} key={String(label)}><span>{tr(label as MessageKey)}</span><strong>{value}</strong></article>)}</div></section>
      <div className={styles.chartGrid}><section className={styles.card} aria-labelledby="analytics-volume-title"><div className={styles.sectionHeading}><h2 id="analytics-volume-title">{tr("analyticsCasesByPeriod")}</h2><span className={styles.cardMeta}>{tr("analyticsCasesUnit")}</span></div><ChartBars data={kpis.casesByPeriod} emptyLabel={tr("analyticsNoData")} /></section><section className={styles.card} aria-labelledby="analytics-location-title"><div className={styles.sectionHeading}><h2 id="analytics-location-title">{tr("analyticsLinesByLocation")}</h2><span className={styles.cardMeta}>{tr("analyticsLinesUnit")}</span></div><ChartBars data={kpis.linesByLocation} emptyLabel={tr("analyticsNoData")} /></section><section className={styles.card} aria-labelledby="analytics-sku-title"><div className={styles.sectionHeading}><h2 id="analytics-sku-title">{tr("analyticsLinesBySku")}</h2><span className={styles.cardMeta}>{tr("analyticsLinesUnit")}</span></div><ChartBars data={kpis.linesBySku} emptyLabel={tr("analyticsNoData")} /></section><section className={styles.card} aria-labelledby="analytics-config-title"><div className={styles.sectionHeading}><h2 id="analytics-config-title">{tr("analyticsByConfiguration")}</h2><span className={styles.cardMeta}>{tr("analyticsCasesUnit")}</span></div><ChartBars data={kpis.casesByConfigurationVersion} emptyLabel={tr("analyticsNoData")} /></section></div>
      <section className={styles.card} aria-labelledby="analytics-timing-title"><div className={styles.sectionHeading}><h2 id="analytics-timing-title">{tr("analyticsMedianTiming")}</h2></div><div className={styles.timingGrid}>{[["analyticsReportToClaim", kpis.medianReportToCheckClaimedSeconds], ["analyticsReportToFound", kpis.medianReportToLocationFoundSeconds], ["analyticsReportToRetrieval", kpis.medianReportToRetrievalSeconds], ["analyticsReportToResolution", kpis.medianReportToResolutionSeconds]].map(([label, value]) => <div className={styles.timing} key={String(label)}><span>{tr(label as MessageKey)}</span><strong>{formatDuration(value as number | null, tr)}</strong></div>)}</div></section>
      <section className={styles.card} aria-labelledby="analytics-duplicates-title"><div className={styles.sectionHeading}><div><h2 id="analytics-duplicates-title">{tr("analyticsDuplicateOrders")}</h2><p className={styles.subtle}>{tr("analyticsDuplicateSummary", { count: String(data?.duplicates.repeatedOrderCount ?? 0) })}</p></div></div>{data?.duplicates.orders.length ? <div className={styles.tableWrap}><table><thead><tr><th scope="col">{tr("orderNumber")}</th><th scope="col">{tr("analyticsOccurrences")}</th><th scope="col">{tr("analyticsCaseDates")}</th></tr></thead><tbody>{data.duplicates.orders.map((order) => <tr key={order.orderNumber}><th scope="row">{order.orderNumber}</th><td>{order.occurrences}</td><td>{order.cases.map((item) => <time key={item.caseId} dateTime={item.createdAt}>{dateLabel(item.createdAt, locale)}</time>)}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>{tr("analyticsNoDuplicates")}</p>}</section>
      <p className={styles.dataNote}>{tr("analyticsDataNote", { cases: String(data?.rows.cases.length ?? 0), lines: String(data?.rows.lines.length ?? 0) })}</p>
    </>}
  </div>;
}
