"use client";

import type { MessageKey } from "@/i18n/messages";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { CaseTimeline, type CaseTimelineEvent, type CaseTimelineMessage } from "@/components/case-timeline";
import { ReplenishmentForm } from "@/components/replenishment-form";
import { ScanInput } from "@/components/scan-input";

export type SharedTranslator = (key: MessageKey, values?: Record<string, string>) => string;

export type SharedCaseLine = {
  id: string;
  location: string;
  sku: string;
  quantity: number;
  state: string;
  discoveredLocation?: string | null;
  retrievalState?: string | null;
  replenishmentState?: string | null;
  responsibleName?: string | null;
  reporterName?: string | null;
  reporterIdentifier?: string | null;
  displayStatus?: string | null;
};

export type SharedLineProjection = {
  lineId: string;
  displayStatus: string;
  replenishment?: { state: string; note: string | null; actorName: string | null; at: string | null } | null;
};

export type SharedLineActions = {
  canRecordReplenishment: boolean;
  canRetrieve: boolean;
  canReportLocation: boolean;
  busyId: string;
  onSaved: () => void | Promise<void>;
  onRetrieve: (lineId: string, result: "RETRIEVED" | "FAILED") => void;
  reportForm: (lineId: string) => React.ReactNode;
};

function lineStatus(line: SharedCaseLine, projections: Map<string, SharedLineProjection>): string {
  return projections.get(line.id)?.displayStatus ?? line.displayStatus ?? line.state;
}

export function SharedCaseLineCard({
  tr,
  caseId,
  casePhase,
  line,
  projections,
  actions,
}: {
  tr: SharedTranslator;
  caseId: string;
  casePhase: string;
  line: SharedCaseLine;
  projections: Map<string, SharedLineProjection>;
  actions: SharedLineActions;
}) {
  const status = lineStatus(line, projections);
  const replenishment = (projections.get(line.id)?.replenishment?.state ?? line.replenishmentState ?? "NONE").toUpperCase();
  const retrieval = (line.retrievalState ?? "NOT_REQUIRED").toUpperCase();
  const retrievalPending = actions.canRetrieve && line.state === "FOUND" && (retrieval === "PENDING" || retrieval === "FAILED");
  const showWriter = actions.canRecordReplenishment && replenishment !== "COMPLETED"
    && !["RESOLVED", "CANCELLED"].includes(line.state) && casePhase !== "CLOSED";
  return (
    <div>
      <strong>{line.location} · {line.sku} ×{line.quantity}</strong>
      {line.responsibleName ? <p><span className="responsible-badge">{tr("checkResponsibleBadge", { name: line.responsibleName })}</span></p> : null}
      <CaseStatusBadge kind="line" status={status} retrievalState={line.retrievalState} tr={tr} />
      {(line.reporterName || line.reporterIdentifier) ? (
        <small>{tr("lineReportedBy", { name: line.reporterName || line.reporterIdentifier || "" })}<br />{line.reporterIdentifier ? tr("lineReporterId", { id: line.reporterIdentifier }) : ""}</small>
      ) : null}
      {replenishment !== "NONE" ? <p className="replenishment-badge" data-state={replenishment}>{tr(`replenishmentState${replenishment}` as MessageKey)}</p> : null}
      {retrieval === "NOT_REQUIRED" && casePhase !== "STAGED" ? <p className="retrieval-badge" data-state="NOT_REQUIRED">{tr("retrievalNotRequired")}</p> : null}
      {showWriter ? (
        <ReplenishmentForm tr={tr} caseId={caseId} lineId={line.id} currentState={replenishment} compact onSaved={actions.onSaved} />
      ) : null}
      {retrievalPending ? (
        <div className="check-card-actions">
          <button className="secondary-button" type="button" disabled={Boolean(actions.busyId)} onClick={() => actions.onRetrieve(line.id, "FAILED")}>{tr("reportRetrievalFailed")}</button>
          <button className="primary-button" type="button" disabled={Boolean(actions.busyId)} onClick={() => actions.onRetrieve(line.id, "RETRIEVED")}>{tr("confirmRetrieved")}</button>
        </div>
      ) : null}
      {actions.canReportLocation && actions.reportForm(line.id)}
    </div>
  );
}

export function SharedInlineLocationForm({ tr, placeholder, value, onChange, onSubmit }: {
  tr: SharedTranslator;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="check-complete-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="form-field">
        <span>{tr("reportLocationAction")}</span>
        <ScanInput required autoCapitalize="characters" value={value} onChange={onChange} tr={tr} scanKind="location" fieldLabel={tr("reportLocationAction")} placeholder={placeholder} />
      </label>
      <button type="submit" className="secondary-button">{tr("reportLocationAction")}</button>
    </form>
  );
}

export function SharedCaseTimeline({ tr, events, messages, formatDate, className }: {
  tr: SharedTranslator;
  events: CaseTimelineEvent[];
  messages: CaseTimelineMessage[];
  formatDate: (value: string) => string;
  className: string;
}) {
  return <CaseTimeline events={events} messages={messages} tr={tr} formatDate={formatDate} className={className} />;
}
