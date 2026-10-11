import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, supportedLocales, translate, type Locale } from "@/i18n/messages";
import { SharedCaseLineCard } from "@/components/case-line-card";
import { ReplenishmentForm } from "@/components/replenishment-form";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const line = (overrides: Record<string, unknown> = {}) => ({
  id: "line-1",
  location: "01.AA.1",
  sku: "SKU-1",
  quantity: 1,
  state: "OPEN",
  ...overrides,
});

const idleActions = (overrides: Record<string, unknown> = {}) => ({
  canRecordReplenishment: true,
  canRetrieve: false,
  canReportLocation: false,
  busyId: "",
  onSaved: () => {},
  onRetrieve: () => {},
  reportForm: () => null,
  ...overrides,
});

describe("workflow forms corrections", () => {
  it("grants control the replenishment writer (manager sees it, ungranted picker does not)", () => {
    const tr = trFor("en");
    const granted = renderToString(
      createElement(SharedCaseLineCard, {
        tr, caseId: "case-1", casePhase: "PICKING", line: line(), projections: new Map(), actions: idleActions({ canRecordReplenishment: true }),
      }),
    );
    // Compact placement renders collapsed; the grant gates the action button.
    expect(granted).toContain(tr("replenishmentAction"));
    const denied = renderToString(
      createElement(SharedCaseLineCard, {
        tr, caseId: "case-1", casePhase: "PICKING", line: line(), projections: new Map(), actions: idleActions({ canRecordReplenishment: false }),
      }),
    );
    expect(denied).not.toContain(tr("replenishmentAction"));
  });

  it("completed replenishment obligation on a non-FOUND line still shows retry/retrieve when granted", () => {
    const tr = trFor("en");
    const html = renderToString(
      createElement(SharedCaseLineCard, {
        tr,
        caseId: "case-1",
        casePhase: "PICKING",
        line: line({ state: "OPEN", retrievalState: "FAILED", replenishmentState: "COMPLETED" }),
        projections: new Map(),
        actions: idleActions({ canRetrieve: true }),
        retrievalPrompt: createElement("p", null, "retry prompt"),
      }),
    );
    expect(html).toContain("Could not retrieve");
    expect(html).toContain("Confirm retrieved");
  });

  it("CLOSED lines are read-only: no writer, no request-check, no retrieve", () => {
    const tr = trFor("en");
    const html = renderToString(
      createElement(SharedCaseLineCard, {
        tr,
        caseId: "case-1",
        casePhase: "CLOSED",
        line: line({ state: "FOUND", retrievalState: "PENDING", replenishmentState: "NONE" }),
        projections: new Map([["line-1", {
          lineId: "line-1", displayStatus: "FOUND", replenishment: null, nextActionCode: "REQUEST_CHECK", actionOwnerName: null, blockingReasonCode: "NO_ACTIVE_CHECK",
        }]]),
        actions: idleActions({ canRetrieve: true, canRequestCheck: true, onRequestCheck: () => {} }),
      }),
    );
    expect(html).not.toContain("replenishment-form");
    expect(html).not.toContain("Request another check");
    expect(html).not.toContain("Confirm retrieved");
  });

  it("request-check appears only for DTO REQUEST_CHECK with the grant, and completed replenishment never requests", () => {
    const tr = trFor("en");
    const projection = new Map([["line-1", {
      lineId: "line-1", displayStatus: "OPEN", replenishment: null, nextActionCode: "REQUEST_CHECK", actionOwnerName: null, blockingReasonCode: "NO_ACTIVE_CHECK",
    }]]);
    const granted = renderToString(
      createElement(SharedCaseLineCard, {
        tr, caseId: "case-1", casePhase: "PICKING", line: line(), projections: projection,
        actions: idleActions({ canRecordReplenishment: false, canRequestCheck: true, onRequestCheck: () => {} }),
      }),
    );
    expect(granted).toContain("Request another check");
    const ungranted = renderToString(
      createElement(SharedCaseLineCard, {
        tr, caseId: "case-1", casePhase: "PICKING", line: line(), projections: projection,
        actions: idleActions({ canRecordReplenishment: false, canRequestCheck: false, onRequestCheck: () => {} }),
      }),
    );
    expect(ungranted).not.toContain("Request another check");
    const completed = renderToString(
      createElement(SharedCaseLineCard, {
        tr, caseId: "case-1", casePhase: "PICKING", line: line({ replenishmentState: "COMPLETED" }), projections: projection,
        actions: idleActions({ canRecordReplenishment: false, canRequestCheck: true, onRequestCheck: () => {} }),
      }),
    );
    expect(completed).not.toContain("Request another check");
  });

  it("keeps the completed success visible across the COMPLETED prop change (no early return before notice)", () => {
    const source = read("../src/components/replenishment-form.tsx");
    expect(source).toContain('if (normalized === "COMPLETED" && !success) return null');
    expect(source).not.toMatch(/if \(normalized === "COMPLETED"\) return null/);
  });

  it("form posts note + retrieverUserId against the paginated directory, without the admin list", () => {
    const source = read("../src/components/replenishment-form.tsx");
    expect(source).toContain("retrieverUserId");
    expect(source).toContain("note");
    expect(source).toContain("maxLength={NOTE_MAX_LENGTH}");
    expect(source).toContain("/api/users/directory?caseId=");
    expect(source).toContain("&lineId=");
    expect(source).not.toContain("/api/admin/users");
    expect(source).not.toContain("JSON.stringify({ state })");
  });

  it("picker grant flows to the shared card and request-check posts the checks route", () => {
    const picker = read("../src/components/picker-workflow.tsx");
    expect(picker).toContain("canRecordReplenishment,");
    expect(picker).not.toContain("canRecordReplenishment: false");
    const dashboard = read("../src/components/operations-dashboard.tsx");
    expect(dashboard).toContain("canRequestCheck");
    expect(dashboard).toContain("/lines/${lineId}/checks");
    const checks = read("../src/components/check-workflow.tsx");
    expect(checks).toContain("nextActionCode");
    expect(checks).toContain("rawProjections");
  });

  it("localizes note/selector labels, request-check, and action codes in EN/NL/PL/ES", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const key of [
        "replenishmentNoteLabel",
        "replenishmentRetrieverLabel",
        "replenishmentAutoOwnerOption",
        "replenishmentLoadMore",
        "replenishmentDirectoryFailed",
        "replenishmentCompletedPending",
        "replenishmentCompletedUnassigned",
        "replenishmentWaitingSaved",
        "replenishmentNoOwnerError",
        "requestAnotherCheck",
        "requestCheckSaved",
        "requestCheckFailed",
        "nextActionREQUEST_CHECK",
        "blockingReasonNO_ACTIVE_CHECK",
        "navInstructionRequestCheck",
      ] as const) {
        const text = tr(key);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
      expect(tr("replenishmentCompletedPending", { name: "Ada", location: "01.AA.1" })).toContain("Ada");
      expect(tr("replenishmentCompletedPending", { name: "Ada", location: "01.AA.1" })).toContain("01.AA.1");
    }
  });

  it("renders the note textarea and retriever selector labels server-side", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      const html = renderToString(
        createElement(ReplenishmentForm, { tr, caseId: "case-1", lineId: "line-1", currentState: "NONE", onSaved: () => {} }),
      );
      expect(html).toContain(tr("replenishmentNoteLabel"));
      expect(html).toContain(tr("replenishmentRetrieverLabel"));
      expect(html).toContain('maxLength="500"');
    }
  });

  it("renders projection note/actor metadata on the line badge", () => {
    const tr = trFor("en");
    const html = renderToString(
      createElement(SharedCaseLineCard, {
        tr,
        caseId: "case-1",
        casePhase: "PICKING",
        line: line({ replenishmentState: "WAITING" }),
        projections: new Map([["line-1", {
          lineId: "line-1", displayStatus: "OPEN",
          replenishment: { state: "WAITING", note: "waiting on truck", actorName: "Ada", at: null },
          nextActionCode: null, actionOwnerName: null, blockingReasonCode: null,
        }]]),
        actions: idleActions({ canRecordReplenishment: false }),
      }),
    );
    expect(html).toContain("waiting on truck");
    expect(html).toContain("Ada");
  });
});
