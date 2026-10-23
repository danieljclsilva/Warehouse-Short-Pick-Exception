"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import { ScanInput } from "@/components/scan-input";
import { useLiveRefresh } from "@/components/use-live-refresh";
import type { CaseTimelineEvent, CaseTimelineMessage } from "@/components/case-timeline";
import type { WorkingHours } from "@/domain/working-hours";
import { CaseDetailView, CaseSummaryCard, formatCaseElapsedTime } from "@/components/case-detail-view";
import { ErrorLogPrompt, ErrorLogReminderStrip, type ErrorLogPromptEntry } from "@/components/error-log-reminders";
import { SharedCaseLineCard } from "@/components/case-line-card";
import { PaginationControls } from "@/components/pagination-controls";

type ShortPickLine = { id: string; location: string; sku: string; quantity: number; state: string; displayStatus?: string | null; discoveredLocation?: string | null; retrievalState?: string; retrievalResponsibleUserId?: string | null; replenishmentState?: string | null; replenishmentNote?: string | null };
type OrderCase = {
  id: string;
  orderNumber: string;
  phase: string;
  physicalState: string;
  createdAt: string;
  resolvedAt?: string | null;
  workingHours?: WorkingHours;
  pickingUserId?: string | null;
  currentCaseResponsibleUserId?: string | null;
  responsibleName?: string | null;
  responsibleIdentifier?: string | null;
  source?: string;
  missingCount?: number;
  lines: ShortPickLine[];
  lineProjections?: Array<{ lineId: string; displayStatus?: string; replenishment?: { state?: string; note?: string | null } }>;
  events?: CaseTimelineEvent[];
  eventsPagination?: { total: number; page: number; pageSize: number; totalPages: number } | null;
  messages?: CaseTimelineMessage[];
};
type OpenCaseTab = { id: string; orderNumber: string };
type PriorCase = { id: string; createdAt: string; phase: string };
type ApiError = { code?: string; error?: string; case?: OrderCase & { lines?: ShortPickLine[] }; history?: PriorCase[]; line?: ShortPickLine };

type PickerWorkflowProps = {
  userId: string;
  locale: Locale;
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  canReportShortPick: boolean;
  /** Enables tabs for switching between the picker’s open cases. */
  canViewOwnCases?: boolean;
  canOverrideDuplicateLine: boolean;
  canStage: boolean;
  canConfirmRetrieval: boolean;
  canClose: boolean;
  /** Explicit RECORD_REPLENISHMENT grant: normally false, but a granted picker gets the shared writer. */
  canRecordReplenishment?: boolean;
  canReportLocation?: boolean;
  canViewMessages?: boolean;
  canAddMessages?: boolean;
  focusedCaseId?: string | null;
  focusedLineId?: string | null;
  focusedNonce?: number;
  focusFromNotification?: boolean;
  onFocusConsumed?: () => void;
  onFocusedClose?: () => void;
};

function formatDate(value: string, locale: Locale) {
  const locales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };
  return new Intl.DateTimeFormat(locales[locale], { dateStyle: "medium" }).format(new Date(value));
}

function formatTimestamp(value: string, locale: Locale) {
  const locales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };
  return new Intl.DateTimeFormat(locales[locale], { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}


function phaseLabel(phase: string, tr: PickerWorkflowProps["tr"]) {
  const keys: Record<string, MessageKey> = { PICKING: "phasePicking", STAGED: "phaseStaged", CLOSED: "caseClosed" };
  return tr(keys[phase] ?? "caseOpen");
}

function physicalStateLabel(state: string, tr: PickerWorkflowProps["tr"]) {
  const keys: Record<string, MessageKey> = {
    WITH_PICKER: "physicalWithPicker", SHORT_PICK_HOLD: "physicalShortPickHold",
    OTHER_KNOWN_LOCATION: "physicalOtherLocation", UNKNOWN: "physicalUnknown",
  };
  return tr(keys[state] ?? "physicalUnknown");
}

async function readBody(response: Response) {
  return (await response.json().catch(() => ({}))) as ApiError & { kind?: string; normalizedOrderNumber?: string; history?: PriorCase[]; cases?: OpenCaseTab[]; case?: OrderCase; line?: ShortPickLine };
}
function withReplenishmentFolded(caseData: OrderCase): OrderCase {
  const entries = caseData.lineProjections ?? [];
  if (entries.length === 0) return caseData;
  const byLineId: Record<string, { displayStatus?: string; state?: string; note?: string | null } | undefined> = {};
  for (const entry of entries) byLineId[entry.lineId] = { displayStatus: entry.displayStatus, ...entry.replenishment };
  return {
    ...caseData,
    lines: (caseData.lines ?? []).map((line) => {
      const projected = byLineId[line.id];
      if (!projected) return line;
      return {
        ...line,
        displayStatus: projected.displayStatus ?? line.displayStatus,
        replenishmentState: projected.state ?? line.replenishmentState,
        replenishmentNote: projected.note ?? line.replenishmentNote ?? null,
      };
    }),
  };
}

function LocationReportForm({ tr, caseId, lineId, onReported }: {
  tr: PickerWorkflowProps["tr"];
  caseId: string;
  lineId: string;
  onReported: () => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const location = value.trim();
    if (!location || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/discovered-location`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: location.toUpperCase() }),
      });
      if (!response.ok) throw new Error(tr("reportLocationFailed" as MessageKey));
      setValue("");
      await onReported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("reportLocationFailed" as MessageKey));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="location-report-form" onSubmit={submit}>
      <label className="form-field">
        <span>{tr("reportLocationAction" as MessageKey)}</span>
        <ScanInput value={value} onChange={setValue} placeholder={tr("reportLocationPlaceholder" as MessageKey)} required tr={tr} scanKind="location" fieldLabel={tr("reportLocationAction" as MessageKey)} />
      </label>
      {error ? <p className="case-alert" role="alert">{error}</p> : null}
      <button type="submit" className="secondary-button" disabled={busy || !value.trim()}>
        {tr("reportLocationAction" as MessageKey)}
      </button>
    </form>
  );
}

export function PickerWorkflow({ locale, tr, userId, canReportShortPick, canViewOwnCases = false, canOverrideDuplicateLine, canStage, canConfirmRetrieval, canClose, canRecordReplenishment = false, canReportLocation = false, canViewMessages = false, canAddMessages = false, focusedCaseId, focusedLineId = null, focusedNonce, focusFromNotification, onFocusConsumed, onFocusedClose }: PickerWorkflowProps) {
  const [timelinePages, setTimelinePages] = useState<Record<string, number>>({});
  const [openCaseTabs, setOpenCaseTabs] = useState<OpenCaseTab[]>([]);
  const [openCasesLoading, setOpenCasesLoading] = useState(canViewOwnCases);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [activeCase, setActiveCase] = useState<OrderCase | null>(null);
  const [pendingOrder, setPendingOrder] = useState("");
  const [confirmedHistoricalCaseIds, setConfirmedHistoricalCaseIds] = useState<string[]>([]);
  const [history, setHistory] = useState<PriorCase[]>([]);
  const [normalizedOrder, setNormalizedOrder] = useState("");
  const [historyDraftOrder, setHistoryDraftOrder] = useState("");
  const [showLineForm, setShowLineForm] = useState(false);
  const [location, setLocation] = useState("");
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [duplicateLine, setDuplicateLine] = useState<ShortPickLine | null>(null);
  const [stageConfirm, setStageConfirm] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [caseMessage, setCaseMessage] = useState("");
  const [errorLogPrompt, setErrorLogPrompt] = useState<ErrorLogPromptEntry | null>(null);
  // Success confirmations dismiss themselves; errors stay until the next action.
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

  const activeCaseId = activeCase?.id;
  const fetchOpenCaseTabs = useCallback(async () => {
    const response = await fetch("/api/picker/cases?page=1&pageSize=100", { credentials: "same-origin", cache: "no-store" });
    const body = await readBody(response);
    if (!response.ok) throw new Error(tr("caseLoadError"));
    return (body.cases || []).map(({ id, orderNumber }) => ({ id, orderNumber }));
  }, [tr]);
  const loadOpenCaseTabs = useCallback(async () => {
    if (!canViewOwnCases) return;
    try {
      setOpenCaseTabs(await fetchOpenCaseTabs());
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("caseLoadError")); }
    finally { setOpenCasesLoading(false); }
  }, [canViewOwnCases, fetchOpenCaseTabs, tr]);
  useEffect(() => {
    if (!canViewOwnCases) return;
    let cancelled = false;
    fetchOpenCaseTabs()
      .then((tabs) => { if (!cancelled) setOpenCaseTabs(tabs); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("caseLoadError")); })
      .finally(() => { if (!cancelled) setOpenCasesLoading(false); });
    return () => { cancelled = true; };
  }, [canViewOwnCases, fetchOpenCaseTabs, tr]);
  const refreshLiveData = useCallback(async () => {
    if (activeCaseId) {
      const timelinePage = timelinePages[activeCaseId] ?? 1;
      const response = await fetch(`/api/cases/${encodeURIComponent(activeCaseId)}?page=${timelinePage}&pageSize=50`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setActiveCase(withReplenishmentFolded(body.case));
    }
  }, [activeCaseId, timelinePages, tr]);
  useLiveRefresh(refreshLiveData, 5_000, Boolean(activeCase));
  const prepareCase = (number: string, historicalIds: string[], preserveDraft = false) => {
    if (!preserveDraft) { setLocation(""); setSku(""); setQuantity(1); }
    setPendingOrder(number);
    setConfirmedHistoricalCaseIds(historicalIds);
    setHistory([]);
    setHistoryDraftOrder("");
    setShowLineForm(true);
    setDuplicateLine(null);
  };

  const openCase = useCallback(async (id: string, timelinePage = 1) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(id)}?page=${timelinePage}&pageSize=50`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setTimelinePages((current) => ({ ...current, [id]: timelinePage }));
      setActiveCase(withReplenishmentFolded(body.case));
      setCaseMessage("");
      await loadOpenCaseTabs();
      setHistory([]);
      setShowLineForm(false);
      setStageConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLoadError"));
    } finally {
      setBusy(false);
    }
  }, [loadOpenCaseTabs, tr]);
  const focusConsumedRef = useRef(0);
  const [focusOverlayNonce, setFocusOverlayNonce] = useState(0);
  const focusedLineRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusedCaseId || !focusedNonce || focusConsumedRef.current === focusedNonce) return;
    focusConsumedRef.current = focusedNonce;
    queueMicrotask(() => { if (focusFromNotification) setFocusOverlayNonce(focusedNonce); });
    void openCase(focusedCaseId).finally(() => { onFocusConsumed?.(); });
  }, [focusedCaseId, focusedNonce, focusFromNotification, onFocusConsumed, openCase]);
  useEffect(() => {
    if (!focusedLineId || !activeCase || activeCase.id !== focusedCaseId) return;
    focusedLineRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedLineId, focusedCaseId, activeCase]);
  const focusOverlay = focusOverlayNonce !== 0;
  const stageOrder = async () => {
    if (!activeCase) return;
    setBusy(true); setError(""); setActionNotice("");
    try {
      const response = await fetch(`/api/cases/${activeCase.id}/stage`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedPhysicalPlacement: true }) });
      if (!response.ok) throw new Error(tr("checkActionFailed"));
      await openCase(activeCase.id);
      setActionNotice(tr("stagingSuccess"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("checkActionFailed")); }
    finally { setBusy(false); setStageConfirm(false); }
  };

  const confirmLineRetrieval = async (lineId: string, result: "RETRIEVED" | "FAILED") => {
    if (!activeCase) return;
    setBusy(true); setError(""); setActionNotice("");
    try {
      const response = await fetch(`/api/cases/${activeCase.id}/lines/${lineId}/retrieve`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result }) });
      if (!response.ok) throw new Error(tr("checkActionFailed"));
      await openCase(activeCase.id);
      setActionNotice(tr("checkActionSaved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("checkActionFailed")); }
    finally { setBusy(false); }
  };

  const closeResolvedCase = async () => {
    if (!activeCase) return;
    setBusy(true); setError(""); setActionNotice("");
    try {
      const response = await fetch(`/api/cases/${activeCase.id}/close`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(tr("caseActionFailed"));
      await openCase(activeCase.id);
      await loadOpenCaseTabs();
      setActionNotice(tr("caseClosedNotice"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("caseActionFailed")); }
    finally { setBusy(false); }
  };

  const submitCaseMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = caseMessage.trim();
    if (!activeCase || !message || busy || !canAddMessages) return;
    setBusy(true); setError(""); setActionNotice("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(activeCase.id)}/messages`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(tr("caseActionFailed"));
      setCaseMessage("");
      await openCase(activeCase.id, timelinePages[activeCase.id] ?? 1);
      setActionNotice(tr("caseMessageSent"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("caseActionFailed")); }
    finally { setBusy(false); }
  };

  const submitOrder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = orderNumber.trim();
    if (!/^\d+$/.test(normalized)) {
      setError(tr("orderDigitsOnly"));
      return;
    }
    setBusy(true);
    setError("");
    setActionNotice("");
    setHistory([]);
    setHistoryDraftOrder("");
    try {
      const response = await fetch("/api/cases/lookup", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber: normalized }),
      });
      const body = await readBody(response);
      if (!response.ok) throw new Error(tr("caseLookupError"));
      if (body.kind === "OPEN" && body.case) {
        setActiveCase(withReplenishmentFolded(body.case));
        await loadOpenCaseTabs();
        setPendingOrder("");
        setOrderNumber("");
        setLocation(""); setSku(""); setQuantity(1);
      } else if (body.kind === "HISTORY") {
        setNormalizedOrder(body.normalizedOrderNumber || normalized);
        setHistory(body.history || []);
      } else {
        prepareCase(body.normalizedOrderNumber || normalized, []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLookupError"));
    } finally {
      setBusy(false);
    }
  };

  const createCase = async () => {
    const response = await fetch("/api/cases", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: pendingOrder, confirmedHistoricalCaseIds, firstLine: { location, sku, quantity } }),
    });
    const body = await readBody(response);
    if (response.status === 409 && body.code === "OPEN_CASE_EXISTS" && body.case) {
      setActiveCase(body.case);
      await loadOpenCaseTabs();
      setPendingOrder("");
      setHistory([]);
      setShowLineForm(true);
      return;
    }
    if (response.status === 409 && body.code === "HISTORICAL_CONFIRMATION_REQUIRED") {
      setNormalizedOrder(pendingOrder);
      setHistory(body.history || []);
      setHistoryDraftOrder(pendingOrder);
      setPendingOrder("");
      return;
    }
    if (!response.ok || !body.case) throw new Error(tr("caseCreateError"));
    setActiveCase(body.case);
    setErrorLogPrompt({ caseId: body.case.id, orderNumber: body.case.orderNumber, items: [{ location: location.trim().toUpperCase(), sku: sku.trim().toUpperCase() }] });
    await loadOpenCaseTabs();
    setPendingOrder("");
    setOrderNumber("");
    setHistory([]);
    setHistoryDraftOrder("");
    setLocation("");
    setSku("");
    setQuantity(1);
    setShowLineForm(false);
  };

  const addLine = async (confirmDuplicate: boolean) => {
    if ((!activeCase && !pendingOrder) || !location.trim() || !sku.trim() || !Number.isInteger(quantity) || quantity < 1) {
      setError(tr("lineFieldsRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setActionNotice("");
    try {
      if (pendingOrder) { await createCase(); return; }
      if (!activeCase) return;
      const response = await fetch(`/api/cases/${encodeURIComponent(activeCase.id)}/lines`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: location.trim().toUpperCase(), sku: sku.trim().toUpperCase(), quantity, confirmDuplicate: confirmDuplicate && canOverrideDuplicateLine }),
      });
      const body = await readBody(response);
      if (response.status === 409 && body.code === "DUPLICATE_LINE" && body.line) {
        setDuplicateLine(body.line);
        return;
      }
      if (!response.ok) throw new Error(tr("lineCreateError"));
      setErrorLogPrompt({ caseId: activeCase.id, orderNumber: activeCase.orderNumber, items: [{ location: location.trim().toUpperCase(), sku: sku.trim().toUpperCase() }] });
      setDuplicateLine(null);
      setLocation("");
      setSku("");
      setQuantity(1);
      setShowLineForm(false);
      await openCase(activeCase.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr(pendingOrder ? "caseCreateError" : "lineCreateError"));
    } finally {
      setBusy(false);
    }
  };

  const closeDetail = () => {
    const wasFocused = focusOverlay && activeCase !== null;
    setActiveCase(null);
    setPendingOrder("");
    setConfirmedHistoricalCaseIds([]);
    setHistory([]);
    setHistoryDraftOrder("");
    setShowLineForm(false);
    setDuplicateLine(null);
    setLocation("");
    setSku("");
    setQuantity(1);
    setError("");
    setActionNotice("");
    setFocusOverlayNonce(0);
    if (wasFocused) onFocusedClose?.();
  };

  const displayCase: OrderCase | null = activeCase ?? (pendingOrder
    ? { id: "", orderNumber: pendingOrder, phase: "PICKING", physicalState: "WITH_PICKER", createdAt: "", lines: [] }
    : null);

  return (
    <div className="picker-workflow">
      <ErrorLogReminderStrip tr={tr} />
      <ErrorLogPrompt tr={tr} entry={errorLogPrompt} onDone={() => setErrorLogPrompt(null)} />
      {error && <p className="case-alert" role="alert">{error}</p>}
      {actionNotice && <p className="check-notice" role="status">{actionNotice}</p>}
      {canReportShortPick && <section className="order-lookup-panel" aria-labelledby="report-short-pick-title">
        <div className="content-heading picker-heading"><div><p className="case-eyebrow">{tr("pickerWorkspace")}</p><h1 id="report-short-pick-title">{tr("reportShortPick")}</h1><p>{tr("reportShortPickDescription")}</p></div></div>
        <form className="order-lookup-form" onSubmit={submitOrder}>
          <label className="form-field"><span>{tr("orderNumber")}</span><ScanInput type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={orderNumber} onChange={setOrderNumber} placeholder={tr("orderNumberPlaceholder")} required tr={tr} scanKind="order" fieldLabel={tr("orderNumber")} /></label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("checkingOrder") : tr("findOrder")}</button>
        </form>
        {history.length > 0 && <section className="history-warning" aria-labelledby="history-warning-title">
          <p className="warning-eyebrow">{tr("orderSeenBefore")}</p><h2 id="history-warning-title">{normalizedOrder}</h2><p>{tr("historicalCaseDescription")}</p>
          <ul>{history.map((item) => <li key={item.id}><time dateTime={item.createdAt}>{formatDate(item.createdAt, locale)}</time><span>{tr("casePhase", { phase: phaseLabel(item.phase, tr) })}</span></li>)}</ul>
          <div className="warning-actions"><button type="button" className="secondary-button" onClick={() => { setHistory([]); setHistoryDraftOrder(""); setOrderNumber(""); setLocation(""); setSku(""); setQuantity(1); }} disabled={busy}>{tr("cancel")}</button><button type="button" className="primary-button" onClick={() => prepareCase(normalizedOrder, history.map((item) => item.id), historyDraftOrder === normalizedOrder)} disabled={busy}>{tr("createNewCase")}</button></div>
        </section>}
      </section>}
      {canViewOwnCases && <section className="picker-open-cases" aria-labelledby="my-open-cases-title">
        <div className="invite-list-heading"><h2 id="my-open-cases-title">{tr("myOpenCases")}</h2><button className="refresh-cases-button" type="button" onClick={() => void loadOpenCaseTabs()} disabled={openCasesLoading}>{tr("refresh")}</button></div>
        {openCasesLoading ? <p className="case-list-empty" aria-live="polite">{tr("loadingCases")}</p> : openCaseTabs.length ? <div className="case-order-tabs" role="group" aria-label={tr("myOpenCases")}>
          {openCaseTabs.map((item) => <button key={item.id} type="button" aria-current={item.id === activeCase?.id ? "page" : undefined} className={`case-order-tab${item.id === activeCase?.id ? " case-order-tab-active" : ""}`} onClick={() => item.id !== activeCase?.id && void openCase(item.id)} disabled={busy}>{item.orderNumber}</button>)}
        </div> : <p className="case-list-empty">{tr("noActiveCases")}</p>}
      </section>}
      {displayCase ? (
        <CaseDetailView
          className={`case-detail${focusOverlay ? " case-notification-overlay" : ""}`}
          titleId="case-detail-title"
          tr={tr}
          orderNumber={displayCase.orderNumber}
          errorLog={displayCase.id ? { caseId: displayCase.id, items: displayCase.lines.map((line) => ({ location: line.location, sku: line.sku })) } : undefined}
          phaseLabel={tr("casePhase", { phase: phaseLabel(displayCase.phase, tr) })}
          summary={<>
            <p className="case-physical-state">{tr("physicalState", { state: physicalStateLabel(displayCase.physicalState, tr) })}</p>
            {displayCase.id ? <CaseSummaryCard tr={tr} responsibleName={displayCase.responsibleName} responsibleIdentifier={displayCase.responsibleIdentifier} source={displayCase.source} missingCount={displayCase.missingCount} elapsedTime={formatCaseElapsedTime(displayCase.createdAt, displayCase.resolvedAt ?? null, displayCase.workingHours)} /> : null}
          </>}
          linesClassName="check-detail-lines"
          lines={displayCase.lines.length === 0 ? <p className="case-empty-lines">{tr("noItemsYet")}</p> : displayCase.lines.map((line) => {
              const canRetrieveLine = canConfirmRetrieval && !["RESOLVED", "CANCELLED"].includes(line.state)
                && (line.state === "FOUND" || line.replenishmentState === "COMPLETED")
                && line.retrievalResponsibleUserId === userId && ["PENDING", "FAILED"].includes(line.retrievalState || "");
              const canReportLocationLine = canReportLocation && activeCase && activeCase.phase !== "CLOSED" && !["RESOLVED", "CANCELLED"].includes(line.state);
              return <span key={line.id} data-line-id={line.id} ref={focusedLineId === line.id ? focusedLineRef : undefined} className="picker-detail-line-anchor"><SharedCaseLineCard
                tr={tr}
                caseId={displayCase.id}
                casePhase={displayCase.phase}
                line={line}
                projections={new Map()}
                showRetrievalNotRequired={false}
                retrievalPrompt={canRetrieveLine ? <p className="picker-retrieval-prompt" role="status">{tr("pickerRetrievalPrompt" as MessageKey, { location: line.discoveredLocation || line.location })}</p> : null}
                actions={{
                  canRecordReplenishment,
                  canRetrieve: canRetrieveLine,
                  canReportLocation: Boolean(canReportLocationLine),
                  busyId: busy ? activeCase?.id ?? "busy" : "",
                  onSaved: async () => { if (activeCase) await openCase(activeCase.id, timelinePages[activeCase.id] ?? 1); },
                  onRetrieve: (_lineId, result) => void confirmLineRetrieval(line.id, result),
                  reportForm: (lineId) => canReportLocationLine && activeCase ? <LocationReportForm tr={tr} caseId={activeCase.id} lineId={lineId} onReported={async () => { await openCase(activeCase.id); setActionNotice(tr("reportLocationSaved" as MessageKey)); }} /> : null,
                }}
              /></span>;
            })}
          afterLines={canReportShortPick && displayCase.phase === "PICKING" && (!displayCase.id || displayCase.pickingUserId === userId) && (!showLineForm ? <button className="primary-button add-line-button" type="button" onClick={() => { setShowLineForm(true); setDuplicateLine(null); }}>{tr("addMissingItem")}</button> : (
            <form className="add-line-panel" onSubmit={(event) => { event.preventDefault(); void addLine(false); }}>
              <div className="add-line-heading"><h3>{tr("addMissingItem")}</h3><button className="text-button" type="button" onClick={() => { if (pendingOrder) closeDetail(); else { setShowLineForm(false); setDuplicateLine(null); } }}>{tr("cancel")}</button></div>
              <label className="form-field"><span>{tr("location")}</span><ScanInput autoComplete="off" autoCapitalize="characters" value={location} onChange={(value) => { setLocation(value); setDuplicateLine(null); }} onScannedExtra={() => setDuplicateLine(null)} required tr={tr} scanKind="location" fieldLabel={tr("location")} /></label>
              <label className="form-field"><span>{tr("sku")}</span><ScanInput autoComplete="off" autoCapitalize="characters" value={sku} onChange={(value) => { setSku(value); setDuplicateLine(null); }} onScannedExtra={() => setDuplicateLine(null)} required tr={tr} scanKind="sku" fieldLabel={tr("sku")} /></label>
              <div className="quantity-field"><span>{tr("missingQuantity")}</span><div className="quantity-control">
                <button type="button" aria-label={tr("decreaseQuantity")} onClick={() => { setQuantity((value) => Math.max(1, value - 1)); setDuplicateLine(null); }} disabled={quantity <= 1}>−</button>
                <input type="number" inputMode="numeric" min={1} step={1} value={quantity} onChange={(event) => { setQuantity(Math.max(1, Number(event.target.value) || 1)); setDuplicateLine(null); }} aria-label={tr("missingQuantity")} />
                <button type="button" aria-label={tr("increaseQuantity")} onClick={() => { setQuantity((value) => value + 1); setDuplicateLine(null); }}>+</button>
              </div></div>
              {duplicateLine && <div className="duplicate-warning" role="alert"><strong>{tr("duplicateLineTitle")}</strong><p>{tr("duplicateLineDescription")}</p><div className="duplicate-line-match">{duplicateLine.location} · {duplicateLine.sku}<span>{tr("missingQuantityValue", { quantity: String(duplicateLine.quantity) })}</span></div><div className="warning-actions"><button type="button" className="secondary-button" onClick={() => setDuplicateLine(null)}>{tr("cancel")}</button>{canOverrideDuplicateLine && <button type="button" className="primary-button" onClick={() => void addLine(true)} disabled={busy}>{tr("confirmDuplicateLine")}</button>}</div>{!canOverrideDuplicateLine && <p className="duplicate-override-note">{tr("duplicateLineCannotOverride")}</p>}</div>}
              {!duplicateLine && <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("savingLine") : tr("saveMissingItem")}</button>}
            </form>
          ))}
          events={displayCase.events ?? []}
          messages={canViewMessages ? activeCase?.messages ?? [] : []}
          formatTimestamp={(value) => formatTimestamp(value, locale)}
          showTimeline={Boolean(displayCase.id && (displayCase.events?.length || (canViewMessages && activeCase?.messages?.length) || (canAddMessages && activeCase && activeCase.phase !== "CLOSED")))}
          timelinePagination={activeCase && activeCase.eventsPagination && activeCase.eventsPagination.totalPages > 1 ? <PaginationControls tr={tr} variant="more" meta={activeCase.eventsPagination} loading={busy} onPage={(next) => void openCase(activeCase.id, next)} /> : null}
          messageComposer={activeCase && canAddMessages && activeCase.phase !== "CLOSED" ? <form className="case-message-form" onSubmit={submitCaseMessage}>
              <label className="form-field"><span>{tr("caseMessageLabel")}</span><textarea value={caseMessage} onChange={(event) => setCaseMessage(event.target.value)} placeholder={tr("caseMessagePlaceholder")} maxLength={2000} rows={3} required /></label>
              <button className="primary-button" type="submit" disabled={busy || !caseMessage.trim()}>{tr("sendCaseMessage")}</button>
            </form> : null}
          afterTimeline={<>
            {activeCase && canStage && activeCase.phase === "PICKING" && <div className="case-stage-panel">{stageConfirm ? <><p>{tr("stagingConfirm")}</p><div className="case-stage-actions"><button className="secondary-button" type="button" onClick={() => setStageConfirm(false)} disabled={busy}>{tr("cancel")}</button><button className="primary-button" type="button" onClick={() => void stageOrder()} disabled={busy}>{tr("stagingConfirmButton")}</button></div></> : <button className="secondary-button" type="button" onClick={() => setStageConfirm(true)} disabled={busy}>{tr("stagingAction")}</button>}</div>}
            {activeCase && canClose && activeCase.phase !== "CLOSED" && activeCase.lines.length > 0 && activeCase.lines.every((line) => ["RESOLVED", "CANCELLED"].includes(line.state)) && <button className="secondary-button case-close-button" type="button" disabled={busy} onClick={() => void closeResolvedCase()}>{tr("closeCase")}</button>}
          </>}
        />
      ) : null}
    </div>
  );
}
