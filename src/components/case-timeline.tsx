"use client";

import type { MessageKey } from "@/i18n/messages";

export type CaseTimelineEvent = {
  id: string;
  eventType: string;
  createdAt: string;
  actorName?: string | null;
  completionCode?: string | null;
  discoveredLocation?: string | null;
  originalLocation?: string | null;
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
  const label = completionLabel(event.completionCode, tr);
  if (!label) return tr("timelineSparseCompletion");
  const code = (event.completionCode || "").toUpperCase();
  if (code === "FOUND_AT_ORIGINAL") {
    const at = event.originalLocation
      ? ` ${tr("timelineCompletedAtOriginal", { location: event.originalLocation })}`
      : "";
    return `${label}${at}`;
  }
  if (code === "FOUND") {
    const at = event.discoveredLocation
      ? ` ${tr("timelineCompletedAtNew", { location: event.discoveredLocation })}`
      : "";
    return `${label}${at}`;
  }
  return label;
}

export function timelineLabelFor(event: CaseTimelineEvent, tr: Translator): string {
  if (event.eventType !== "CHECK_COMPLETED") {
    return tr(`event_${event.eventType}` as MessageKey);
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
          <time>{formatDate(entry.createdAt)}</time>
          <span>
            <strong>{entry.who}</strong>
            {entry.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
