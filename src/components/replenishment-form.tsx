"use client";

import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";

/** Active directory user usable as the named replenishment retriever. */
export type ReplenishmentWorker = { id: string; displayName: string; role: string };

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

type Props = {
  tr: Translator;
  caseId: string;
  lineId: string;
  /** Current persisted replenishment state: NONE accepts WAITING or COMPLETED, WAITING accepts COMPLETED only. */
  currentState: string;
  /** Compact inline placement next to a line; default expanded panel. */
  compact?: boolean;
  onSaved: () => void | Promise<void>;
};

/**
 * One shared replenishment writer for every case surface: the server stays the
 * authorization boundary (`RECORD_REPLENISHMENT`, transition + active-retriever
 * validation in `recordReplenishment`). The form posts `{ state, note,
 * retrieverUserId }` to the existing replenishment route and reports the
 * consequence + next action through `onSaved` + the confirmation notice.
 */
export function ReplenishmentForm({ tr, caseId, lineId, currentState, compact = false, onSaved }: Props) {
  const normalized = (currentState || "NONE").toUpperCase();
  const options = normalized === "WAITING" ? (["COMPLETED"] as const) : (["WAITING", "COMPLETED"] as const);
  const [open, setOpen] = useState(!compact);
  const [state, setState] = useState<"WAITING" | "COMPLETED">(normalized === "WAITING" ? "COMPLETED" : "WAITING");
  const [note, setNote] = useState("");
  const [retrieverUserId, setRetrieverUserId] = useState("");
  const [workers, setWorkers] = useState<ReplenishmentWorker[]>([]);
  const [workersFailed, setWorkersFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/users/directory", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { users?: ReplenishmentWorker[] };
        if (!response.ok) throw new Error("users");
        const active = (body.users || []).filter((worker) => worker && typeof worker.id === "string");
        if (!cancelled) {
          setWorkers(active);
          setWorkersFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setWorkersFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open ]);

  if (normalized === "COMPLETED") return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = note.trim();
    if (!trimmed || !retrieverUserId || busy) {
      if (!trimmed || !retrieverUserId) setError(tr("replenishmentFailed"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/replenishment`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, note: trimmed, retrieverUserId }),
      });
      if (!response.ok) throw new Error(tr("replenishmentFailed"));
      setNote("");
      setRetrieverUserId("");
      setOpen(compact);
      await onSaved();
    } catch {
      setError(tr("replenishmentFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="secondary-button" onClick={() => setOpen(true)}>
        {tr("replenishmentAction")}
      </button>
    );
  }

  return (
    <form className="replenishment-form" onSubmit={submit}>
      <label className="form-field">
        <span>{tr("lineReplenishmentState")}</span>
        <select value={state} onChange={(event) => setState(event.target.value as "WAITING" | "COMPLETED")} disabled={busy}>
          {options.map((option) => (
            <option key={option} value={option}>
              {tr(option === "WAITING" ? "replenishmentWaitingOption" : "replenishmentCompletedOption")}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        <span>{tr("replenishmentNoteLabel")}</span>
        <textarea
          rows={2}
          required
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={tr("replenishmentNotePlaceholder")}
          disabled={busy}
        />
      </label>
      <label className="form-field">
        <span>{tr("replenishmentRetrieverLabel")}</span>
        <select value={retrieverUserId} onChange={(event) => setRetrieverUserId(event.target.value)} required disabled={busy}>
          <option value="">{tr("selectWorker")}</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.displayName}
            </option>
          ))}
        </select>
        {workersFailed ? <small>{tr("usersLoadError")}</small> : null}
      </label>
      {error ? (
        <p className="case-alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="check-card-actions">
        {compact ? (
          <button type="button" className="secondary-button" onClick={() => setOpen(false)} disabled={busy}>
            {tr("cancel")}
          </button>
        ) : null}
        <button type="submit" className="primary-button" disabled={busy || !note.trim() || !retrieverUserId}>
          {tr("replenishmentAction")}
        </button>
      </div>
    </form>
  );
}
