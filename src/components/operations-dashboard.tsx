"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { MessageKey } from "@/i18n/messages";
import { LiveRefreshStatus } from "@/components/live-refresh-status";
import { ScanInput } from "@/components/scan-input";
import { useLiveRefresh } from "@/components/use-live-refresh";
import styles from "./operations-dashboard.module.css";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { aggregateCaseDisplayStatus } from "@/domain/case-display-status";
import type { CaseTimelineEvent } from "@/components/case-timeline";
import { elapsedWorkingMinutes } from "@/domain/working-hours";
import type { WorkingHours } from "@/domain/working-hours";
import { PaginationControls } from "@/components/pagination-controls";
import { SharedCaseLineCard } from "@/components/case-line-card";
import { CaseDetailView, CaseSummaryCard, formatCaseElapsedTime } from "@/components/case-detail-view";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;
type Metrics = {
  openCases: number;
  openShortPicks: number;
  checking: number;
  staged: number;
  overThreshold: number;
  resolvedToday: number;
};
type CaseLine = {
  id: string;
  location: string;
  sku: string;
  quantity: number;
  state: string;
  retrievalState?: string;
  retrievalResponsibleName?: string | null;
  discoveredLocation?: string | null;
  replenishmentState?: string | null;
  replenishmentNote?: string | null;
  replenishmentActorName?: string | null;
  reporterName?: string | null;
  reporterIdentifier?: string | null;
};
type CaseEvent = { id: string; eventType: string; createdAt: string; actorName?: string | null; payload?: Record<string, unknown>; completionCode?: string | null; discoveredLocation?: string | null; originalLocation?: string | null; taskId?: string | null };
type CaseMessage = { id: string; message: string; createdAt: string; authorName: string; shortPickLineId?: string | null };
type CaseSummary = {
  id: string;
  orderNumber: string;
  phase: string;
  createdAt: string;
  pickerName: string | null;
  pickerIdentifier?: string | null;
  missingCount: number;
  checkingCount: number;
  currentIssue: string;
  responsibleName: string | null;
  responsibleIdentifier?: string | null;
  source: string;
  physicalState?: string;
  physicalLocation?: string | null;
  lines?: CaseLine[];
  lineProjections?: Array<{ lineId: string; displayStatus: string; replenishment?: { state: string; note: string | null; actorName: string | null; at: string | null }; nextActionCode?: string; actionOwnerName?: string | null; blockingReasonCode?: string | null }>;
  projection?: { lines?: Array<{ displayStatus: string }> };
  events?: CaseEvent[];
  eventsPagination?: { total: number; page: number; pageSize: number; totalPages: number } | null;
  messages?: CaseMessage[];
  attentionLevel?: "NORMAL" | "WARNING" | "ATTENTION" | "CRITICAL";
  resolvedAt?: string | null;
  closedAt?: string | null;
  workingHours?: WorkingHours;
  elapsedWorkingMinutes?: number | null;
};
type ClosedCaseSummary = {
  id: string;
  orderNumber: string;
  phase: "CLOSED";
  createdAt: string;
  resolvedAt?: string | null;
  pickerName: string | null;
  responsibleName: string | null;
};
type ClosedPageMeta = { total: number; page: number; pageSize: number; totalPages: number };
type Worker = { id: string; displayName: string; role: string; status: string };
type DashboardResponse = { metrics?: Metrics; attentionThresholdMinutes?: number; thresholds?: { warning?: number; attention?: number; critical?: number }; cases?: CaseSummary[]; recentClosedCases?: ClosedCaseSummary[]; closedPagination?: ClosedPageMeta };
type HistoricalCase = { id: string; createdAt: string; phase: string };
type CaseResponse = { case?: CaseSummary; history?: HistoricalCase[]; code?: string; users?: Worker[] };
type Props = {
  tr: Translator;
  locale: string;
  canCreateManual: boolean;
  canMessage: boolean;
  canAssign: boolean;
  canClose: boolean;
  canReopen: boolean;
  canChangePhase: boolean;
  canRecordReplenishment?: boolean;
  /** Explicit ASSIGN_CHECK grant for manager REQUEST_CHECK; distinct from ASSIGN_TROUBLESHOOTER. Root passes from authApp. */
  canRequestCheck?: boolean;
  canReportLocation?: boolean;
  focusedCaseId?: string | null;
  focusedLineId?: string | null;
  focusedNonce?: number;
  focusFromNotification?: boolean;
  onFocusConsumed?: () => void;
  onFocusedClose?: () => void;
};

type FilterPhase = "ALL" | "PICKING" | "STAGED";
type SortOrder = "OLDEST" | "NEWEST" | "ORDER";

const EMPTY_METRICS: Metrics = { openCases: 0, openShortPicks: 0, checking: 0, staged: 0, overThreshold: 0, resolvedToday: 0 };
const dateLocales: Record<string, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

async function readBody<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function formatAge(createdAt: string, item?: Pick<CaseSummary, "resolvedAt" | "workingHours" | "elapsedWorkingMinutes">, nowMs?: number | null) {
  const minutes = item?.elapsedWorkingMinutes ?? elapsedWorkingMinutes(createdAt, item?.resolvedAt ?? (nowMs ?? Date.now()), item?.workingHours, nowMs ?? Date.now());
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(dateLocales[locale] || "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}


function attentionLabel(level: CaseSummary["attentionLevel"], tr: Translator) {
  const keys: Record<NonNullable<CaseSummary["attentionLevel"]>, MessageKey> = {
    NORMAL: "attentionNormal",
    WARNING: "attentionWarning",
    ATTENTION: "attentionAttention",
    CRITICAL: "attentionCritical",
  };
  return tr(keys[level ?? "NORMAL"]);
}

function LocationReporter({ tr, caseId, lineId, onReported }: { tr: Translator; caseId: string; lineId: string; onReported: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = location.trim();
    if (!value || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/discovered-location`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: value }),
      });
      if (!response.ok) throw new Error("location");
      setLocation("");
      setOpen(false);
      await onReported();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button type="button" className={styles.secondary} onClick={() => { setFailed(false); setOpen(true); }}>
        {tr("reportLocationAction")}
      </button>
    );
  }
  return (
    <form className={styles.lineForm} onSubmit={submit}>
      <label>
        <span>{tr("reportLocationAction")}</span>
        <ScanInput required autoCapitalize="characters" value={location} onChange={setLocation} tr={tr} scanKind="location" fieldLabel={tr("reportLocationAction")} placeholder={tr("reportLocationPlaceholder")} />
      </label>
      {failed ? <p className={styles.alert} role="alert">{tr("reportLocationFailed")}</p> : null}
      <div className={styles.formActions}>
        <button type="button" className={styles.secondary} onClick={() => { setOpen(false); setFailed(false); }} disabled={busy}>
          {tr("cancel")}
        </button>
        <button type="submit" className={styles.primary} disabled={busy || !location.trim()}>
          {tr("reportLocationAction")}
        </button>
      </div>
    </form>
  );
}

export function OperationsDashboard({ tr, locale, canCreateManual, canMessage, canAssign, canClose, canReopen, canChangePhase, canRecordReplenishment = false, canRequestCheck = false, canReportLocation = false, focusedCaseId, focusedLineId = null, focusedNonce, focusFromNotification, onFocusConsumed, onFocusedClose }: Props) {
  const dashboardRequestInFlight = useRef(false);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [attentionThresholdMinutes, setAttentionThresholdMinutes] = useState(15);
  const [thresholds, setThresholds] = useState({ warning: 5, attention: 10, critical: 15 });
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [pageMeta, setPageMeta] = useState({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [recentClosedCases, setRecentClosedCases] = useState<ClosedCaseSummary[]>([]);
  const [closedPageMeta, setClosedPageMeta] = useState<ClosedPageMeta>({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [timelinePages, setTimelinePages] = useState<Record<string, number>>({});
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<CaseSummary | null>(null);
  const [filterPhase, setFilterPhase] = useState<FilterPhase>("ALL");
  const [sortOrder, setSortOrder] = useState<SortOrder>("OLDEST");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Success confirmations dismiss themselves; errors stay until the next action.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const [showManual, setShowManual] = useState(false);
  const [manualOrder, setManualOrder] = useState("");
  const [manualLocation, setManualLocation] = useState("");
  const [manualSku, setManualSku] = useState("");
  const [manualQuantity, setManualQuantity] = useState("1");
  const [manualPicker, setManualPicker] = useState("");
  const [manualPhase, setManualPhase] = useState<"PICKING" | "STAGED">("STAGED");
  const [manualReason, setManualReason] = useState("");
  const [historicalCases, setHistoricalCases] = useState<HistoricalCase[]>([]);
  const [confirmHistory, setConfirmHistory] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [adminResolution, setAdminResolution] = useState("");
  const [reopenPhase, setReopenPhase] = useState<"PICKING" | "STAGED">("PICKING");
  const [reopenResponsible, setReopenResponsible] = useState("");
  const [clockNow, setClockNow] = useState<number | null>(null);
  const closedPageRef = useRef(1);
  const [dashboardClosedPage, setDashboardClosedPage] = useState(1);
  const fetchDashboardPage = useCallback(async (nextPage: number, targetClosedPage: number) => {
    try {
      const response = await fetch(`/api/operations/dashboard?page=${nextPage}&pageSize=20&closedPage=${targetClosedPage}`, { cache: "no-store" });
      const body = await readBody<DashboardResponse & { total?: number; page?: number; pageSize?: number; totalPages?: number }>(response);
      if (!response.ok) throw new Error(tr("operationsLoadFailed"));
      setMetrics({ ...EMPTY_METRICS, ...(body.metrics || {}) });
      if (body.thresholds) setThresholds((current) => ({ ...current, ...body.thresholds }));
      if (body.attentionThresholdMinutes && body.attentionThresholdMinutes > 0) setAttentionThresholdMinutes(body.attentionThresholdMinutes);
      setCases(body.cases || []);
      setPageMeta({
        total: typeof body.total === "number" ? body.total : (body.cases || []).length,
        page: typeof body.page === "number" && body.page >= 1 ? body.page : nextPage,
        pageSize: typeof body.pageSize === "number" && body.pageSize >= 1 ? body.pageSize : 20,
        totalPages: typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : 1,
      });
      setRecentClosedCases(body.recentClosedCases || []);
      setClosedPageMeta(body.closedPagination ?? { total: (body.recentClosedCases || []).length, page: targetClosedPage, pageSize: 20, totalPages: 1 });
      setDashboardClosedPage(body.closedPagination?.page ?? targetClosedPage);
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("operationsLoadFailed"));
      return false;
    } finally {
      setLoading(false);
    }
  }, [tr]);
  const fetchDashboard = useCallback(async (nextPage = 1, nextClosedPage?: number) => {
    if (dashboardRequestInFlight.current) return true;
    dashboardRequestInFlight.current = true;
    try {
      return await fetchDashboardPage(nextPage, nextClosedPage ?? closedPageRef.current);
    } finally {
      dashboardRequestInFlight.current = false;
    }
  }, [fetchDashboardPage]);
  const selectedCaseId = selected?.id;
  const pageRef = useRef(pageMeta.page);
  useEffect(() => { pageRef.current = pageMeta.page; }, [pageMeta.page]);
  useEffect(() => { closedPageRef.current = closedPageMeta.page; }, [closedPageMeta.page]);
  const refreshLiveData = useCallback(async () => {
    if (!await fetchDashboard(pageRef.current, closedPageRef.current)) throw new Error("refresh failed");
    if (selectedCaseId) {
      const timelinePage = timelinePages[selectedCaseId] ?? 1;
      const response = await fetch(`/api/cases/${encodeURIComponent(selectedCaseId)}?page=${timelinePage}&pageSize=50`, { cache: "no-store" });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok || !body.case) throw new Error("refresh failed");
      setSelected((current) => current?.id === selectedCaseId ? body.case ?? current : current);
    }
  }, [fetchDashboard, selectedCaseId, timelinePages]);
  const liveState = useLiveRefresh(refreshLiveData);

  const fetchWorkers = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/users?page=1&pageSize=100", { cache: "no-store" });
      const body = await readBody<CaseResponse>(response);
      if (response.ok) setWorkers((body.users || []).filter((worker) => worker.status === "ACTIVE"));
    } catch {
      // Optional picker selection remains available through the free-text reason and order details.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setClockNow(Date.now()), 0);
    const clockTimer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 5_000);
    return () => { window.clearTimeout(timer); window.clearInterval(clockTimer); };
  }, []);

  useEffect(() => {
    if (!canCreateManual && !canAssign && !canReopen) return;
    const timer = window.setTimeout(() => { void fetchWorkers(); }, 0);
    return () => window.clearTimeout(timer);
  }, [canAssign, canCreateManual, canReopen, fetchWorkers]);

  const workingMinutesById: Record<string, number> = useMemo(() => {
    if (clockNow === null) return {};
    return Object.fromEntries(cases.map((item) => [item.id, item.elapsedWorkingMinutes ?? elapsedWorkingMinutes(item.createdAt, item.resolvedAt ?? clockNow, item.workingHours, clockNow)]));
  }, [cases, clockNow]);

  const visibleCases = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return cases
      .filter((item) => filterPhase === "ALL" || item.phase === filterPhase)
      .filter((item) => !normalized || [item.orderNumber, item.pickerName, item.responsibleName, item.currentIssue].some((value) => value?.toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => sortOrder === "NEWEST" ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : sortOrder === "ORDER" ? a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true }) : Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [cases, filterPhase, sortOrder, query]);

  const loadCase = useCallback(async (caseId: string, timelinePage = 1) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${caseId}?page=${timelinePage}&pageSize=50`, { cache: "no-store" });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setTimelinePages((current) => ({ ...current, [caseId]: timelinePage }));
      setSelected(body.case);
      setReopenPhase(body.case.phase === "STAGED" ? "STAGED" : "PICKING");
      setReopenResponsible("");
      setMessageText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLoadError"));
    } finally {
      setBusy(false);
    }
  }, [tr]);
  const focusConsumedRef = useRef(0);
  const [focusOverlayNonce, setFocusOverlayNonce] = useState(0);
  const focusedLineRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusedCaseId || !focusedNonce || focusConsumedRef.current === focusedNonce) return;
    focusConsumedRef.current = focusedNonce;
    queueMicrotask(() => { if (focusFromNotification) setFocusOverlayNonce(focusedNonce); });
    void loadCase(focusedCaseId).finally(() => { onFocusConsumed?.(); });
  }, [focusedCaseId, focusedNonce, focusFromNotification, loadCase, onFocusConsumed]);
  useEffect(() => {
    if (!focusedLineId || !selected || selected.id !== focusedCaseId) return;
    focusedLineRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedLineId, focusedCaseId, selected]);
  const focusOverlay = focusOverlayNonce !== 0;
  const reloadDashboardCurrentPage = useCallback(async () => fetchDashboardPage(1, dashboardClosedPage), [dashboardClosedPage, fetchDashboardPage]);
  const reloadCaseTimelinePage = useCallback(async (caseId: string) => loadCase(caseId, timelinePages[caseId] ?? 1), [loadCase, timelinePages]);
  const refreshSelected = async () => {
    await fetchDashboard();
    if (selected) await loadCase(selected.id, timelinePages[selected.id] ?? 1);
  };

  const submitManual = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      orderNumber: manualOrder.trim(),
      firstLine: { location: manualLocation.trim(), sku: manualSku.trim(), quantity: Number(manualQuantity) },
      phase: manualPhase,
      ...(manualPicker ? { originalPickerUserId: manualPicker } : {}),
      ...(manualReason.trim() ? { reason: manualReason.trim() } : {}),
      ...(historicalCases?.length && confirmHistory ? { confirmedHistoricalCaseIds: historicalCases.map((item) => item.id) } : {}),
    };
    try {
      const response = await fetch("/api/cases/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok) {
        if (body.code === "HISTORICAL_CONFIRMATION_REQUIRED" && body.history?.length) {
          setHistoricalCases(body.history);
          setConfirmHistory(false);
          setError(tr("manualHistoricalConfirm"));
          return;
        }
        if (body.code === "OPEN_CASE_EXISTS" && body.case?.id) {
          setShowManual(false);
          setNotice(tr("manualOpenCaseExists"));
          await loadCase(body.case.id);
          return;
        }
        throw new Error(body.code === "OPEN_CASE_EXISTS" ? tr("manualOpenCaseExists") : tr("manualCaseCreateFailed"));
      }
      setShowManual(false);
      setManualOrder(""); setManualLocation(""); setManualSku(""); setManualQuantity("1"); setManualPicker(""); setManualPhase("STAGED"); setManualReason(""); setHistoricalCases([]); setConfirmHistory(false);
      setNotice(tr("manualCaseCreated"));
      await fetchDashboard();
      if (body.case?.id) await loadCase(body.case.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("manualCaseCreateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const mutateCase = async (path: string, method: "POST", payload: unknown, successKey: MessageKey): Promise<boolean> => {
    if (!selected) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok) throw new Error(body.code === "CASE_HAS_OPEN_LINES" || body.code === "CASE_NOT_CLOSABLE" ? tr("caseCloseNeedsResolution") : tr("caseActionFailed"));
      setNotice(tr(successKey));
      await fetchDashboard();
      await loadCase(selected.id, timelinePages[selected.id] ?? 1);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseActionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const postMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !messageText.trim()) return;
    const saved = await mutateCase(`/api/cases/${selected.id}/messages`, "POST", { message: messageText.trim() }, "caseMessageSent");
    if (saved) setMessageText("");
  };
  const changePhase = async (phase: "PICKING" | "STAGED") => {
    if (!selected || selected.phase === phase || selected.phase === "CLOSED" || selected.closedAt) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/cases/${selected.id}/phase`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, ...(phase === "STAGED" ? { confirmedPhysicalPlacement: true } : {}) }) });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok) throw new Error(body.code ? tr("orderStatusUpdateFailed") : tr("orderStatusUpdateFailed"));
      setNotice(tr("orderStatusUpdated"));
      await fetchDashboard();
      await loadCase(selected.id, timelinePages[selected.id] ?? 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("orderStatusUpdateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const renderMetric = (key: MessageKey, value: number, tone: string) => <div className={`${styles.metric} ${styles[tone]}`} key={key}><span>{key === "metricOverThreshold" ? tr(key, { minutes: String(attentionThresholdMinutes) }) : tr(key)}</span><strong>{value}</strong></div>;

  return <main className={styles.dashboard}>
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>{tr("operationsEyebrow")}</p><h1>{tr("operationsDashboard")}</h1><p>{tr("operationsDescription")}</p></div>
      <div className={styles.headingActions}><LiveRefreshStatus state={liveState} tr={tr} /><button type="button" className={styles.refresh} onClick={() => void refreshSelected()} disabled={loading || busy}>{tr("refresh")}</button>{canCreateManual && <button type="button" className={styles.primary} onClick={() => { setShowManual((open) => !open); setError(""); }}>{showManual ? tr("cancel") : tr("createManualCase")}</button>}</div>
    </header>
    {error && <p className={styles.alert} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <section className={styles.metrics} aria-label={tr("operationsMetrics")}>
      {renderMetric("metricOpenCases", metrics.openCases, "toneBlue")}{renderMetric("metricOpenShortPicks", metrics.openShortPicks, "toneMint")}{renderMetric("metricChecking", metrics.checking, "toneAmber")}{renderMetric("metricStaged", metrics.staged, "toneLavender")}{renderMetric("metricOverThreshold", metrics.overThreshold, "toneRose")}{renderMetric("metricResolvedToday", metrics.resolvedToday, "toneGray")}
    </section>
    {showManual && canCreateManual && <section className={styles.manualPanel}>
      <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{tr("manualCaseEyebrow")}</p><h2>{tr("createManualCase")}</h2></div><button className={styles.iconButton} type="button" aria-label={tr("closePanel")} onClick={() => setShowManual(false)}>×</button></div>
      <p>{tr("manualCaseDescription")}</p>
      <form className={styles.manualForm} onSubmit={submitManual}>
        <label><span>{tr("orderNumber")}</span><ScanInput inputMode="numeric" required value={manualOrder} onChange={setManualOrder} tr={tr} scanKind="order" fieldLabel={tr("orderNumber")} /></label>
        <label><span>{tr("location")}</span><ScanInput required autoCapitalize="characters" value={manualLocation} onChange={setManualLocation} tr={tr} scanKind="location" fieldLabel={tr("location")} /></label>
        <label><span>{tr("sku")}</span><ScanInput required autoCapitalize="characters" value={manualSku} onChange={setManualSku} tr={tr} scanKind="sku" fieldLabel={tr("sku")} /></label>
        <label><span>{tr("missingQuantity")}</span><input required type="number" min="1" step="1" value={manualQuantity} onChange={(event) => setManualQuantity(event.target.value)} /></label>
        <label><span>{tr("originalPickerOptional")}</span><select value={manualPicker} onChange={(event) => setManualPicker(event.target.value)}><option value="">{tr("noPickerSelected")}</option>{workers.filter((worker) => worker.role === "PICKER" || worker.role === "TROUBLESHOOTER").map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label>
        <label><span>{tr("manualStatusLabel")}</span><select value={manualPhase} onChange={(event) => setManualPhase(event.target.value as "PICKING" | "STAGED")}><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label>
        <label className={styles.wide}><span>{tr("manualReasonOptional")}</span><textarea rows={2} maxLength={500} value={manualReason} onChange={(event) => setManualReason(event.target.value)} /></label>
        {historicalCases?.length ? <div className={styles.historyConfirm} role="alert"><strong>{tr("manualHistoricalCasesTitle")}</strong><ul>{historicalCases.map((item) => <li key={item.id}>{manualOrder} · {item.phase === "CLOSED" ? tr("caseClosed") : item.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")} · {formatDate(item.createdAt, locale)}</li>)}</ul><label className={styles.confirmCheck}><input type="checkbox" checked={confirmHistory} onChange={(event) => setConfirmHistory(event.target.checked)} /><span>{tr("manualHistoryAcknowledged")}</span></label></div> : null}
        <div className={`${styles.formActions} ${styles.wide}`}><button type="button" className={styles.secondary} onClick={() => { setShowManual(false); setConfirmHistory(false); setHistoricalCases([]); }}>{tr("cancel")}</button><button type="submit" className={styles.primary} disabled={busy || (Boolean(historicalCases?.length) && !confirmHistory)}>{busy ? tr("saving") : tr("saveManualCase")}</button></div>
      </form>
    </section>}
    <section className={styles.queue}>
      <div className={styles.queueHeader}><div><p className={styles.eyebrow}>{tr("liveOperations")}</p><h2>{tr("openCaseQueue")}</h2></div><span className={styles.count}>{pageMeta.total || visibleCases.length}</span></div>
      <div className={styles.filters}>
        <label className={styles.search}><span className={styles.srOnly}>{tr("searchCases")}</span><input type="search" placeholder={tr("searchCasesPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span className={styles.srOnly}>{tr("filterByPhase")}</span><select value={filterPhase} onChange={(event) => setFilterPhase(event.target.value as FilterPhase)}><option value="ALL">{tr("allPhases")}</option><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label>
        <label><span className={styles.srOnly}>{tr("sortCases")}</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}><option value="OLDEST">{tr("oldestFirst")}</option><option value="NEWEST">{tr("newestFirst")}</option><option value="ORDER">{tr("orderNumber")}</option></select></label>
      </div>
      {loading ? <p className={styles.empty}>{tr("loadingCases")}</p> : visibleCases.length ? <><div className={styles.caseList}>
        {visibleCases.map((item) => {
          const age = workingMinutesById[item.id] ?? 0;
          const fallbackLevel: NonNullable<CaseSummary["attentionLevel"]> = age >= thresholds.critical ? "CRITICAL" : age >= thresholds.attention ? "ATTENTION" : age >= thresholds.warning ? "WARNING" : "NORMAL";
          const level = item.attentionLevel ?? fallbackLevel;
          const attentionClass = level === "CRITICAL" ? styles.critical : level === "ATTENTION" ? styles.attention : level === "WARNING" ? styles.warning : "";
          const badgeClass = level === "CRITICAL" ? styles.attentionBadgeCritical : level === "ATTENTION" ? styles.attentionBadgeAttention : level === "WARNING" ? styles.attentionBadgeWarning : styles.attentionBadgeNormal;
          return <button type="button" className={`${styles.caseCard} ${attentionClass}`} key={item.id} onClick={() => void loadCase(item.id)}>
            <div className={styles.caseTop}><strong>{tr("orderLabel")} {item.orderNumber}</strong><span className={styles.caseBadges}><span className={styles.caseStatusBadge}><CaseStatusBadge status={aggregateCaseDisplayStatus(item.phase, item.lines, item.lineProjections)} tr={tr} /></span><span className={`${styles.attentionBadge} ${badgeClass}`} aria-label={`${tr("attentionLevelLabel")}: ${attentionLabel(level, tr)}`}>{attentionLabel(level, tr)}</span><span className={`${styles.phase} ${item.phase === "STAGED" ? styles.phaseStaged : ""}`}>{item.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}</span></span></div>
            <div className={styles.caseData}><span><b>{item.missingCount}</b> {tr("missingItemsLabel")}</span><span>{item.checkingCount} {tr("checkingLabel")}</span><span className={styles.age}>{formatAge(item.createdAt, item, clockNow)}</span></div>
            <div className={styles.caseFoot}><span>{item.pickerName || tr("unknownPicker")}</span><span>{item.currentIssue ? tr(`issue_${item.currentIssue}` as MessageKey) : tr("caseNoCurrentIssue")}</span><span>{item.responsibleName || "—"}</span></div>
          </button>;
        })}
      </div><PaginationControls tr={tr} meta={pageMeta} loading={loading} onPage={(next) => void fetchDashboard(next)} /></> : <p className={styles.empty}>{tr("noOpenCases")}</p>}
    </section>
    <section className={styles.queue}>
      <div className={styles.queueHeader}><div><p className={styles.eyebrow}>{tr("caseClosed")}</p><h2>{tr("recentClosedCases")}</h2></div><span className={styles.count}>{closedPageMeta.total || recentClosedCases.length}</span></div>
      {loading ? <p className={styles.empty}>{tr("loadingCases")}</p> : recentClosedCases.length ? <><div className={styles.caseList}>
        {recentClosedCases.map((item) => <button type="button" className={`${styles.caseCard} ${styles.closedCard}`} key={item.id} onClick={() => void loadCase(item.id)}>
          <div className={styles.caseTop}><strong>{tr("orderLabel")} {item.orderNumber}</strong><span className={`${styles.phase} ${styles.phaseClosed}`}>{tr("caseClosed")}</span></div>
          <div className={styles.caseData}><span>{tr("caseClosedOn", { date: formatDate(item.resolvedAt || item.createdAt, locale) })}</span></div>
          <div className={styles.caseFoot}><span>{item.pickerName || tr("unknownPicker")}</span><span>{item.responsibleName || "—"}</span></div>
        </button>)}
      </div><PaginationControls tr={tr} meta={closedPageMeta} loading={loading} onPage={(next) => void fetchDashboard(pageRef.current, next)} /></> : <p className={styles.empty}>{tr("noRecentClosedCases")}</p>}
    </section>
    {selected && <div className={`${styles.backdrop}${focusOverlay ? ` ${styles.notificationOverlay}` : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelected(null); setFocusOverlayNonce(0); onFocusedClose?.(); } }}>
      <section className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="case-drawer-title">
        <CaseDetailView
          tr={tr}
          id="case-drawer-detail"
          titleId="case-drawer-title"
          className={styles.drawerDetail}
          orderNumber={selected.orderNumber}
          phaseLabel={selected.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}
          headingActions={<span className={`case-badges ${styles.caseStatusBadge}`}>
            <CaseStatusBadge status={aggregateCaseDisplayStatus(selected.phase, selected.lines, selected.lineProjections)} tr={tr} />
            {selected.phase === "CLOSED" ? null : <span className={`${styles.phase} ${selected.phase === "STAGED" ? styles.phaseStaged : ""}`}>{selected.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}</span>}
            <button className={styles.iconButton} type="button" aria-label={tr("closePanel")} onClick={() => { setSelected(null); setFocusOverlayNonce(0); onFocusedClose?.(); }}>×</button>
          </span>}
          summary={<>
            {selected.phase === "CLOSED" ? <p className={styles.drawerSummary}>{tr("caseClosedOn", { date: formatDate(selected.resolvedAt || selected.createdAt, locale) })}</p> : null}
            <CaseSummaryCard tr={tr} responsibleName={selected.responsibleName} responsibleIdentifier={selected.responsibleIdentifier} source={selected.source} missingCount={selected.missingCount} elapsedTime={formatCaseElapsedTime(selected.createdAt, selected.resolvedAt ?? null, selected.workingHours)} />
          </>}
          showLinesHeading
          linesClassName={styles.lineList}
          lines={selected.lines?.length ? (() => {
          const projections = new Map((selected.lineProjections ?? []).map((entry) => [entry.lineId, { lineId: entry.lineId, displayStatus: entry.displayStatus, replenishment: entry.replenishment ?? null, nextActionCode: entry.nextActionCode ?? null, actionOwnerName: entry.actionOwnerName ?? null, blockingReasonCode: entry.blockingReasonCode ?? null }]));
          const requestCheck = async (lineId: string) => {
            setBusy(true); setError(""); setNotice("");
            try {
              const response = await fetch(`/api/cases/${selected.id}/lines/${lineId}/checks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
              const body = await readBody<{ code?: string }>(response);
              if (!response.ok) throw new Error(body.code ? tr("requestCheckFailed") : tr("requestCheckFailed"));
              setNotice(tr("requestCheckSaved"));
              await reloadDashboardCurrentPage(); await reloadCaseTimelinePage(selected.id);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : tr("requestCheckFailed"));
            } finally {
              setBusy(false);
            }
          };
          return selected.lines.map((line) => (
            <article className={styles.line} key={line.id} data-line-id={line.id} ref={focusedLineId === line.id ? focusedLineRef : undefined}><SharedCaseLineCard tr={tr} caseId={selected.id} casePhase={selected.phase} line={line} projections={projections}
              actions={{ canRecordReplenishment, canRetrieve: false, canReportLocation, canRequestCheck, busyId: busy ? selected.id : "",
                onSaved: async () => { setNotice(tr("replenishmentSaved")); await reloadDashboardCurrentPage(); await reloadCaseTimelinePage(selected.id); },
                onRetrieve: () => {},
                onRequestCheck: (lineId) => void requestCheck(lineId),
                reportForm: () => (<LocationReporter tr={tr} caseId={selected.id} lineId={line.id} onReported={async () => { setNotice(tr("reportLocationSaved")); await reloadDashboardCurrentPage(); await reloadCaseTimelinePage(selected.id); }} />) }} /></article>
          ));
          })() : <p>{tr("noItemsYet")}</p>}
          events={(selected.events || []) as CaseTimelineEvent[]}
          messages={selected.messages || []}
          formatTimestamp={(value) => formatDate(value, locale)}
          showTimeline={Boolean(selected.events?.length || selected.messages?.length)}
          timelinePagination={selected.eventsPagination && selected.eventsPagination.totalPages > 1 ? <PaginationControls tr={tr} variant="more" meta={selected.eventsPagination} loading={busy} onPage={(next) => void loadCase(selected.id, next)} /> : null}
          messageComposer={canMessage && selected.phase !== "CLOSED" && !selected.closedAt ? <form className={styles.messageForm} onSubmit={postMessage}><label><span>{tr("caseMessageLabel")}</span><textarea required maxLength={2000} rows={3} value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder={tr("caseMessagePlaceholder")} /></label><button type="submit" className={styles.primary} disabled={busy || !messageText.trim()}>{tr("sendCaseMessage")}</button></form> : null}
          afterTimeline={<div className={styles.caseActions}>
          {selected.phase !== "CLOSED" && !selected.closedAt && canChangePhase && <div className={styles.reopenAction}><label><span>{tr("orderStatusLabel")}</span><select value={selected.phase === "STAGED" ? "STAGED" : "PICKING"} disabled={busy} onChange={(event) => void changePhase(event.target.value as "PICKING" | "STAGED")}><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label></div>}
          {selected.phase !== "CLOSED" && !selected.closedAt && canClose && <div className={styles.closeAction}><label><span>{tr("administrativeResolutionOptional")}</span><input maxLength={300} minLength={5} value={adminResolution} onChange={(event) => setAdminResolution(event.target.value)} placeholder={tr("administrativeResolutionPlaceholder")} /><small>{tr("administrativeResolutionHint")}</small></label><button type="button" className={styles.secondary} disabled={busy} onClick={() => { if (window.confirm(tr("closeCaseConfirm"))) void mutateCase(`/api/cases/${selected.id}/close`, "POST", adminResolution.trim() ? { administrativeResolutionReason: adminResolution.trim() } : {}, "caseClosedNotice"); }}>{tr("closeCase")}</button></div>}
          {(selected.phase === "CLOSED" || selected.closedAt) && canReopen && <div className={styles.reopenAction}><label><span>{tr("reopenPhase")}</span><select value={reopenPhase} onChange={(event) => setReopenPhase(event.target.value as "PICKING" | "STAGED")}><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label><label><span>{tr("reopenResponsible")}</span><select required value={reopenResponsible} onChange={(event) => setReopenResponsible(event.target.value)}><option value="">{tr("selectWorker")}</option>{workers.filter((worker) => reopenPhase === "PICKING" ? worker.role === "PICKER" : worker.status === "ACTIVE").map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label><button type="button" className={styles.primary} disabled={busy || !reopenResponsible} onClick={() => void mutateCase(`/api/cases/${selected.id}/reopen`, "POST", { phase: reopenPhase, responsibleUserId: reopenResponsible, lineIds: selected.lines?.map((line) => line.id) || [] }, "caseReopenedNotice")}>{tr("reopenCase")}</button></div>}
          </div>}
        />
      </section>
    </div>}
  </main>;
}
