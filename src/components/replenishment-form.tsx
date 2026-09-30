"use client";

import { useState } from "react";
import type { MessageKey } from "@/i18n/messages";

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
 * One shared state-only replenishment writer for the manager-role surfaces.
 * The server stays the authorization boundary (`RECORD_REPLENISHMENT` +
 * transition checks in `recordReplenishment`). The form posts `{ state }` to
 * the existing replenishment route and reports the consequence through
 * `onSaved` + the confirmation notice. Pickers never render this writer.
 */
export function ReplenishmentForm({ tr, caseId, lineId, currentState, compact = false, onSaved }: Props) {
  const normalized = (currentState || "NONE").toUpperCase();
  const options = normalized === "WAITING" ? (["COMPLETED"] as const) : (["WAITING", "COMPLETED"] as const);
  const [open, setOpen] = useState(!compact);
  const [state, setState] = useState<"WAITING" | "COMPLETED">(normalized === "WAITING" ? "COMPLETED" : "WAITING");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (normalized === "COMPLETED") return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/replenishment`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (!response.ok) throw new Error(tr("replenishmentFailed"));
      setOpen(false);
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
