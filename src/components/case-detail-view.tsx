"use client";

import type { ReactNode, RefObject } from "react";
import type { MessageKey } from "@/i18n/messages";
import { CaseTimeline, type CaseTimelineEvent, type CaseTimelineMessage } from "@/components/case-timeline";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

export function CaseDetailView({
  tr,
  id,
  tabIndex,
  panelRef,
  className = "",
  titleId,
  headingRef,
  orderNumber,
  phaseLabel,
  headingActions,
  summary,
  lines,
  linesClassName,
  showLinesHeading = false,
  afterLines,
  events,
  messages = [],
  formatTimestamp,
  timelinePagination,
  messageComposer,
  showTimeline = true,
  afterTimeline,
}: {
  tr: Translator;
  id?: string;
  tabIndex?: number;
  panelRef?: RefObject<HTMLElement | null>;
  className?: string;
  titleId: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  orderNumber: string;
  phaseLabel: string;
  headingActions?: ReactNode;
  summary?: ReactNode;
  lines: ReactNode;
  linesClassName: string;
  showLinesHeading?: boolean;
  afterLines?: ReactNode;
  events: CaseTimelineEvent[];
  messages?: CaseTimelineMessage[];
  formatTimestamp: (value: string) => string;
  timelinePagination?: ReactNode;
  messageComposer?: ReactNode;
  showTimeline?: boolean;
  afterTimeline?: ReactNode;
}) {
  return (
    <section
      ref={panelRef}
      id={id}
      tabIndex={tabIndex}
      className={`case-detail-view${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
    >
      <header className="case-detail-heading">
        <div>
          <p className="case-eyebrow">{tr("orderLabel")}</p>
          <h2 id={titleId} ref={headingRef}>{orderNumber}</h2>
        </div>
        {headingActions ?? <span className="case-badges"><span className="case-phase">{phaseLabel}</span></span>}
      </header>
      {summary}
      {showLinesHeading ? <h3 className="case-detail-section-title">{tr("reportedItems")}</h3> : null}
      <div className={linesClassName} aria-label={tr("reportedItems")}>{lines}</div>
      {afterLines}
      {showTimeline ? (
        <section className="case-timeline-section" aria-label={tr("caseTimeline")}>
          <h3>{tr("caseTimeline")}</h3>
          <CaseTimeline events={events} messages={messages} tr={tr} formatDate={formatTimestamp} className="case-shared-timeline" />
          {timelinePagination}
          {messageComposer}
        </section>
      ) : null}
      {afterTimeline}
    </section>
  );
}
