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
  replenishmentNote?: string | null;
  replenishmentActorName?: string | null;
  retrievalResponsibleName?: string | null;
  responsibleName?: string | null;
  reporterName?: string | null;
  reporterIdentifier?: string | null;
  displayStatus?: string | null;
};

export type SharedLineProjection = {
  lineId: string;
  displayStatus: string;
  replenishment?: { state: string; note?: string | null; actorName?: string | null; at?: string | null } | null;
  nextActionCode?: string | null;
  actionOwnerName?: string | null;
  blockingReasonCode?: string | null;
};

export type SharedLineActions = {
  canRecordReplenishment: boolean;
  canRetrieve: boolean;
  canReportLocation: boolean;
  canRequestCheck?: boolean;
  busyId: string;
  onSaved: () => void | Promise<void>;
  onRetrieve: (lineId: string, result: "RETRIEVED" | "FAILED") => void;
  onRequestCheck?: (lineId: string) => void | Promise<void>;
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
  showRetrievalNotRequired = true,
  retrievalPrompt,
  additionalDetails,
}: {
  tr: SharedTranslator;
  caseId: string;
  casePhase: string;
  line: SharedCaseLine;
  projections: Map<string, SharedLineProjection>;
  actions: SharedLineActions;
  showRetrievalNotRequired?: boolean;
  retrievalPrompt?: React.ReactNode;
  additionalDetails?: React.ReactNode;
}) {
  const status = lineStatus(line, projections);
  const projection = projections.get(line.id);
  const replenishment = (projection?.replenishment?.state ?? line.replenishmentState ?? "NONE").toUpperCase();
  const replenishmentNote = projection?.replenishment?.note ?? line.replenishmentNote ?? null;
  const replenishmentActor = projection?.replenishment?.actorName ?? line.replenishmentActorName ?? null;
  const retrieval = (line.retrievalState ?? "NOT_REQUIRED").toUpperCase();
  const isClosed = casePhase === "CLOSED";
  const isTerminal = line.state === "RESOLVED" || line.state === "CANCELLED" || isClosed;
  // Completed replenishment materializes a pending physical-retrieval obligation
  // even when the main line state is not FOUND (checked by actual metadata).
  const retrievalPending = !isTerminal && actions.canRetrieve
    && (retrieval === "PENDING" || retrieval === "FAILED")
    && (line.state === "FOUND" || replenishment === "COMPLETED");
  const showWriter = actions.canRecordReplenishment && !isTerminal;
  const requestCheck = !isTerminal && (actions.canRequestCheck ?? false) && projection?.nextActionCode === "REQUEST_CHECK"
    && line.state === "OPEN" && replenishment !== "COMPLETED";
  return (
    <div>
      <div className="shared-case-line-heading">
        <div className="shared-case-line-product">
          <strong>{line.location}</strong>
          <span className="shared-case-line-sku">{line.sku} ×{line.quantity}</span>
        </div>
        <CaseStatusBadge kind="line" status={status} retrievalState={line.retrievalState} tr={tr} />
      </div>
      {line.discoveredLocation ? <p className="case-discovered-location">{tr("newLocation" as MessageKey)}: <strong>{line.discoveredLocation}</strong></p> : null}
      {line.responsibleName ? <p><span className="responsible-badge">{tr("checkResponsibleBadge", { name: line.responsibleName })}</span></p> : null}
      {line.retrievalResponsibleName ? <p><span className="responsible-badge">{tr("checkResponsibleBadge", { name: line.retrievalResponsibleName })}</span></p> : null}
      {additionalDetails}
      {replenishment !== "NONE" ? <p className="replenishment-badge" data-state={replenishment}>{tr(`replenishmentState${replenishment}` as MessageKey)}{replenishmentNote ? ` · ${replenishmentNote}` : ""}{replenishmentActor ? ` · ${replenishmentActor}` : ""}</p> : null}
      {showRetrievalNotRequired && retrieval === "NOT_REQUIRED" && casePhase !== "STAGED" ? <p className="retrieval-badge" data-state="NOT_REQUIRED">{tr("retrievalNotRequired")}</p> : null}
      {showWriter ? (
        <ReplenishmentForm tr={tr} caseId={caseId} lineId={line.id} location={line.discoveredLocation ?? line.location} currentState={replenishment} compact onSaved={actions.onSaved} />
      ) : null}
      {requestCheck && actions.onRequestCheck ? (
        <div className="check-card-actions">
          <button className="secondary-button" type="button" disabled={Boolean(actions.busyId)} onClick={() => void actions.onRequestCheck?.(line.id)}>{tr("requestAnotherCheck")}</button>
        </div>
      ) : null}
      {retrievalPending ? retrievalPrompt : null}
      {retrievalPending ? (
        <div className="check-card-actions">
          <button className="secondary-button" type="button" disabled={Boolean(actions.busyId)} onClick={() => actions.onRetrieve(line.id, "FAILED")}>{tr("reportRetrievalFailed")}</button>
          <button className="primary-button" type="button" disabled={Boolean(actions.busyId)} onClick={() => actions.onRetrieve(line.id, "RETRIEVED")}>{tr("confirmRetrieved")}</button>
        </div>
      ) : null}
      {actions.canReportLocation && !isClosed && actions.reportForm(line.id)}
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
