import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { aggregateCaseDisplayStatus } from "@/domain/case-display-status";
import { CaseStatusBadge } from "@/components/case-status-badge";
import { getMessages, supportedLocales, translate, type Locale } from "@/i18n/messages";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const reversed = <T,>(rows: readonly T[]): T[] => [...rows].reverse();

describe("aggregateCaseDisplayStatus", () => {
  it("keeps CLOSED closed regardless of line states", () => {
    const lines = [
      { id: "l1", state: "OPEN", retrievalState: "NOT_REQUIRED" },
      { id: "l2", state: "CHECKING", retrievalState: "NOT_REQUIRED" },
    ];
    expect(aggregateCaseDisplayStatus("CLOSED", lines)).toBe("CLOSED");
    expect(aggregateCaseDisplayStatus("CLOSED", [])).toBe("CLOSED");
  });

  it("lets a failed retrieval dominate an open sibling in both line orders", () => {
    const lines = [
      { id: "l1", state: "OPEN", retrievalState: "NOT_REQUIRED" },
      { id: "l2", state: "FOUND", retrievalState: "FAILED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", lines)).toBe("RETRIEVAL_FAILED");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(lines))).toBe("RETRIEVAL_FAILED");
  });

  it("never lets a first terminal line mask an unresolved sibling", () => {
    const cases: Array<{ lines: Array<{ id: string; state: string; retrievalState?: string | null }>; expected: string }> = [
      {
        lines: [
          { id: "l1", state: "RESOLVED" },
          { id: "l2", state: "CHECKING" },
        ],
        expected: "CHECKING",
      },
      {
        lines: [
          { id: "l1", state: "CANCELLED" },
          { id: "l2", state: "OPEN" },
        ],
        expected: "OPEN",
      },
      {
        lines: [
          { id: "l1", state: "RESOLVED" },
          { id: "l2", state: "FOUND", retrievalState: "FAILED" },
        ],
        expected: "RETRIEVAL_FAILED",
      },
      {
        lines: [
          { id: "l1", state: "RESOLVED" },
          { id: "l2", state: "FOUND", retrievalState: "PENDING" },
        ],
        expected: "WAITING_RETRIEVAL",
      },
    ];
    for (const { lines, expected } of cases) {
      expect(aggregateCaseDisplayStatus("PICKING", lines)).toBe(expected);
      expect(aggregateCaseDisplayStatus("PICKING", reversed(lines))).toBe(expected);
    }
  });

  it("prefers CHECKING over pending retrieval and failure over CHECKING", () => {
    const checkingPlusPending = [
      { id: "l1", state: "CHECKING" },
      { id: "l2", state: "FOUND", retrievalState: "PENDING" },
    ];
    expect(aggregateCaseDisplayStatus("STAGED", checkingPlusPending)).toBe("CHECKING");
    expect(aggregateCaseDisplayStatus("STAGED", reversed(checkingPlusPending))).toBe("CHECKING");
    const failedPlusChecking = [
      { id: "l1", state: "CHECKING" },
      { id: "l2", state: "FOUND", retrievalState: "FAILED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", failedPlusChecking)).toBe("RETRIEVAL_FAILED");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(failedPlusChecking))).toBe("RETRIEVAL_FAILED");
  });

  it("distinguishes pending from in-progress retrieval", () => {
    expect(
      aggregateCaseDisplayStatus("PICKING", [{ id: "l1", state: "FOUND", retrievalState: "PENDING" }]),
    ).toBe("WAITING_RETRIEVAL");
    expect(
      aggregateCaseDisplayStatus("PICKING", [{ id: "l1", state: "FOUND", retrievalState: "IN_PROGRESS" }]),
    ).toBe("RETRIEVING");
    expect(aggregateCaseDisplayStatus("PICKING", [{ id: "l1", state: "RETRIEVING" }])).toBe("RETRIEVING");
  });

  it("pairs projections by lineId regardless of projection order", () => {
    const lines = [
      { id: "l1", state: "OPEN" },
      { id: "l2", state: "FOUND", retrievalState: "PENDING" },
    ];
    const projections = [
      { lineId: "l2", displayStatus: "FOUND_AT_ORIGINAL" },
      { lineId: "l1", displayStatus: "OPEN" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", lines, projections)).toBe("WAITING_RETRIEVAL");
    expect(aggregateCaseDisplayStatus("PICKING", lines, reversed(projections))).toBe("WAITING_RETRIEVAL");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(lines), projections)).toBe("WAITING_RETRIEVAL");
  });

  it("treats retrieved original-location stock as resolved work, not pending", () => {
    const retrievedAtOriginal = [
      { id: "l1", state: "RESOLVED", displayStatus: "FOUND_AT_ORIGINAL", retrievalState: "RETRIEVED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", retrievedAtOriginal)).toBe("READY_TO_CLOSE");
    expect(
      aggregateCaseDisplayStatus("PICKING", [
        ...retrievedAtOriginal,
        { id: "l2", state: "OPEN", retrievalState: "NOT_REQUIRED" },
      ]),
    ).toBe("OPEN");
  });

  it("requires a terminal main state and ignores stale terminal evidence", () => {
    const cases: Array<{ lines: Array<{ id: string; state?: string | null; displayStatus?: string | null; retrievalState?: string | null }>; expected: string }> = [
      {
        lines: [
          { id: "l1", state: "OPEN", displayStatus: "RESOLVED" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "OPEN",
      },
      {
        lines: [
          { id: "l1", state: "OPEN", retrievalState: "RETRIEVED" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "OPEN",
      },
      {
        lines: [
          { id: "l1", state: "CHECKING", displayStatus: "RESOLVED" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "CHECKING",
      },
      {
        lines: [
          { id: "l1", state: "CHECKING", retrievalState: "RETRIEVED" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "CHECKING",
      },
      {
        lines: [
          { id: "l1", state: "FOUND", displayStatus: "RESOLVED", retrievalState: "PENDING" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "WAITING_RETRIEVAL",
      },
      {
        lines: [
          { id: "l1", state: "FOUND", retrievalState: "RETRIEVED" },
          { id: "l2", state: "RESOLVED" },
        ],
        expected: "WAITING_RETRIEVAL",
      },
    ];
    for (const { lines, expected } of cases) {
      expect(aggregateCaseDisplayStatus("PICKING", lines)).toBe(expected);
      expect(aggregateCaseDisplayStatus("PICKING", reversed(lines))).toBe(expected);
    }
  });

  it("treats OPEN with PENDING retrieval as waiting without a projection", () => {
    const lines = [
      { id: "l1", state: "OPEN", retrievalState: "PENDING" },
      { id: "l2", state: "RESOLVED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", lines)).toBe("WAITING_RETRIEVAL");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(lines))).toBe("WAITING_RETRIEVAL");
  });

  it("ignores positionally mismatched projections and pairs only by lineId", () => {
    const lines = [
      { id: "l1", state: "OPEN" },
      { id: "l2", state: "RESOLVED" },
    ];
    const anonymous = [{ displayStatus: "RESOLVED" }, { displayStatus: "OPEN" }];
    expect(aggregateCaseDisplayStatus("PICKING", lines, anonymous)).toBe("OPEN");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(lines), anonymous)).toBe("OPEN");
    expect(aggregateCaseDisplayStatus("PICKING", lines, reversed(anonymous))).toBe("OPEN");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(lines), reversed(anonymous))).toBe("OPEN");
    const mismatched = [{ lineId: "l2", displayStatus: "FOUND_AT_ORIGINAL" }];
    const pendingLines = [
      { id: "l1", state: "OPEN" },
      { id: "l2", state: "FOUND", retrievalState: "PENDING" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", pendingLines, mismatched)).toBe("WAITING_RETRIEVAL");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(pendingLines), mismatched)).toBe("WAITING_RETRIEVAL");
  });

  it("lets completed-replenishment retrieval obligations suppress raw CHECKING on that line", () => {
    const completedPending = [
      { id: "l1", state: "CHECKING", retrievalState: "PENDING", replenishmentState: "COMPLETED" },
      { id: "l2", state: "RESOLVED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", completedPending)).toBe("WAITING_RETRIEVAL");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(completedPending))).toBe("WAITING_RETRIEVAL");
    const completedInProgress = [
      { id: "l1", state: "CHECKING", retrievalState: "IN_PROGRESS", replenishmentState: "COMPLETED" },
      { id: "l2", state: "RESOLVED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", completedInProgress)).toBe("RETRIEVING");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(completedInProgress))).toBe("RETRIEVING");
    const completedFailed = [
      { id: "l1", state: "CHECKING", retrievalState: "FAILED", replenishmentState: "COMPLETED" },
      { id: "l2", state: "RESOLVED" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", completedFailed)).toBe("RETRIEVAL_FAILED");
    // A sibling with a genuine CHECKING still dominates ordinary pending retrieval.
    const genuineCheckingWins = [
      { id: "l1", state: "CHECKING", retrievalState: "PENDING", replenishmentState: "COMPLETED" },
      { id: "l2", state: "CHECKING" },
    ];
    expect(aggregateCaseDisplayStatus("PICKING", genuineCheckingWins)).toBe("CHECKING");
    expect(aggregateCaseDisplayStatus("PICKING", reversed(genuineCheckingWins))).toBe("CHECKING");
    // Terminal main states stay resolved and are never reopened by a completed marker.
    expect(aggregateCaseDisplayStatus("PICKING", [
      { id: "l1", state: "RESOLVED", retrievalState: "PENDING", replenishmentState: "COMPLETED" },
    ])).toBe("READY_TO_CLOSE");
  });

});

describe("original-location retrieval failure badge (SSR)", () => {
  it("renders the localized retry label in the waiting group in all four languages", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      const html = renderToString(
        createElement(CaseStatusBadge, { status: "FOUND_AT_ORIGINAL", retrievalState: "FAILED", tr }),
      );
      expect(html).toContain(tr("badgeRetryRetrieval"));
      expect(html).toContain("case-status-waiting");
      expect(html).toContain("status-badge-case-waiting");
      expect(html).not.toContain(tr("badgeReadyToRetrieve"));
    }
  });

  it("keeps terminal CLOSED/RESOLVED labels ahead of a failed retrieval", () => {
    const tr = trFor("en");
    const closed = renderToString(createElement(CaseStatusBadge, { status: "CLOSED", retrievalState: "FAILED", tr }));
    expect(closed).toContain(tr("badgeClosed"));
    expect(closed).toContain("case-status-done");
    const resolved = renderToString(
      createElement(CaseStatusBadge, { status: "RESOLVED", retrievalState: "FAILED", tr }),
    );
    expect(resolved).toContain(tr("badgeResolved"));
    expect(resolved).not.toContain(tr("badgeRetryRetrieval"));
  });
});
