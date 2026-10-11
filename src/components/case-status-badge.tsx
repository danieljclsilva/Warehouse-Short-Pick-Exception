"use client";

import type { MessageKey } from "@/i18n/messages";

export type CaseStatusGroup = "waiting" | "ready" | "done";

export type StatusBadgeTranslator = (key: MessageKey, values?: Record<string, string>) => string;

const READY_STATUSES: Record<string, true> = {
  FOUND: true,
  FOUND_AT_ORIGINAL: true,
  WAITING_RETRIEVAL: true,
  RETRIEVING: true,
  RETRIEVAL_PENDING: true,
  READY_TO_CLOSE: true,
};

const DONE_STATUSES: Record<string, true> = {
  RESOLVED: true,
  RETRIEVED: true,
  CLOSED: true,
  CANCELLED: true,
};

const GROUP_LABEL_KEYS: Record<CaseStatusGroup, MessageKey> = {
  waiting: "badgeStatusWaiting",
  ready: "badgeStatusReady",
  done: "badgeStatusDone",
};

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  OPEN: "badgeWaitingCheck",
  CHECKING: "badgeCheckInProgress",
  FOUND: "badgeReadyToRetrieve",
  FOUND_AT_ORIGINAL: "badgeReadyToRetrieve",
  WAITING_RETRIEVAL: "badgeReadyToRetrieve",
  RETRIEVAL_PENDING: "badgeReadyToRetrieve",
  RETRIEVAL_FAILED: "badgeRetryRetrieval",
  RETRIEVING: "badgeRetrievalInProgress",
  NOT_FOUND: "badgeCheckAgain",
  WRONG_LOCATION: "badgeCheckAgain",
  TROUBLESHOOTING: "badgeNeedsFollowUp",
  RESOLVED: "badgeResolved",
  READY_TO_CLOSE: "badgeReadyToClose",
  RETRIEVED: "badgeRetrieved",
  CLOSED: "badgeClosed",
  CANCELLED: "badgeCancelled",
};

/**
 * Odoo-style status grouping derived from the existing coded displayStatus /
 * line-state projection. Never a new state enum: unknown codes fall back to
 * the waiting group so the badge never renders free-text status.
 */
export function statusGroupFor(status: string | null | undefined, retrievalState?: string | null): CaseStatusGroup {
  const code = (status || "").toUpperCase();
  // Terminal codes keep their done group even when a retrieval failed.
  if (DONE_STATUSES[code]) return "done";
  // A failed retrieval is waiting/error work, never ready — including the
  // original-location code whose display status names the found location.
  if ((retrievalState || "").toUpperCase() === "FAILED") return "waiting";
  if (code === "FOUND" && (retrievalState || "").toUpperCase() === "PENDING") return "ready";
  if (READY_STATUSES[code]) return "ready";
  return "waiting";
}

export function CaseStatusBadge({
  status,
  retrievalState,
  tr,
  kind = "case",
}: {
  status: string;
  retrievalState?: string | null;
  tr: StatusBadgeTranslator;
  kind?: "case" | "line";
}) {
  const group = statusGroupFor(status, retrievalState);
  const code = (status || "").toUpperCase();
  const retrievalFailed = (retrievalState || "").toUpperCase() === "FAILED";
  // FAILED dominates retrieved-location display codes; terminal codes keep
  // their own resolved/cancelled label via the status lookup below.
  const retryable = ["FOUND", "FOUND_AT_ORIGINAL", "WAITING_RETRIEVAL", "RETRIEVAL_PENDING"].includes(code);
  const labelKey = retrievalFailed && retryable && !DONE_STATUSES[code]
    ? "badgeRetryRetrieval"
    : STATUS_LABEL_KEYS[code] ?? GROUP_LABEL_KEYS[group];
  const label = tr(labelKey);
  const ariaKey: MessageKey = kind === "line" ? "timelineLineStatusLabel" : "timelineCaseStatusLabel";
  return (
    <span
      className={`case-status-badge case-status-${group}`}
      data-testid={`status-badge-${kind}-${group}`}
      aria-label={`${tr(ariaKey)}: ${label}`}
    >
      {label}
    </span>
  );
}
