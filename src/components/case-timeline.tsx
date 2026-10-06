"use client";

import type { MessageKey } from "@/i18n/messages";

export type CaseTimelineEvent = {
  id: string;
  eventType: string;
  createdAt: string;
  actorName?: string | null;
  assigneeName?: string | null;
  completionCode?: string | null;
  discoveredLocation?: string | null;
  originalLocation?: string | null;
  resultMessage?: string | null;
};

export type CaseTimelineMessage = {
  id: string;
  message: string;
  createdAt: string;
  authorName: string;
};

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

const COMPLETION_LABEL_KEYS: Record<string, MessageKey> = {
  FOUND: "timelineResolutionFOUND",
  FOUND_AT_ORIGINAL: "timelineResolutionFOUND_AT_ORIGINAL",
  NOT_FOUND: "timelineResolutionNOT_FOUND",
  WRONG_LOCATION: "timelineResolutionWRONG_LOCATION",
  OTHER: "timelineResolutionOTHER",
};

function completionLabel(code: string | null | undefined, tr: Translator): string | null {
  const normalized = (code || "").toUpperCase();
  const key = COMPLETION_LABEL_KEYS[normalized];
  return key ? tr(key) : null;
}

/**
 * Renders one CHECK_COMPLETED row: localized resolution label plus the
 * discovered/original location context already on the event. Sparse legacy
 * events (no code at all) fall back to a truthful "no details recorded"
 * sentence — never invented values.
 */
export function checkCompletedDetail(event: CaseTimelineEvent, tr: Translator): string {
  const note = event.resultMessage && event.resultMessage.trim()
    ? ` — ${tr("timelineResultNote", { message: event.resultMessage.trim() })}`
    : "";
  const label = completionLabel(event.completionCode, tr);
  if (!label) return `${tr("timelineSparseCompletion")}${note}`;
  const code = (event.completionCode || "").toUpperCase();
  if (code === "FOUND_AT_ORIGINAL") {
    const at = event.originalLocation
      ? ` ${tr("timelineCompletedAtOriginal", { location: event.originalLocation })}`
      : "";
    return `${label}${at}${note}`;
  }
  if (code === "FOUND") {
    const at = event.discoveredLocation
      ? ` ${tr("timelineCompletedAtNew", { location: event.discoveredLocation })}`
      : "";
    return `${label}${at}${note}`;
  }
  return `${label}${note}`;
}
const ASSIGNMENT_TYPES = new Set(["CHECK_ASSIGNED", "CHECK_REASSIGNED", "CHECK_CLAIMED", "RETRIEVAL_ASSIGNED", "RESPONSIBILITY_CHANGED", "CASE_REOPENED", "CASE_REPAIRED", "CHECK_REQUESTED", "CASE_CREATED"]);

export function timelineLabelFor(event: CaseTimelineEvent, tr: Translator): string {
  if (event.eventType !== "CHECK_COMPLETED") {
    const base = tr(`event_${event.eventType}` as MessageKey);
    if (ASSIGNMENT_TYPES.has((event.eventType || "").toUpperCase()) && event.assigneeName) {
      return `${base} — ${tr("timelineAssignedTo", { name: event.assigneeName })}`;
    }
    return base;
  }
  return `${tr("event_CHECK_COMPLETED")} — ${checkCompletedDetail(event, tr)}`;
}

export function CaseTimeline({
  events,
  messages,
  tr,
  formatDate,
  className = "case-shared-timeline",
}: {
  events: CaseTimelineEvent[];
  messages: CaseTimelineMessage[];
  tr: Translator;
  formatDate: (value: string) => string;
  className?: string;
}) {
  const rows = [
    ...events
      .filter((event) => event.eventType !== "CASE_MESSAGE_ADDED")
      .map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        who: event.actorName || tr("systemActor"),
        text: timelineLabelFor(event, tr),
        kind: "event" as const,
      })),
    ...messages.map((message) => ({
      id: message.id,
      createdAt: message.createdAt,
      who: message.authorName,
      text: message.message,
      kind: "message" as const,
    })),
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return (
    <ol className={className} data-testid="case-shared-timeline">
      {rows.map((entry) => (
        <li key={entry.id} data-testid={entry.kind === "event" ? "timeline-event" : "timeline-message"}>
          <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
          <span className="timeline-row">
            <strong data-testid="timeline-actor">{entry.who}</strong>
            <span data-testid="timeline-text">{entry.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
