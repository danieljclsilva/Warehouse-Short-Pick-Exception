"use client";

import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

type DirectoryUser = { id: string; displayName: string; role: string };
type DirectoryPage = {
  users?: DirectoryUser[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
};

type ReplenishmentResult = {
  state?: string;
  retrievalResponsibleUserId?: string | null;
  ownerName?: string | null;
  ownerDisplayName?: string | null;
  retrievalResponsibleName?: string | null;
  retrieverName?: string | null;
  retrievalLocation?: string | null;
  discoveredLocation?: string | null;
  note?: string | null;
};

const DIRECTORY_PAGE_SIZE = 50;
const NOTE_MAX_LENGTH = 500;

type Props = {
  tr: Translator;
  caseId: string;
  lineId: string;
  /** Line location shown in the completion consequence. Never translated. */
  location?: string | null;
  /** Current persisted replenishment state: NONE accepts WAITING or COMPLETED, WAITING accepts COMPLETED only. */
  currentState: string;
  /** Compact inline placement next to a line; default expanded panel. */
  compact?: boolean;
  onSaved: () => void | Promise<void>;
};

/**
 * Shared note + named-retriever replenishment writer.
 * The server stays the authorization boundary (`RECORD_REPLENISHMENT` +
 * transition/eligibility checks in `recordReplenishment`). The form posts
 * `{ state, note?, retrieverUserId? }`; the server is authoritative for the
 * derived owner and retrieval location.
 */
export function ReplenishmentForm({ tr, caseId, lineId, location = null, currentState, compact = false, onSaved }: Props) {
  const normalized = (currentState || "NONE").toUpperCase();
  const options = normalized === "WAITING" ? (["COMPLETED"] as const) : (["WAITING", "COMPLETED"] as const);
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [selectedState, setState] = useState<"WAITING" | "COMPLETED">(normalized === "WAITING" ? "COMPLETED" : "WAITING");
  const [note, setNote] = useState("");
  const [retrieverUserId, setRetrieverUserId] = useState("");
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryFailed, setDirectoryFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const state = normalized === "WAITING" ? "COMPLETED" : selectedState;

  // Sequential directory pagination with cancellation: accumulate into a local
  // record, publish after a cancellation check per page, and never silently cap.
  useEffect(() => {
    if (!open || success) return;
    let cancelled = false;
    const people: Record<string, DirectoryUser> = {};
    const load = async () => {
      setDirectoryLoading(true);
      setDirectoryFailed(false);
      setDirectory([]);
      try {
        let page = 1;
        for (;;) {
          const response = await fetch(
            `/api/users/directory?caseId=${encodeURIComponent(caseId)}&lineId=${encodeURIComponent(lineId)}&page=${page}&pageSize=${DIRECTORY_PAGE_SIZE}`,
            { credentials: "same-origin", cache: "no-store" },
          );
          if (!response.ok) throw new Error("directory failed");
          const body = (await response.json().catch(() => ({}))) as DirectoryPage;
          if (cancelled) return;
          const totalPages = typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : page;
          const rows = Array.isArray(body.users) ? body.users : [];
          for (const row of rows) {
            if (row && typeof row.id === "string" && !people[row.id]) people[row.id] = row;
          }
          setDirectory(Object.values(people));
          if (page >= totalPages) return;
          page += 1;
        }
      } catch {
        if (!cancelled) setDirectoryFailed(true);
      } finally {
        if (!cancelled) setDirectoryLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, success, caseId, lineId, reloadNonce]);

  // A recorded COMPLETED hides the writer, but a just-recorded success notice
  // must stay visible across the parent's COMPLETED prop change: the parent
  // reload can unmount this form, and the notice must not be lost silently.
  if (normalized === "COMPLETED" && !success) return null;

  if (success) {
    return (
      <div className="replenishment-form">
        <p className="replenishment-result" role="status">
          {success}
        </p>
        <div className="check-card-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSuccess("");
              setOpen(false);
            }}
          >
            {tr("dismiss")}
          </button>
        </div>
      </div>
    );
  }

  const retryDirectory = () => {
    setDirectoryFailed(false);
    setReloadNonce((value) => value + 1);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const trimmedNote = note.trim().slice(0, NOTE_MAX_LENGTH);
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/replenishment`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state,
          ...(trimmedNote ? { note: trimmedNote } : {}),
          ...(retrieverUserId ? { retrieverUserId } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string; replenishment?: ReplenishmentResult } & ReplenishmentResult;
      if (!response.ok) {
        if (typeof body.code === "string" && body.code.includes("OWNER")) setError(tr("replenishmentNoOwnerError"));
        else setError(tr("replenishmentFailed"));
        return;
      }
      const result: ReplenishmentResult = body.replenishment ?? body;
      if (state === "COMPLETED") {
        const actualOwnerName =
          result.ownerName ?? result.ownerDisplayName ?? result.retrievalResponsibleName ?? result.retrieverName ?? null;
        const actualLocation = result.retrievalLocation ?? result.discoveredLocation ?? location ?? "";
        const ownerName = actualOwnerName;
        setSuccess(
          ownerName
            ? tr("replenishmentCompletedPending", { name: ownerName, location: actualLocation })
            : tr("replenishmentCompletedUnassigned"),
        );
      } else {
        setSuccess(tr("replenishmentWaitingSaved"));
      }
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
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={tr("replenishmentNotePlaceholder")}
          disabled={busy}
        />
      </label>
      <label className="form-field">
        <span>{tr("replenishmentRetrieverLabel")}</span>
        <select value={retrieverUserId} onChange={(event) => setRetrieverUserId(event.target.value)} disabled={busy || directoryLoading || Boolean(success)}>
          <option value="">{state === "COMPLETED" ? tr("replenishmentAutoOwnerOption") : tr("replenishmentRetrieverPlaceholder")}</option>
          {directory.map((row) => (
            <option key={row.id} value={row.id}>
              {row.displayName}
            </option>
          ))}
        </select>
      </label>
      {directoryLoading ? <p className="case-list-empty">{tr("paginationLoading")}</p> : null}
      {directoryFailed ? (
        <div className="case-alert" role="alert">
          <p>{tr("replenishmentDirectoryFailed")}</p>
          <button type="button" className="secondary-button" onClick={retryDirectory} disabled={busy || directoryLoading}>
            {tr("tryAgain")}
          </button>
        </div>
      ) : null}
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
        <button type="submit" className="primary-button" disabled={busy}>
          {tr("replenishmentAction")}
        </button>
      </div>
    </form>
  );
}
