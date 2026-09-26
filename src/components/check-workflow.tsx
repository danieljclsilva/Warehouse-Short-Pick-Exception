"use client";

import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";

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
type Props = {
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  canViewAvailable: boolean;
  canClaim: boolean;
  canComplete: boolean;
  canAssign: boolean;
  canReassign: boolean;
  canRetrieve: boolean;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as {
    code?: string; checks?: Check[]; retrievals?: Retrieval[]; users?: Worker[];
  };
}

export function CheckWorkflow({ tr, canViewAvailable, canClaim, canComplete, canAssign, canReassign, canRetrieve }: Props) {
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
    } catch {
      setError(tr("checkActionFailed"));
    } finally {
      setLoading(false);
    }
  }, [canViewAvailable, canComplete, canReassign, canRetrieve, canAssign, tr]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("checkActionFailed"));
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
    <div className="content-heading"><div><h1>{tr("checks")}</h1></div><button type="button" className="refresh-cases-button" onClick={() => void load()}>{tr("refresh")}</button></div>
    {error && <p className="case-alert" role="alert">{error}</p>}
    {notice && <p className="check-notice" role="status">{notice}</p>}
    {canComplete && <section className="check-section"><h2>{tr("myAssignedChecks")}</h2>{loading ? <p>{tr("loading")}</p> : mine.length ? <div className="check-card-grid">{mine.map((check) => checkCard(check, "mine"))}</div> : <p className="check-empty">{tr("noAssignedChecks")}</p>}</section>}
    {canRetrieve && <section className="check-section"><h2>{tr("myRetrievals")}</h2>{loading ? <p>{tr("loading")}</p> : retrievals.length ? <div className="check-card-grid">{retrievals.map((item) => <article className="check-card" key={item.lineId}>
      <div className="check-card-head"><strong>{tr("orderLabel")} {item.orderNumber}</strong><span>{item.retrievalState === "FAILED" ? tr("retrievalFailed") : tr("retrievalPending")}</span></div>
      <p className="check-card-item"><strong>{item.discoveredLocation || item.location}</strong><span>{item.sku} ×{item.quantity}</span></p>
      <div className="check-card-actions"><button className="secondary-button" type="button" disabled={Boolean(busyId)} onClick={() => void mutate(item.lineId, `/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "FAILED" })}>{tr("reportRetrievalFailed")}</button>
      <button className="primary-button" type="button" disabled={Boolean(busyId)} onClick={() => void mutate(item.lineId, `/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" })}>{tr("confirmRetrieved")}</button></div>
    </article>)}</div> : <p className="check-empty">{tr("noRetrievals")}</p>}</section>}
    {canViewAvailable && <section className="check-section"><h2>{tr("availableChecks")}</h2>{loading ? <p>{tr("loading")}</p> : available.length ? <div className="check-card-grid">{available.map((check) => checkCard(check, "available"))}</div> : <p className="check-empty">{tr("noAvailableChecks")}</p>}</section>}
    {canReassign && <section className="check-section"><h2>{tr("activeChecks")}</h2>{loading ? <p>{tr("loading")}</p> : active.length ? <div className="check-card-grid">{active.map((check) => checkCard(check, "active"))}</div> : <p className="check-empty">{tr("noActiveChecks")}</p>}</section>}
  </div>;
}
