"use client";

import type { MessageKey } from "@/i18n/messages";

export type CaseStatusGroup = "waiting" | "ready" | "done";

export type StatusBadgeTranslator = (key: MessageKey, values?: Record<string, string>) => string;

const READY_STATUSES: Record<string, true> = {
  FOUND: true,
  FOUND_AT_ORIGINAL: true,
  WAITING_RETRIEVAL: true,
  RETRIEVING: true,
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

/**
 * Odoo-style status grouping derived from the existing coded displayStatus /
 * line-state projection. Never a new state enum: unknown codes fall back to
 * the waiting group so the badge never renders free-text status.
 */
export function statusGroupFor(status: string | null | undefined, retrievalState?: string | null): CaseStatusGroup {
  const code = (status || "").toUpperCase();
  if (code === "FOUND" && (retrievalState || "").toUpperCase() === "PENDING") return "ready";
  if (READY_STATUSES[code]) return "ready";
  if (DONE_STATUSES[code]) return "done";
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
  const label = tr(GROUP_LABEL_KEYS[group]);
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
