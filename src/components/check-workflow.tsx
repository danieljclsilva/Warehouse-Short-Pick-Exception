"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import { LiveRefreshStatus } from "@/components/live-refresh-status";
import { ScanInput } from "@/components/scan-input";
import { useLiveRefresh } from "@/components/use-live-refresh";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { CaseTimeline, type CaseTimelineEvent } from "@/components/case-timeline";
import { SharedCaseLineCard, SharedInlineLocationForm } from "@/components/case-line-card";

type Check = {
  id: string;
  caseId: string;
  lineId: string;
  orderNumber: string;
  casePhase: string;
  location: string;
  sku: string;
  quantity: number;
  status: string;
  assignedToUserId: string | null;
  claimedByUserId: string | null;
  assigneeName: string | null;
  assignedByName: string | null;
  assignedAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  createdAt: string | null;
};
type Retrieval = {
  caseId: string;
  lineId: string;
  orderNumber: string;
  location: string;
  discoveredLocation: string | null;
  sku: string;
  quantity: number;
  retrievalState: string;
};
type Worker = { id: string; displayName: string; status: string; permissions: string[] };
type CaseDetail = {
  id: string; orderNumber: string; phase: string; physicalState: string; physicalLocation: string | null;
  lines: Array<{ id: string; location: string; sku: string; quantity: number; state: string; discoveredLocation: string | null; retrievalState?: string | null; retrievalResponsibleUserId?: string | null; replenishmentState?: string | null; responsibleName: string | null; reporterName?: string | null; reporterIdentifier?: string | null }>;
  checks: Array<{ id: string; shortPickLineId: string; status: string; completionCode: string | null; completedAt: string | null; assigneeName: string | null }>;
  events: Array<{ id: string; eventType: string; actorName: string | null; createdAt: string; completionCode?: string | null; discoveredLocation?: string | null; originalLocation?: string | null; taskId?: string | null; resultMessage?: string | null }>;
  messages: Array<{ id: string; authorName: string; message: string; createdAt: string }>;
};
type Props = {
  locale: Locale;
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  canViewAvailable: boolean;
  canClaim: boolean;
  canComplete: boolean;
  canAssign: boolean;
  canReassign: boolean;
  canRetrieve: boolean;
  canMessage: boolean;
  canRecordReplenishment?: boolean;
  canReportLocation?: boolean;
  canViewAllOpenCases?: boolean;
  focusedCaseId?: string | null;
  focusedNonce?: number;
  onFocusConsumed?: () => void;
  onFocusedClose?: () => void;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as {
    code?: string; checks?: Check[]; retrievals?: Retrieval[]; users?: Worker[]; case?: CaseDetail;
  };
}

function withReplenishmentProjection(caseDetail: CaseDetail): CaseDetail {
  const raw = caseDetail as CaseDetail & { lineProjections?: Array<{ lineId: string; replenishment?: { state?: string } }> };
  if (!raw.lineProjections) return caseDetail;
  const projectedByLineId: Record<string, string | undefined> = {};
  for (const entry of raw.lineProjections) {
    if (entry && typeof entry.lineId === "string") projectedByLineId[entry.lineId] = entry.replenishment?.state;
  }
  return { ...raw, lines: raw.lines.map((line) => {
    const projected = projectedByLineId[line.id];
    if (!projected) return line;
    return { ...line, replenishmentState: projected };
  }) };
}
function formatCheckAge(iso: string): string {
  const elapsedMs = Date.now() - Date.parse(iso);
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

export function CheckWorkflow({ locale, tr, canViewAvailable, canClaim, canComplete, canAssign, canReassign, canRetrieve, canMessage, canRecordReplenishment = false, canReportLocation = false, canViewAllOpenCases = false, focusedCaseId, focusedNonce, onFocusConsumed, onFocusedClose }: Props) {
  const [available, setAvailable] = useState<Check[]>([]);
  const [mine, setMine] = useState<Check[]>([]);
  const [active, setActive] = useState<Check[]>([]);
  const [retrievals, setRetrievals] = useState<Retrieval[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = useState<Record<string, string>>({});
  const [completionTaskId, setCompletionTaskId] = useState("");
  const [completionCode, setCompletionCode] = useState<"FOUND" | "FOUND_AT_ORIGINAL" | "NOT_FOUND" | "WRONG_LOCATION" | "OTHER">("FOUND");
  const [discoveredLocation, setDiscoveredLocation] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [message, setMessage] = useState("");
  const [reportLocationLineId, setReportLocationLineId] = useState<string | null>(null);
  const [reportLocationValue, setReportLocationValue] = useState("");
  // Success confirmations dismiss themselves; errors stay until the next action.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const detailRef = useRef<HTMLElement | null>(null);
  const scrolledDetailId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const requests: Array<Promise<[string, Response]>> = [];
    if (canViewAvailable) requests.push(fetch("/api/checks?scope=available", { cache: "no-store" }).then((response) => ["available", response]));
    if (canComplete) requests.push(fetch("/api/checks?scope=mine", { cache: "no-store" }).then((response) => ["mine", response]));
    if (canReassign) requests.push(fetch("/api/checks?scope=active", { cache: "no-store" }).then((response) => ["active", response]));
    if (canRetrieve) requests.push(fetch("/api/retrievals", { cache: "no-store" }).then((response) => ["retrievals", response]));
    if (canAssign || canReassign) requests.push(fetch("/api/admin/users", { cache: "no-store" }).then((response) => ["users", response]));
    try {
      const responses = await Promise.all(requests);
      const data = await Promise.all(responses.map(async ([kind, response]) => {
        const body = await readJson(response);
        if (!response.ok) throw new Error(tr("checkActionFailed"));
        return { kind, body };
      }));
      for (const { kind, body } of data) {
        if (kind === "available") setAvailable(body.checks || []);
        if (kind === "mine") setMine(body.checks || []);
        if (kind === "active") setActive(body.checks || []);
        if (kind === "retrievals") setRetrievals(body.retrievals || []);
        if (kind === "users") setWorkers((body.users || []).filter((user) => user.status === "ACTIVE" && user.permissions.includes("COMPLETE_CHECK")));
      }
      setError("");
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, [canViewAvailable, canComplete, canReassign, canRetrieve, canAssign, tr]);

  const refreshLiveData = useCallback(async () => {
    if (!await load()) throw new Error("refresh failed");
    if (detail) {
      const response = await fetch(`/api/cases/${encodeURIComponent(detail.id)}`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !body.case) throw new Error("refresh failed");
      setDetail(withReplenishmentProjection(body.case));
    }
  }, [detail, load]);
  const liveState = useLiveRefresh(refreshLiveData);

  const openDetails = useCallback(async (caseId: string) => {
    setError("");
    try {
      const response = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setDetail(withReplenishmentProjection(body.case));
    } catch { setError(tr("caseLoadError")); }
  }, [tr]);
  const focusConsumedRef = useRef(0);
  useEffect(() => {
    if (!focusedCaseId || !focusedNonce || focusConsumedRef.current === focusedNonce) return;
    focusConsumedRef.current = focusedNonce;
    void openDetails(focusedCaseId).finally(() => { onFocusConsumed?.(); });
  }, [focusedCaseId, focusedNonce, onFocusConsumed, openDetails]);
  useEffect(() => {
    if (!detail || scrolledDetailId.current === detail.id) return;
    scrolledDetailId.current = detail.id;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    detailRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    detailRef.current?.focus({ preventScroll: true });
  }, [detail]);
  useEffect(() => { if (!detail) scrolledDetailId.current = null; }, [detail]);
  const closeDetail = () => { setDetail(null); setReportLocationLineId(null); setReportLocationValue(""); onFocusedClose?.(); };

  const mutate = async (id: string, path: string, method: "POST" | "PATCH", body?: unknown) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.code === "CHECK_CAPACITY_REACHED" ? tr("checkCapacityReached") : tr("checkActionFailed"));
      setNotice(tr("checkActionSaved"));
      setCompletionTaskId("");
      setDiscoveredLocation("");
      setResultMessage("");
      await load();
      if (detail) await openDetails(detail.id);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("checkActionFailed"));
      return false;
    } finally {
      setBusyId("");
    }
  };

  const workerSelect = (taskId: string) => (
    <select className="check-worker-select" aria-label={tr("selectWorker")} value={selectedWorkers[taskId] || ""}
      onChange={(event) => setSelectedWorkers((current) => ({ ...current, [taskId]: event.target.value }))}>
      <option value="">{tr("selectWorker")}</option>
      {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}
    </select>
  );
  const checkCard = (check: Check, mode: "available" | "mine" | "active") => {
    const canOpenCase = mode !== "available" || canViewAllOpenCases;
    const elapsedBase = check.assignedAt ?? check.claimedAt ?? check.startedAt ?? check.createdAt;
    return <article className="check-card" key={check.id}>
      <div className="check-card-head"><strong>{tr("orderLabel")} {check.orderNumber}</strong><span>{check.casePhase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}</span></div>
      <p className="check-card-item"><strong>{check.location}</strong><span>{check.sku} ×{check.quantity}</span></p>
      {check.assigneeName ? <p><span className="responsible-badge">{tr("checkResponsibleBadge", { name: check.assigneeName })}</span></p> : null}
      {check.assignedByName ? <p className="check-card-meta">{tr("checkAssignedBy", { name: check.assignedByName })}</p> : null}
      {elapsedBase && check.status !== "AVAILABLE" ? <p className="check-card-meta">{tr(check.status === "CLAIMED" ? "checkClaimedAgo" : "checkAssignedAgo", { age: formatCheckAge(elapsedBase) })}</p> : null}
      {canOpenCase && <button className="check-detail-button" type="button" onClick={() => void openDetails(check.caseId)}>{tr("openCase")}</button>}
      {mode === "available" && canClaim && <button type="button" className="primary-button" disabled={Boolean(busyId)} onClick={() => void mutate(check.id, `/api/checks/${check.id}/claim`, "POST")}>{tr("claimCheck")}</button>}
      {mode === "available" && canAssign && <div className="check-assign-row">{workerSelect(check.id)}<button type="button" className="secondary-button" disabled={Boolean(busyId) || !selectedWorkers[check.id]} onClick={() => void mutate(check.id, `/api/checks/${check.id}/assign`, "PATCH", { userId: selectedWorkers[check.id] })}>{tr("assignCheck")}</button></div>}
      {mode === "active" && canReassign && <div className="check-assign-row">{workerSelect(check.id)}<button type="button" className="secondary-button" disabled={Boolean(busyId) || !selectedWorkers[check.id]} onClick={() => void mutate(check.id, `/api/checks/${check.id}/assign`, "PATCH", { userId: selectedWorkers[check.id] })}>{tr("reassignCheck")}</button></div>}
      {mode === "mine" && canComplete && (completionTaskId === check.id ? (
        <form className="check-complete-form" onSubmit={(event) => { event.preventDefault(); void mutate(check.id, `/api/checks/${check.id}/complete`, "POST", { code: completionCode, ...(completionCode === "FOUND" ? { discoveredLocation } : {}), ...(resultMessage.trim() ? { message: resultMessage.trim() } : {}) }); }}>
          <label className="form-field"><span>{tr("completionResult")}</span><select value={completionCode} onChange={(event) => setCompletionCode(event.target.value as typeof completionCode)}>
            <option value="FOUND">{tr("foundResult")}</option><option value="FOUND_AT_ORIGINAL">{tr("foundAtOriginalOption")}</option><option value="NOT_FOUND">{tr("notFoundResult")}</option><option value="WRONG_LOCATION">{tr("wrongLocationResult")}</option><option value="OTHER">{tr("otherResult")}</option>
          </select></label>
          {completionCode === "FOUND" && <label className="form-field"><span>{tr("newLocation")}</span><ScanInput required autoCapitalize="characters" value={discoveredLocation} onChange={setDiscoveredLocation} tr={tr} scanKind="location" fieldLabel={tr("newLocation")} /></label>}
          <label className="form-field"><span>{tr("checkResultMessageLabel")}</span><input type="text" value={resultMessage} onChange={(event) => setResultMessage(event.target.value)} maxLength={500} placeholder={tr("checkResultMessagePlaceholder")} /></label>
          <div className="check-card-actions"><button type="button" className="secondary-button" onClick={() => setCompletionTaskId("")}>{tr("cancel")}</button><button type="submit" className="primary-button" disabled={Boolean(busyId)}>{tr("completeCheck")}</button></div>
        </form>
      ) : <button type="button" className="primary-button" onClick={() => { setCompletionTaskId(check.id); setCompletionCode("FOUND"); setDiscoveredLocation(""); setResultMessage(""); }}>{tr("completeCheck")}</button>)}
    </article>;
  };

  if (detail) return <div className="check-workflow">
    {error && <p className="case-alert" role="alert">{error}</p>}
    {notice && <p className="check-notice" role="status">{notice}</p>}
    <button className="case-back-button" type="button" onClick={closeDetail}>‹ {tr("backToChecks")}</button>
    <section ref={detailRef} id="check-case-detail" tabIndex={-1} className="check-detail-panel" aria-label={tr("caseDetails")}>
      <div className="check-detail-heading"><div><span>{tr("orderLabel")}</span><h2>{detail.orderNumber}</h2><span className="case-badges"><CaseStatusBadge status={detail.lines[0]?.state ?? detail.phase} tr={tr} /></span></div></div>
      <p className="check-detail-state">{detail.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")} · {detail.physicalState === "SHORT_PICK_HOLD" ? tr("physicalShortPickHold") : detail.physicalState === "WITH_PICKER" ? tr("physicalWithPicker") : detail.physicalState === "OTHER_KNOWN_LOCATION" ? tr("physicalOtherLocation") : tr("physicalUnknown")}{detail.physicalLocation ? ` · ${detail.physicalLocation}` : ""}</p>
      <h3>{tr("reportedItems")}</h3>
      <div className="check-detail-lines">{detail.lines.map((line) => {
        const reportable = canReportLocation && detail.phase !== "CLOSED" && !["RESOLVED", "CANCELLED"].includes(line.state);
        const submitReportLocation = (lineId: string) => { void (async () => { setBusyId(lineId); setError(""); setNotice(""); try { const response = await fetch(`/api/cases/${encodeURIComponent(detail.id)}/lines/${encodeURIComponent(lineId)}/discovered-location`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: reportLocationValue.trim().toUpperCase() }), cache: "no-store" }); if (!response.ok) throw new Error(tr("reportLocationFailed")); setReportLocationLineId(null); setReportLocationValue(""); await load(); await openDetails(detail.id); setNotice(tr("reportLocationSaved")); } catch { setError(tr("reportLocationFailed")); } finally { setBusyId(""); } })(); };
        return <SharedCaseLineCard key={line.id} tr={tr} caseId={detail.id} casePhase={detail.phase} line={line} projections={new Map()}
          actions={{ canRecordReplenishment, canRetrieve, canReportLocation, busyId,
            onSaved: async () => { await openDetails(detail.id); setNotice(tr("replenishmentSaved")); },
            onRetrieve: (lineId, result) => { void mutate(lineId, `/api/cases/${detail.id}/lines/${lineId}/retrieve`, "POST", { result }); },
            reportForm: (lineId) => (reportable ? (reportLocationLineId === line.id ? <SharedInlineLocationForm tr={tr} placeholder={tr("reportLocationPlaceholder")} value={reportLocationValue} onChange={setReportLocationValue} onSubmit={() => submitReportLocation(lineId)} /> : <button type="button" className="secondary-button" onClick={() => { setReportLocationLineId(line.id); setReportLocationValue(""); }}>{tr("reportLocationAction")}</button>) : null) }} />;
      })}</div>
      <h3>{tr("caseTimeline")}</h3>
      <CaseTimeline events={detail.events as CaseTimelineEvent[]} messages={detail.messages} tr={tr} formatDate={(value) => new Date(value).toLocaleString(locale)} className="check-detail-timeline" />
      {canMessage && <form className="check-detail-message" onSubmit={async (event) => { event.preventDefault(); if (!message.trim()) return; const saved = await mutate(detail.id, `/api/cases/${detail.id}/messages`, "POST", { message: message.trim() }); if (saved) setMessage(""); }}><label className="form-field"><span>{tr("caseMessageLabel")}</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} rows={3} required /></label><button className="primary-button" type="submit" disabled={Boolean(busyId)}>{tr("sendCaseMessage")}</button></form>}
    </section>
  </div>;
  return <div className="check-workflow">
    <div className="content-heading"><div><h1>{tr("checks")}</h1></div><div className="live-refresh-controls"><LiveRefreshStatus state={liveState} tr={tr} /><button type="button" className="refresh-cases-button" onClick={() => void load()}>{tr("refresh")}</button></div></div>
    {error && <p className="case-alert" role="alert">{error}</p>}
    {notice && <p className="check-notice" role="status">{notice}</p>}
    {canComplete && <section className="check-section"><h2>{tr("myAssignedChecks")}</h2>{loading ? <p>{tr("loading")}</p> : mine.length ? <div className="check-card-grid">{mine.map((check) => checkCard(check, "mine"))}</div> : <p className="check-empty">{tr("noAssignedChecks")}</p>}</section>}
    {canRetrieve && <section className="check-section"><h2>{tr("myRetrievals")}</h2>{loading ? <p>{tr("loading")}</p> : retrievals.length ? <div className="check-card-grid">{retrievals.map((item) => <article className="check-card" key={item.lineId}>
      <div className="check-card-head"><strong>{tr("orderLabel")} {item.orderNumber}</strong><span>{item.retrievalState === "FAILED" ? tr("retrievalFailed") : tr("retrievalPending")}</span></div>
      <p className="check-card-item"><strong>{item.discoveredLocation || item.location}</strong><span>{item.sku} ×{item.quantity}</span></p>
      <button className="check-detail-button" type="button" onClick={() => void openDetails(item.caseId)}>{tr("openCase")}</button>
      <div className="check-card-actions"><button className="secondary-button" type="button" disabled={Boolean(busyId)} onClick={() => void mutate(item.lineId, `/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "FAILED" })}>{tr("reportRetrievalFailed")}</button>
      <button className="primary-button" type="button" disabled={Boolean(busyId)} onClick={() => void mutate(item.lineId, `/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" })}>{tr("confirmRetrieved")}</button></div>
    </article>)}</div> : <p className="check-empty">{tr("noRetrievals")}</p>}</section>}
    {canViewAvailable && <section className="check-section"><h2>{tr("availableChecks")}</h2>{loading ? <p>{tr("loading")}</p> : available.length ? <div className="check-card-grid">{available.map((check) => checkCard(check, "available"))}</div> : <p className="check-empty">{tr("noAvailableChecks")}</p>}</section>}
    {canReassign && <section className="check-section"><h2>{tr("activeChecks")}</h2>{loading ? <p>{tr("loading")}</p> : active.length ? <div className="check-card-grid">{active.map((check) => checkCard(check, "active"))}</div> : <p className="check-empty">{tr("noActiveChecks")}</p>}</section>}
  </div>;
}
