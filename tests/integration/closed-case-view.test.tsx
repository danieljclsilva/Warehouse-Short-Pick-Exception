import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DeepCaseView } from "@/components/auth-app";
import { getMessages, supportedLocales, translate, type Locale } from "@/i18n/messages";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const openCase = {
  id: "case-open",
  orderNumber: "100001",
  phase: "PICKING",
  pickerName: "Picker One",
  responsibleName: null,
  closedAt: null,
  resolvedAt: null,
  lines: [{
    id: "line-1",
    location: "01.AA.1",
    originalLocation: "01.AA.1",
    sku: "SKU-1",
    quantity: 2,
    missingQuantity: 2,
    state: "OPEN",
    retrievalState: null,
    discoveredLocation: null,
    reporterName: "Picker One",
    checkerName: "Checker Two",
    retrieverName: null,
    replenishmentState: "WAITING",
    replenishmentNote: "shelf low",
    replenishmentActorName: "Troubleshooter",
    nextActionCode: "RETRIEVE",
    blockingReasonCode: "AWAITING_RETRIEVAL",
  }],
  messages: [{ id: "message-1", message: "looking into it", authorName: "Troubleshooter", createdAt: "2026-09-28T10:00:00Z" }],
};

const closedCase = {
  ...openCase,
  id: "case-closed",
  orderNumber: "100002",
  phase: "CLOSED",
  closedAt: "2026-09-28T11:00:00Z",
  resolvedAt: "2026-09-28T11:00:00Z",
  messages: [{ id: "message-2", message: "resolved earlier", authorName: "Team Leader", createdAt: "2026-09-28T10:30:00Z" }],
};

const headingRef = { current: null };
const lineRef = { current: null };
const noop = () => {};

describe("DeepCaseView closed read-only rendering", () => {
  it("renders the closed badge, every line, and messages without a composer or action controls", () => {
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"), data: closedCase, lineId: "line-1", canViewMessages: true,
      status: "ready", onClose: noop, headingRef, currentLineRef: lineRef,
    }));
    expect(html).toContain("Closed · read-only");
    expect(html).toContain("100002");
    expect(html).toContain("01.AA.1");
    expect(html).toContain("SKU-1");
    expect(html).toContain("Picker One");
    expect(html).toContain("Checker Two");
    expect(html).toContain("Replenishment waiting");
    expect(html).toContain("Retrieve the item");
    expect(html).toContain("Awaiting retrieval");
    expect(html).toContain("resolved earlier");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Claim check");
    expect(html).not.toContain("Complete check");
    expect(html).not.toContain("Record replenishment");
  });

  it("hides message content without VIEW_CASE_MESSAGES", () => {
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"), data: closedCase, lineId: null, canViewMessages: false,
      status: "ready", onClose: noop, headingRef, currentLineRef: lineRef,
    }));
    expect(html).toContain("Closed · read-only");
    expect(html).not.toContain("resolved earlier");
  });

  it("renders the open case without the closed read-only chrome", () => {
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"), data: openCase, lineId: "line-1", canViewMessages: true,
      status: "ready", onClose: noop, headingRef, currentLineRef: lineRef,
    }));
    expect(html).not.toContain("Closed · read-only");
    expect(html).toContain("looking into it");
  });

  it("shows localized denial and missing errors with a back action", () => {
    for (const status of ["forbidden", "missing"] as const) {
      const html = renderToString(createElement(DeepCaseView, {
        tr: trFor("en"), data: null, lineId: null, canViewMessages: false,
        status, onClose: noop, headingRef, currentLineRef: lineRef,
      }));
      expect(html).toContain(status === "forbidden" ? "You do not have access to this case." : "This case could not be found.");
      expect(html).toContain("Back to cases");
    }
  });
});

describe("Integration i18n: four languages with English fallback", () => {
  const keys = ["caseDeepLinkForbidden", "caseClosedBadge", "nextActionREPLENISH", "blockingReasonCASE_CLOSED",
    "analyticsSameLocationTitle", "analyticsSameLocationRateHidden", "analyticsRoleFilter",
    "foundAtOriginalOption", "lineNoKnownNewLocation", "permissionsRoleBoundsHint", "notificationsMarkedAllRead"] as const;

  it("renders every new key in en, nl, pl, and es without blanks", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const key of keys) {
        const text = tr(key);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
    }
  });

  it("never translates operational identifiers", () => {
    const samples: Array<{ orderNumber: string; location: string; sku: string }> = [
      { orderNumber: "100002", location: "01.AA.1", sku: "SKU-1" },
    ];
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      const html = renderToString(createElement(DeepCaseView, {
        tr, data: closedCase, lineId: "line-1", canViewMessages: false,
        status: "ready", onClose: noop, headingRef, currentLineRef: lineRef,
      }));
      for (const sample of samples) {
        expect(html).toContain(sample.orderNumber);
        expect(html).toContain(sample.location);
        expect(html).toContain(sample.sku);
      }
    }
  });

  it("falls back to English for unknown locales", () => {
    const { messages } = getMessages("fr");
    expect(translate(messages, "caseDeepLinkForbidden")).toBe(trFor("en")("caseDeepLinkForbidden"));
  });
});

describe("Timeline completion codes (appended)", () => {
  it("renders every new timeline/badge key in en, nl, pl, and es without blanks", () => {
    const keys = [
      "timelineResolutionFOUND", "timelineResolutionFOUND_AT_ORIGINAL", "timelineResolutionNOT_FOUND",
      "timelineResolutionWRONG_LOCATION", "timelineResolutionOTHER", "timelineResolutionUnknown",
      "timelineCompletedAtOriginal", "timelineCompletedAtNew", "timelineSparseCompletion",
      "badgeStatusWaiting", "badgeStatusReady", "badgeStatusDone",
      "timelineCaseStatusLabel", "timelineLineStatusLabel",
    ] as const;
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const key of keys) {
        const text = tr(key);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
      // Location placeholders interpolate real location codes (never translated away).
      expect(tr("timelineCompletedAtNew", { location: "02.BB.2" })).toContain("02.BB.2");
    }
  });
});
