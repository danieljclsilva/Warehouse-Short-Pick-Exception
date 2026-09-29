"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { LiveRefreshStatus } from "@/components/live-refresh-status";
import { ScanInput } from "@/components/scan-input";
import { useLiveRefresh } from "@/components/use-live-refresh";
import styles from "./operations-dashboard.module.css";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { CaseTimeline, type CaseTimelineEvent } from "@/components/case-timeline";

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
  discoveredLocation?: string | null;
};
type CaseEvent = { id: string; eventType: string; createdAt: string; actorName?: string | null; payload?: Record<string, unknown>; completionCode?: string | null; discoveredLocation?: string | null; originalLocation?: string | null; taskId?: string | null };
type CaseMessage = { id: string; message: string; createdAt: string; authorName: string; shortPickLineId?: string | null };
type CaseSummary = {
  id: string;
  orderNumber: string;
  phase: string;
  createdAt: string;
  pickerName: string | null;
  missingCount: number;
  checkingCount: number;
  currentIssue: string;
  responsibleName: string | null;
  source: string;
  physicalState?: string;
  physicalLocation?: string | null;
  lines?: CaseLine[];
  lineProjections?: Array<{ displayStatus: string }>;
  projection?: { lines?: Array<{ displayStatus: string }> };
  events?: CaseEvent[];
  messages?: CaseMessage[];
  attentionLevel?: "NORMAL" | "WARNING" | "ATTENTION" | "CRITICAL";
  resolvedAt?: string | null;
  closedAt?: string | null;
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
type Worker = { id: string; displayName: string; role: string; status: string };
type DashboardResponse = { metrics?: Metrics; attentionThresholdMinutes?: number; thresholds?: { warning?: number; attention?: number; critical?: number }; cases?: CaseSummary[]; recentClosedCases?: ClosedCaseSummary[] };
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
};

type FilterPhase = "ALL" | "PICKING" | "STAGED";
type SortOrder = "OLDEST" | "NEWEST" | "ORDER";

const EMPTY_METRICS: Metrics = { openCases: 0, openShortPicks: 0, checking: 0, staged: 0, overThreshold: 0, resolvedToday: 0 };
const dateLocales: Record<string, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

async function readBody<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function formatAge(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(dateLocales[locale] || "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function lineStateLabel(state: string, tr: Translator) {
  const keys: Record<string, MessageKey> = {
    OPEN: "caseOpen",
    CHECKING: "caseChecking",
    FOUND: "caseFound",
    RETRIEVING: "retrievalPending",
    RESOLVED: "caseRetrieved",
    CANCELLED: "caseCancelled",
  };
  return tr(keys[state.toUpperCase()] ?? "caseOpen");
}

function retrievalStateLabel(state: string, tr: Translator) {
  const keys: Record<string, MessageKey> = {
    NOT_REQUIRED: "retrievalNotRequired",
    PENDING: "retrievalPending",
    FAILED: "retrievalFailed",
    RETRIEVED: "caseRetrieved",
  };
  return tr(keys[state.toUpperCase()] ?? "retrievalNotRequired");
}

function physicalStateLabel(state: string | undefined, tr: Translator) {
  const keys: Record<string, MessageKey> = {
    WITH_PICKER: "physicalWithPicker",
    SHORT_PICK_HOLD: "physicalShortPickHold",
    OTHER_KNOWN_LOCATION: "physicalOtherLocation",
    UNKNOWN: "physicalUnknown",
  };
  return tr(keys[state?.toUpperCase() ?? "UNKNOWN"] ?? "physicalUnknown");
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

export function OperationsDashboard({ tr, locale, canCreateManual, canMessage, canAssign, canClose, canReopen }: Props) {
  const dashboardRequestInFlight = useRef(false);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [attentionThresholdMinutes, setAttentionThresholdMinutes] = useState(15);
  const [thresholds, setThresholds] = useState({ warning: 5, attention: 10, critical: 15 });
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [recentClosedCases, setRecentClosedCases] = useState<ClosedCaseSummary[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<CaseSummary | null>(null);
  const [filterPhase, setFilterPhase] = useState<FilterPhase>("ALL");
  const [sortOrder, setSortOrder] = useState<SortOrder>("OLDEST");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [manualOrder, setManualOrder] = useState("");
  const [manualLocation, setManualLocation] = useState("");
  const [manualSku, setManualSku] = useState("");
  const [manualQuantity, setManualQuantity] = useState("1");
  const [manualPicker, setManualPicker] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [historicalCases, setHistoricalCases] = useState<HistoricalCase[]>([]);
  const [confirmHistory, setConfirmHistory] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [adminResolution, setAdminResolution] = useState("");
  const [reopenPhase, setReopenPhase] = useState<"PICKING" | "STAGED">("PICKING");
  const [reopenResponsible, setReopenResponsible] = useState("");
  const [clockNow, setClockNow] = useState<number | null>(null);

  const fetchDashboard = useCallback(async () => {
    if (dashboardRequestInFlight.current) return true;
    dashboardRequestInFlight.current = true;
    try {
      const response = await fetch("/api/operations/dashboard", { cache: "no-store" });
      const body = await readBody<DashboardResponse>(response);
      if (!response.ok) throw new Error(tr("operationsLoadFailed"));
      setMetrics({ ...EMPTY_METRICS, ...(body.metrics || {}) });
      if (body.thresholds) setThresholds((current) => ({ ...current, ...body.thresholds }));
      if (body.attentionThresholdMinutes && body.attentionThresholdMinutes > 0) setAttentionThresholdMinutes(body.attentionThresholdMinutes);
      setCases(body.cases || []);
      setRecentClosedCases(body.recentClosedCases || []);
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("operationsLoadFailed"));
      return false;
    } finally {
      dashboardRequestInFlight.current = false;
      setLoading(false);
    }
  }, [tr]);

  const selectedCaseId = selected?.id;
  const refreshLiveData = useCallback(async () => {
    if (!await fetchDashboard()) throw new Error("refresh failed");
    if (selectedCaseId) {
      const response = await fetch(`/api/cases/${encodeURIComponent(selectedCaseId)}`, { cache: "no-store" });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok || !body.case) throw new Error("refresh failed");
      setSelected((current) => current?.id === selectedCaseId ? body.case ?? current : current);
    }
  }, [fetchDashboard, selectedCaseId]);
  const liveState = useLiveRefresh(refreshLiveData);

  const fetchWorkers = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
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

  const visibleCases = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return cases
      .filter((item) => filterPhase === "ALL" || item.phase === filterPhase)
      .filter((item) => !normalized || [item.orderNumber, item.pickerName, item.responsibleName, item.currentIssue].some((value) => value?.toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => sortOrder === "NEWEST" ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : sortOrder === "ORDER" ? a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true }) : Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [cases, filterPhase, sortOrder, query]);

  const loadCase = async (caseId: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
      const body = await readBody<CaseResponse>(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setSelected(body.case);
      setReopenPhase(body.case.phase === "STAGED" ? "STAGED" : "PICKING");
      setReopenResponsible("");
      setMessageText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLoadError"));
    } finally {
      setBusy(false);
    }
  };

  const refreshSelected = async () => {
    await fetchDashboard();
    if (selected) await loadCase(selected.id);
  };

  const submitManual = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      orderNumber: manualOrder.trim(),
      firstLine: { location: manualLocation.trim(), sku: manualSku.trim(), quantity: Number(manualQuantity) },
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
      setManualOrder(""); setManualLocation(""); setManualSku(""); setManualQuantity("1"); setManualPicker(""); setManualReason(""); setHistoricalCases([]); setConfirmHistory(false);
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
      await loadCase(selected.id);
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
        <label><span>{tr("originalPickerOptional")}</span><select value={manualPicker} onChange={(event) => setManualPicker(event.target.value)}><option value="">{tr("noPickerSelected")}</option>{workers.filter((worker) => worker.role === "PICKER").map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label>
        <label className={styles.wide}><span>{tr("manualReasonOptional")}</span><textarea rows={2} maxLength={500} value={manualReason} onChange={(event) => setManualReason(event.target.value)} /></label>
        {historicalCases?.length ? <div className={styles.historyConfirm} role="alert"><strong>{tr("manualHistoricalCasesTitle")}</strong><ul>{historicalCases.map((item) => <li key={item.id}>{manualOrder} · {item.phase === "CLOSED" ? tr("caseClosed") : item.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")} · {formatDate(item.createdAt, locale)}</li>)}</ul><label className={styles.confirmCheck}><input type="checkbox" checked={confirmHistory} onChange={(event) => setConfirmHistory(event.target.checked)} /><span>{tr("manualHistoryAcknowledged")}</span></label></div> : null}
        <div className={`${styles.formActions} ${styles.wide}`}><button type="button" className={styles.secondary} onClick={() => { setShowManual(false); setConfirmHistory(false); setHistoricalCases([]); }}>{tr("cancel")}</button><button type="submit" className={styles.primary} disabled={busy || (Boolean(historicalCases?.length) && !confirmHistory)}>{busy ? tr("saving") : tr("saveManualCase")}</button></div>
      </form>
    </section>}
    <section className={styles.queue}>
      <div className={styles.queueHeader}><div><p className={styles.eyebrow}>{tr("liveOperations")}</p><h2>{tr("openCaseQueue")}</h2></div><span className={styles.count}>{visibleCases.length}</span></div>
      <div className={styles.filters}>
        <label className={styles.search}><span className={styles.srOnly}>{tr("searchCases")}</span><input type="search" placeholder={tr("searchCasesPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span className={styles.srOnly}>{tr("filterByPhase")}</span><select value={filterPhase} onChange={(event) => setFilterPhase(event.target.value as FilterPhase)}><option value="ALL">{tr("allPhases")}</option><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label>
        <label><span className={styles.srOnly}>{tr("sortCases")}</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}><option value="OLDEST">{tr("oldestFirst")}</option><option value="NEWEST">{tr("newestFirst")}</option><option value="ORDER">{tr("orderNumber")}</option></select></label>
      </div>
      {loading ? <p className={styles.empty}>{tr("loadingCases")}</p> : visibleCases.length ? <div className={styles.caseList}>
        {visibleCases.map((item) => {
          const age = clockNow === null ? 0 : Math.floor((clockNow - Date.parse(item.createdAt)) / 60_000);
          const fallbackLevel: NonNullable<CaseSummary["attentionLevel"]> = age >= thresholds.critical ? "CRITICAL" : age >= thresholds.attention ? "ATTENTION" : age >= thresholds.warning ? "WARNING" : "NORMAL";
          const level = item.attentionLevel ?? fallbackLevel;
          const attentionClass = level === "CRITICAL" ? styles.critical : level === "ATTENTION" ? styles.attention : level === "WARNING" ? styles.warning : "";
          const badgeClass = level === "CRITICAL" ? styles.attentionBadgeCritical : level === "ATTENTION" ? styles.attentionBadgeAttention : level === "WARNING" ? styles.attentionBadgeWarning : styles.attentionBadgeNormal;
          return <button type="button" className={`${styles.caseCard} ${attentionClass}`} key={item.id} onClick={() => void loadCase(item.id)}>
            <div className={styles.caseTop}><strong>{tr("orderLabel")} {item.orderNumber}</strong><span className={styles.caseBadges}><span className={styles.caseStatusBadge}><CaseStatusBadge status={item.lineProjections?.[0]?.displayStatus ?? item.projection?.lines?.[0]?.displayStatus ?? item.lines?.[0]?.state ?? item.currentIssue ?? item.phase} retrievalState={item.lines?.[0]?.retrievalState ?? null} tr={tr} /></span><span className={`${styles.attentionBadge} ${badgeClass}`} aria-label={`${tr("attentionLevelLabel")}: ${attentionLabel(level, tr)}`}>{attentionLabel(level, tr)}</span><span className={`${styles.phase} ${item.phase === "STAGED" ? styles.phaseStaged : ""}`}>{item.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}</span></span></div>
            <div className={styles.caseData}><span><b>{item.missingCount}</b> {tr("missingItemsLabel")}</span><span>{item.checkingCount} {tr("checkingLabel")}</span><span className={styles.age}>{formatAge(item.createdAt)}</span></div>
            <div className={styles.caseFoot}><span>{item.pickerName || tr("unknownPicker")}</span><span className={styles.issue}>{item.currentIssue ? tr(`issue_${item.currentIssue}` as MessageKey) : tr("caseNoCurrentIssue")}</span><span>{item.responsibleName || "—"}</span></div>
          </button>;
        })}
      </div> : <p className={styles.empty}>{tr("noOpenCases")}</p>}
    </section>
    <section className={styles.queue}>
      <div className={styles.queueHeader}><div><p className={styles.eyebrow}>{tr("caseClosed")}</p><h2>{tr("recentClosedCases")}</h2></div><span className={styles.count}>{recentClosedCases.length}</span></div>
      {recentClosedCases.length ? <div className={styles.caseList}>
        {recentClosedCases.map((item) => <button type="button" className={`${styles.caseCard} ${styles.closedCard}`} key={item.id} onClick={() => void loadCase(item.id)}>
          <div className={styles.caseTop}><strong>{tr("orderLabel")} {item.orderNumber}</strong><span className={`${styles.phase} ${styles.phaseClosed}`}>{tr("caseClosed")}</span></div>
          <div className={styles.caseData}><span>{tr("caseClosedOn", { date: formatDate(item.resolvedAt || item.createdAt, locale) })}</span></div>
          <div className={styles.caseFoot}><span>{item.pickerName || tr("unknownPicker")}</span><span>{item.responsibleName || "—"}</span></div>
        </button>)}
      </div> : <p className={styles.empty}>{tr("noRecentClosedCases")}</p>}
    </section>
    {selected && <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="case-drawer-title">
        <header className={styles.drawerHead}><div><p className={styles.eyebrow}>{tr("caseDetails")}</p><h2 id="case-drawer-title">{tr("orderLabel")} {selected.orderNumber}</h2></div><button className={styles.iconButton} type="button" aria-label={tr("closePanel")} onClick={() => setSelected(null)}>×</button></header>
        <p className={styles.caseStatusBadge}><CaseStatusBadge status={selected.phase === "CLOSED" ? "CLOSED" : (selected.lineProjections?.[0]?.displayStatus ?? selected.lines?.[0]?.state ?? selected.phase)} tr={tr} /></p>
        <p className={styles.drawerSummary}>{selected.phase === "CLOSED" ? `${tr("caseClosed")} · ${tr("caseClosedOn", { date: formatDate(selected.resolvedAt || selected.createdAt, locale) })}` : `${selected.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")} · ${formatAge(selected.createdAt)}`} · {selected.pickerName || tr("unknownPicker")}</p>
        <p className={styles.drawerPhysical}>{tr("physicalState", { state: physicalStateLabel(selected.physicalState, tr) })}{selected.physicalLocation ? ` · ${selected.physicalLocation}` : ""}</p>
        <div className={styles.detailGrid}><div><span>{tr("caseResponsible")}</span><strong>{selected.responsibleName || "—"}</strong></div><div><span>{tr("caseSource")}</span><strong>{tr(`source_${selected.source}` as MessageKey)}</strong></div><div><span>{tr("missingItemsLabel")}</span><strong>{selected.missingCount}</strong></div></div>
        <section className={styles.detailSection}><h3>{tr("reportedItems")}</h3>{selected.lines?.length ? <div className={styles.lineList}>{selected.lines.map((line) => <article className={styles.line} key={line.id}><div><strong>{line.location}</strong><span>{line.sku} ×{line.quantity}</span></div><span className={styles.caseStatusBadge}><CaseStatusBadge status={line.state} retrievalState={line.retrievalState ?? null} tr={tr} kind="line" /></span><span className={styles.lineState}>{lineStateLabel(line.state, tr)}{line.retrievalState ? ` · ${retrievalStateLabel(line.retrievalState, tr)}` : ""}</span>{line.discoveredLocation && <small>{tr("newLocation")}: {line.discoveredLocation}</small>}</article>)}</div> : <p>{tr("noItemsYet")}</p>}</section>
        {(selected.events?.length || selected.messages?.length) ? <section className={styles.detailSection}><h3>{tr("caseTimeline")}</h3><CaseTimeline events={(selected.events || []) as CaseTimelineEvent[]} messages={selected.messages || []} tr={tr} formatDate={(value) => formatDate(value, locale)} className={styles.timeline} /></section> : null}
        {canMessage && selected.phase !== "CLOSED" && !selected.closedAt && <form className={styles.messageForm} onSubmit={postMessage}><label><span>{tr("caseMessageLabel")}</span><textarea required maxLength={2000} rows={3} value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder={tr("caseMessagePlaceholder")} /></label><button type="submit" className={styles.primary} disabled={busy || !messageText.trim()}>{tr("sendCaseMessage")}</button></form>}
        <div className={styles.caseActions}>
          {selected.phase !== "CLOSED" && !selected.closedAt && canAssign && <div className={styles.reopenAction}><label><span>{tr("assignTroubleshooter")}</span><select required value={reopenResponsible} onChange={(event) => setReopenResponsible(event.target.value)}><option value="">{tr("selectWorker")}</option>{workers.filter((worker) => worker.role === "TROUBLESHOOTER").map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label><button type="button" className={styles.secondary} disabled={busy || !reopenResponsible} onClick={() => void mutateCase(`/api/cases/${selected.id}/responsibility`, "POST", { userId: reopenResponsible }, "caseResponsibilitySaved")}>{tr("assignTroubleshooter")}</button></div>}
          {selected.phase !== "CLOSED" && !selected.closedAt && canClose && <div className={styles.closeAction}><label><span>{tr("administrativeResolutionOptional")}</span><input maxLength={300} minLength={5} value={adminResolution} onChange={(event) => setAdminResolution(event.target.value)} placeholder={tr("administrativeResolutionPlaceholder")} /><small>{tr("administrativeResolutionHint")}</small></label><button type="button" className={styles.secondary} disabled={busy} onClick={() => { if (window.confirm(tr("closeCaseConfirm"))) void mutateCase(`/api/cases/${selected.id}/close`, "POST", adminResolution.trim() ? { administrativeResolutionReason: adminResolution.trim() } : {}, "caseClosedNotice"); }}>{tr("closeCase")}</button></div>}
          {(selected.phase === "CLOSED" || selected.closedAt) && canReopen && <div className={styles.reopenAction}><label><span>{tr("reopenPhase")}</span><select value={reopenPhase} onChange={(event) => setReopenPhase(event.target.value as "PICKING" | "STAGED")}><option value="PICKING">{tr("phasePicking")}</option><option value="STAGED">{tr("phaseStaged")}</option></select></label><label><span>{tr("reopenResponsible")}</span><select required value={reopenResponsible} onChange={(event) => setReopenResponsible(event.target.value)}><option value="">{tr("selectWorker")}</option>{workers.filter((worker) => reopenPhase === "PICKING" ? worker.role === "PICKER" : worker.status === "ACTIVE").map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label><button type="button" className={styles.primary} disabled={busy || !reopenResponsible} onClick={() => void mutateCase(`/api/cases/${selected.id}/reopen`, "POST", { phase: reopenPhase, responsibleUserId: reopenResponsible, lineIds: selected.lines?.map((line) => line.id) || [] }, "caseReopenedNotice")}>{tr("reopenCase")}</button></div>}
        </div>
      </section>
    </div>}
  </main>;
}
