"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import { LiveRefreshStatus } from "@/components/live-refresh-status";
import { ScanInput } from "@/components/scan-input";
import { useLiveRefresh } from "@/components/use-live-refresh";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { CaseTimeline, type CaseTimelineEvent, type CaseTimelineMessage } from "@/components/case-timeline";

type ShortPickLine = { id: string; location: string; sku: string; quantity: number; state: string; discoveredLocation?: string | null; retrievalState?: string; retrievalResponsibleUserId?: string | null; replenishmentState?: string | null; replenishmentNote?: string | null };
type OrderCase = {
  id: string;
  orderNumber: string;
  phase: string;
  physicalState: string;
  createdAt: string;
  lines: ShortPickLine[];
  lineProjections?: Array<{ lineId: string; replenishment?: { state?: string; note?: string | null } }>;
  events?: CaseTimelineEvent[];
  messages?: CaseTimelineMessage[];
};
type CaseSummary = Omit<OrderCase, "lines"> & { lines?: ShortPickLine[]; missingCount?: number; foundCount?: number; checkingCount?: number };
type PriorCase = { id: string; createdAt: string; phase: string };
type ApiError = { code?: string; error?: string; case?: OrderCase & { lines?: ShortPickLine[] }; history?: PriorCase[]; line?: ShortPickLine };

type PickerWorkflowProps = {
  userId: string;
  locale: Locale;
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  canReportShortPick: boolean;
  canViewOwnCases: boolean;
  canOverrideDuplicateLine: boolean;
  canStage: boolean;
  canConfirmRetrieval: boolean;
  canClose: boolean;
  /** Legacy: pickers never record replenishment; retained for caller compat, ignored. */
  canRecordReplenishment?: boolean;
  canReportLocation?: boolean;
  focusedCaseId?: string | null;
  focusedNonce?: number;
  focusFromNotification?: boolean;
  onFocusConsumed?: () => void;
  onFocusedClose?: () => void;
};

function formatDate(value: string, locale: Locale) {
  const locales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };
  return new Intl.DateTimeFormat(locales[locale], { dateStyle: "medium" }).format(new Date(value));
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
  return (await response.json().catch(() => ({}))) as ApiError & { kind?: string; normalizedOrderNumber?: string; history?: PriorCase[]; cases?: CaseSummary[]; case?: OrderCase; line?: ShortPickLine };
}
function withReplenishmentFolded(caseData: OrderCase): OrderCase {
  const entries = (caseData.lineProjections ?? []) as Array<{ lineId: string; replenishment?: { state?: string; note?: string | null } }>;
  if (entries.length === 0) return caseData;
  const byLineId: Record<string, { state?: string; note?: string | null } | undefined> = {};
  for (const entry of entries) byLineId[entry.lineId] = entry.replenishment;
  return {
    ...caseData,
    lines: (caseData.lines ?? []).map((line) => {
      const projected = byLineId[line.id];
      if (!projected?.state) return line;
      return { ...line, replenishmentState: projected.state, replenishmentNote: projected.note ?? line.replenishmentNote ?? null };
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

export function PickerWorkflow({ locale, tr, userId, canReportShortPick, canViewOwnCases, canOverrideDuplicateLine, canStage, canConfirmRetrieval, canClose, canReportLocation = false, focusedCaseId, focusedNonce, focusFromNotification, onFocusConsumed, onFocusedClose }: PickerWorkflowProps) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(canViewOwnCases);
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
  // Success confirmations dismiss themselves; errors stay until the next action.
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

  const loadCases = useCallback(async () => {
    if (!canViewOwnCases) { setCases([]); setLoading(false); return; }
    try {
      const response = await fetch("/api/picker/cases", { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok) throw new Error(tr("caseLoadError"));
      setCases(body.cases || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLoadError"));
    } finally {
      setLoading(false);
    }
  }, [canViewOwnCases, tr]);

  const activeCaseId = activeCase?.id;
  const refreshLiveData = useCallback(async () => {
    if (canViewOwnCases) {
      const response = await fetch("/api/picker/cases", { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok) throw new Error(tr("caseLoadError"));
      setCases(body.cases || []);
      setLoading(false);
    }
    if (activeCaseId) {
      const response = await fetch(`/api/cases/${encodeURIComponent(activeCaseId)}`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setActiveCase(withReplenishmentFolded(body.case));
    }
  }, [activeCaseId, canViewOwnCases, tr]);
  const liveState = useLiveRefresh(refreshLiveData, 5_000, canViewOwnCases || Boolean(activeCase));

  const prepareCase = (number: string, historicalIds: string[], preserveDraft = false) => {
    if (!preserveDraft) { setLocation(""); setSku(""); setQuantity(1); }
    setPendingOrder(number);
    setConfirmedHistoricalCaseIds(historicalIds);
    setHistory([]);
    setHistoryDraftOrder("");
    setShowLineForm(true);
    setDuplicateLine(null);
  };

  const openCase = useCallback(async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setActiveCase(withReplenishmentFolded(body.case));
      setHistory([]);
      setShowLineForm(false);
      setStageConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("caseLoadError"));
    } finally {
      setBusy(false);
    }
  }, [tr]);
  const focusConsumedRef = useRef(0);
  const [focusOverlayNonce, setFocusOverlayNonce] = useState(0);
  useEffect(() => {
    if (!focusedCaseId || !focusedNonce || focusConsumedRef.current === focusedNonce) return;
    focusConsumedRef.current = focusedNonce;
    queueMicrotask(() => { if (focusFromNotification) setFocusOverlayNonce(focusedNonce); });
    void openCase(focusedCaseId).finally(() => { onFocusConsumed?.(); });
  }, [focusedCaseId, focusedNonce, focusFromNotification, onFocusConsumed, openCase]);
  const focusOverlay = focusOverlayNonce !== 0;
  const detailRef = useRef<HTMLElement | null>(null);
  const openedCaseKey = useRef<string | null>(null);

  const stageOrder = async () => {
    if (!activeCase) return;
    setBusy(true); setError(""); setActionNotice("");
    try {
      const response = await fetch(`/api/cases/${activeCase.id}/stage`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedPhysicalPlacement: true }) });
      if (!response.ok) throw new Error(tr("checkActionFailed"));
      await openCase(activeCase.id);
      await loadCases();
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
      await loadCases();
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
      await loadCases();
      setActionNotice(tr("caseClosedNotice"));
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
        setPendingOrder("");
        setLocation(""); setSku(""); setQuantity(1);
        await loadCases();
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
      setPendingOrder("");
      setHistory([]);
      setShowLineForm(true);
      await loadCases();
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
    setPendingOrder("");
    setOrderNumber("");
    setHistory([]);
    setHistoryDraftOrder("");
    setLocation("");
    setSku("");
    setQuantity(1);
    setShowLineForm(false);
    await loadCases();
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
      setDuplicateLine(null);
      setLocation("");
      setSku("");
      setQuantity(1);
      setShowLineForm(false);
      await openCase(activeCase.id);
      await loadCases();
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
    else void loadCases();
  };

  const displayCase: OrderCase | null = activeCase ?? (pendingOrder
    ? { id: "", orderNumber: pendingOrder, phase: "PICKING", physicalState: "WITH_PICKER", createdAt: "", lines: [] }
    : null);
  const displayCaseKey = activeCase ? activeCase.id : pendingOrder ? `pending:${pendingOrder}` : null;
  useEffect(() => {
    if (!displayCaseKey || openedCaseKey.current === displayCaseKey) return;
    openedCaseKey.current = displayCaseKey;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    detailRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    detailRef.current?.focus({ preventScroll: true });
  }, [displayCaseKey]);
  useEffect(() => { if (!displayCaseKey) openedCaseKey.current = null; }, [displayCaseKey]);

  return (
    <div className="picker-workflow">
      {error && <p className="case-alert" role="alert">{error}</p>}
      {actionNotice && <p className="check-notice" role="status">{actionNotice}</p>}
      {displayCase ? (
        <section ref={detailRef} tabIndex={-1} className={`case-detail${focusOverlay ? " case-notification-overlay" : ""}`} aria-labelledby="case-detail-title">
          <button className="case-back-button" type="button" onClick={closeDetail} disabled={busy}>‹ {tr("backToMyOrders")}</button>
          <div className="case-detail-heading">
            <div><p className="case-eyebrow">{tr("orderLabel")}</p><h2 id="case-detail-title">{displayCase.orderNumber}</h2></div>
            <span className="case-badges"><span className="case-phase">{tr("casePhase", { phase: phaseLabel(displayCase.phase, tr) })}</span><CaseStatusBadge status={displayCase.phase === "CLOSED" ? "CLOSED" : (displayCase.lines[0]?.state ?? displayCase.phase)} retrievalState={displayCase.lines[0]?.retrievalState ?? null} tr={tr} /></span>
          </div>
          <p className="case-physical-state">{tr("physicalState", { state: physicalStateLabel(displayCase.physicalState, tr) })}</p>
          <div className="case-line-list" aria-label={tr("reportedItems")}>
            {displayCase.lines.length === 0 ? <p className="case-empty-lines">{tr("noItemsYet")}</p> : displayCase.lines.map((line) => {
              const awaitingRetrieval = canConfirmRetrieval && line.state === "FOUND" && line.retrievalResponsibleUserId === userId && ["PENDING", "FAILED"].includes(line.retrievalState || "");
              return (
              <article className="case-line" key={line.id}>
                <div className="case-line-primary"><strong>{line.location}</strong><span>{line.sku} ×{line.quantity}</span></div>
                <span className="case-badges"><CaseStatusBadge status={line.state} retrievalState={line.retrievalState ?? null} tr={tr} kind="line" /></span>
                {line.discoveredLocation && <p className="case-discovered-location">{tr("newLocation")}: <strong>{line.discoveredLocation}</strong></p>}
                {line.replenishmentState && line.replenishmentState !== "NONE" ? <p className="replenishment-badge" data-state={line.replenishmentState}>{tr(`replenishmentState${line.replenishmentState}` as MessageKey)}</p> : null}
                {awaitingRetrieval && <p className="picker-retrieval-prompt" role="status">{tr("pickerRetrievalPrompt" as MessageKey, { location: line.discoveredLocation || line.location })}</p>}
                {awaitingRetrieval && <div className="case-retrieval-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void confirmLineRetrieval(line.id, "FAILED")}>{tr("reportRetrievalFailed")}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirmLineRetrieval(line.id, "RETRIEVED")}>{tr("confirmRetrieved")}</button></div>}
                {canReportLocation && activeCase && activeCase.phase !== "CLOSED" && !["RESOLVED", "CANCELLED"].includes(line.state) ? <LocationReportForm tr={tr} caseId={activeCase.id} lineId={line.id} onReported={async () => { await openCase(activeCase.id); await loadCases(); setActionNotice(tr("reportLocationSaved" as MessageKey)); }} /> : null}
              </article>
              );
            })}
          </div>
          {canReportShortPick && displayCase.phase === "PICKING" && (!showLineForm ? <button className="primary-button add-line-button" type="button" onClick={() => { setShowLineForm(true); setDuplicateLine(null); }}>{tr("addMissingItem")}</button> : (
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
          {displayCase.id && (displayCase.events?.length || displayCase.messages?.length) ? <section className="case-timeline-section" aria-label={tr("caseTimeline")}><h3>{tr("caseTimeline")}</h3><CaseTimeline events={displayCase.events || []} messages={displayCase.messages || []} tr={tr} formatDate={(value) => formatDate(value, locale)} className="case-shared-timeline" /></section> : null}
          {activeCase && canStage && activeCase.phase === "PICKING" && <div className="case-stage-panel">{stageConfirm ? <><p>{tr("stagingConfirm")}</p><div className="case-stage-actions"><button className="secondary-button" type="button" onClick={() => setStageConfirm(false)} disabled={busy}>{tr("cancel")}</button><button className="primary-button" type="button" onClick={() => void stageOrder()} disabled={busy}>{tr("stagingConfirmButton")}</button></div></> : <button className="secondary-button" type="button" onClick={() => setStageConfirm(true)} disabled={busy}>{tr("stagingAction")}</button>}</div>}
          {activeCase && canClose && activeCase.phase !== "CLOSED" && activeCase.lines.length > 0 && activeCase.lines.every((line) => ["RESOLVED", "CANCELLED"].includes(line.state)) && <button className="secondary-button case-close-button" type="button" disabled={busy} onClick={() => void closeResolvedCase()}>{tr("closeCase")}</button>}
        </section>
      ) : (
        <>
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
          {canViewOwnCases && <section className="my-cases-section" aria-labelledby="my-cases-title">
            <div className="invite-list-heading"><h2 id="my-cases-title">{tr("myShortPickOrders")}</h2><div className="live-refresh-controls"><LiveRefreshStatus state={liveState} tr={tr} /><button className="refresh-cases-button" type="button" onClick={() => void loadCases()} disabled={loading}>{tr("refresh")}</button></div></div>
            {loading ? <p className="case-list-empty" aria-live="polite">{tr("loadingCases")}</p> : cases.length === 0 ? <p className="case-list-empty">{tr("noActiveCases")}</p> : <div className="picker-case-list">{cases.map((item) => {
              const lines = item.lines || [];
              const missing = item.missingCount ?? lines.reduce((sum, line) => sum + (line.state.toUpperCase() === "OPEN" || line.state.toUpperCase() === "CHECKING" ? line.quantity : 0), 0);
              const found = item.foundCount ?? lines.reduce((sum, line) => sum + (line.state.toUpperCase() === "FOUND" || line.state.toUpperCase() === "RETRIEVED" ? line.quantity : 0), 0);
              const checking = item.checkingCount ?? lines.filter((line) => line.state.toUpperCase() === "CHECKING").length;
              return <article className="picker-case-row" key={item.id}><div className="picker-case-main"><strong>{item.orderNumber}</strong><CaseStatusBadge status={(item.lines?.[0]?.state ?? (checking > 0 ? "CHECKING" : found > 0 ? "FOUND" : "OPEN"))} tr={tr} /><span>{tr("missingCount", { count: String(missing) })}{found > 0 ? ` · ${tr("foundCount", { count: String(found) })}` : ""}{checking > 0 ? ` · ${tr("checkingCount", { count: String(checking) })}` : ""}</span></div><button className="case-open-button" type="button" onClick={() => void openCase(item.id)} disabled={busy}>{tr("openCase")}</button></article>;
            })}</div>}
          </section>}
        </>
      )}
    </div>
  );
}
