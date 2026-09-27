"use client";

import { useCallback, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import { LiveRefreshStatus } from "@/components/live-refresh-status";
import { useLiveRefresh } from "@/components/use-live-refresh";

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
  lines: Array<{ id: string; location: string; sku: string; quantity: number; state: string; discoveredLocation: string | null }>;
  checks: Array<{ id: string; shortPickLineId: string; status: string; completionCode: string | null; completedAt: string | null }>;
  events: Array<{ id: string; eventType: string; actorName: string | null; createdAt: string }>;
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
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as {
    code?: string; checks?: Check[]; retrievals?: Retrieval[]; users?: Worker[]; case?: CaseDetail;
  };
}

export function CheckWorkflow({ locale, tr, canViewAvailable, canClaim, canComplete, canAssign, canReassign, canRetrieve, canMessage }: Props) {
  const [available, setAvailable] = useState<Check[]>([]);
  const [mine, setMine] = useState<Check[]>([]);
  const [active, setActive] = useState<Check[]>([]);
  const [retrievals, setRetrievals] = useState<Retrieval[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = useState<Record<string, string>>({});
  const [completionTaskId, setCompletionTaskId] = useState("");
  const [completionCode, setCompletionCode] = useState<"FOUND" | "NOT_FOUND" | "WRONG_LOCATION" | "OTHER">("FOUND");
  const [discoveredLocation, setDiscoveredLocation] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [message, setMessage] = useState("");

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
      setDetail(body.case);
    }
  }, [detail, load]);
  const liveState = useLiveRefresh(refreshLiveData);

  const openDetails = async (caseId: string) => {
    setError("");
    try {
      const response = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !body.case) throw new Error(tr("caseLoadError"));
      setDetail(body.case);
    } catch { setError(tr("caseLoadError")); }
  };

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

  const checkCard = (check: Check, mode: "available" | "mine" | "active") => (
    <article className="check-card" key={check.id}>
      <div className="check-card-head"><strong>{tr("orderLabel")} {check.orderNumber}</strong><span>{check.casePhase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")}</span></div>
      <p className="check-card-item"><strong>{check.location}</strong><span>{check.sku} ×{check.quantity}</span></p>
      <button className="check-detail-button" type="button" onClick={() => void openDetails(check.caseId)}>{tr("openCase")}</button>
      {mode === "available" && canClaim && <button type="button" className="primary-button" disabled={Boolean(busyId)} onClick={() => void mutate(check.id, `/api/checks/${check.id}/claim`, "POST")}>{tr("claimCheck")}</button>}
      {mode === "available" && canAssign && <div className="check-assign-row">{workerSelect(check.id)}<button type="button" className="secondary-button" disabled={Boolean(busyId) || !selectedWorkers[check.id]} onClick={() => void mutate(check.id, `/api/checks/${check.id}/assign`, "PATCH", { userId: selectedWorkers[check.id] })}>{tr("assignCheck")}</button></div>}
      {mode === "active" && canReassign && <div className="check-assign-row">{workerSelect(check.id)}<button type="button" className="secondary-button" disabled={Boolean(busyId) || !selectedWorkers[check.id]} onClick={() => void mutate(check.id, `/api/checks/${check.id}/assign`, "PATCH", { userId: selectedWorkers[check.id] })}>{tr("reassignCheck")}</button></div>}
      {mode === "mine" && canComplete && (completionTaskId === check.id ? (
        <form className="check-complete-form" onSubmit={(event) => { event.preventDefault(); void mutate(check.id, `/api/checks/${check.id}/complete`, "POST", { code: completionCode, ...(completionCode === "FOUND" ? { discoveredLocation } : {}) }); }}>
          <label className="form-field"><span>{tr("completionResult")}</span><select value={completionCode} onChange={(event) => setCompletionCode(event.target.value as typeof completionCode)}>
            <option value="FOUND">{tr("foundResult")}</option><option value="NOT_FOUND">{tr("notFoundResult")}</option><option value="WRONG_LOCATION">{tr("wrongLocationResult")}</option><option value="OTHER">{tr("otherResult")}</option>
          </select></label>
          {completionCode === "FOUND" && <label className="form-field"><span>{tr("newLocation")}</span><input required autoCapitalize="characters" value={discoveredLocation} onChange={(event) => setDiscoveredLocation(event.target.value)} /></label>}
          <div className="check-card-actions"><button type="button" className="secondary-button" onClick={() => setCompletionTaskId("")}>{tr("cancel")}</button><button type="submit" className="primary-button" disabled={Boolean(busyId)}>{tr("completeCheck")}</button></div>
        </form>
      ) : <button type="button" className="primary-button" onClick={() => { setCompletionTaskId(check.id); setCompletionCode("FOUND"); setDiscoveredLocation(""); }}>{tr("completeCheck")}</button>)}
    </article>
  );

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
    {detail && <section className="check-detail-panel" aria-label={tr("caseDetails")}>
      <div className="check-detail-heading"><div><span>{tr("orderLabel")}</span><h2>{detail.orderNumber}</h2></div><button className="secondary-button" type="button" onClick={() => setDetail(null)}>{tr("closePanel")}</button></div>
      <p className="check-detail-state">{detail.phase === "STAGED" ? tr("phaseStaged") : tr("phasePicking")} · {detail.physicalState === "SHORT_PICK_HOLD" ? tr("physicalShortPickHold") : detail.physicalState === "WITH_PICKER" ? tr("physicalWithPicker") : detail.physicalState === "OTHER_KNOWN_LOCATION" ? tr("physicalOtherLocation") : tr("physicalUnknown")}{detail.physicalLocation ? ` · ${detail.physicalLocation}` : ""}</p>
      <h3>{tr("reportedItems")}</h3>
      <div className="check-detail-lines">{detail.lines.map((line) => <div key={line.id}><strong>{line.location} · {line.sku} ×{line.quantity}</strong><span>{line.discoveredLocation || (line.state === "CHECKING" ? tr("caseChecking") : line.state === "FOUND" ? tr("caseFound") : line.state === "RESOLVED" ? tr("caseRetrieved") : tr("caseOpen"))}</span><small>{detail.checks.filter((check) => check.shortPickLineId === line.id).map((check) => check.completionCode ? `${tr(({ FOUND: "foundResult", NOT_FOUND: "notFoundResult", WRONG_LOCATION: "wrongLocationResult", OTHER: "otherResult" } as const)[check.completionCode as "FOUND" | "NOT_FOUND" | "WRONG_LOCATION" | "OTHER"] ?? "otherResult")} · ${new Date(check.completedAt || "").toLocaleString(locale)}` : check.status === "AVAILABLE" ? tr("availableChecks") : tr("caseChecking")).join(" / ")}</small></div>)}</div>
      <h3>{tr("caseTimeline")}</h3>
      <ol className="check-detail-timeline">{[...detail.events.map((event) => ({ id: event.id, createdAt: event.createdAt, content: `${event.actorName || tr("systemActor")}: ${tr(`event_${event.eventType}` as MessageKey)}` })), ...detail.messages.map((item) => ({ id: item.id, createdAt: item.createdAt, content: `${item.authorName}: ${item.message}` }))].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((item) => <li key={item.id}><time>{new Date(item.createdAt).toLocaleString(locale)}</time><span>{item.content}</span></li>)}</ol>
      {canMessage && <form className="check-detail-message" onSubmit={async (event) => { event.preventDefault(); if (!message.trim()) return; const saved = await mutate(detail.id, `/api/cases/${detail.id}/messages`, "POST", { message: message.trim() }); if (saved) setMessage(""); }}><label className="form-field"><span>{tr("caseMessageLabel")}</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} rows={3} required /></label><button className="primary-button" type="submit" disabled={Boolean(busyId)}>{tr("sendCaseMessage")}</button></form>}
    </section>}
  </div>;
}
