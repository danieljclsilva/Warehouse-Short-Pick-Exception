import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { getMessages, supportedLocales, translate, type Locale } from "@/i18n/messages";
import { CaseStatusBadge, statusGroupFor } from "@/components/case-status-badge";
import { CaseTimeline, checkCompletedDetail } from "@/components/case-timeline";
import { OperationsDashboard } from "@/components/operations-dashboard";
import { PickerWorkflow } from "@/components/picker-workflow";
import { CheckWorkflow } from "@/components/check-workflow";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "event-1",
  eventType: "CHECK_COMPLETED",
  createdAt: "2026-09-28T10:00:00.000Z",
  actorName: "Checker One",
  ...overrides,
});

const messages = [{ id: "message-1", message: "looking into it", authorName: "Troubleshooter", createdAt: "2026-09-28T10:05:00.000Z" }];

describe("timeline completion-code rendering", () => {
  it("renders FOUND_AT_ORIGINAL distinctly from FOUND with location context", () => {
    const tr = trFor("en");
    const atOriginal = checkCompletedDetail(event({ completionCode: "FOUND_AT_ORIGINAL", originalLocation: "01.AA.1" }), tr);
    const atNew = checkCompletedDetail(event({ completionCode: "FOUND", discoveredLocation: "02.BB.2" }), tr);
    expect(atOriginal).toContain(tr("timelineResolutionFOUND_AT_ORIGINAL"));
    expect(atOriginal).toContain("01.AA.1");
    expect(atNew).toContain(tr("timelineResolutionFOUND"));
    expect(atNew).toContain("02.BB.2");
    expect(atOriginal).not.toBe(atNew);
  });

  it("renders every resolution code localized in all four languages", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const code of ["FOUND", "FOUND_AT_ORIGINAL", "NOT_FOUND", "WRONG_LOCATION", "OTHER"] as const) {
        const text = checkCompletedDetail(event({ completionCode: code }), tr);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(code);
      }
    }
  });

  it("falls back truthfully for sparse legacy events without inventing values", () => {
    const tr = trFor("en");
    expect(checkCompletedDetail(event({ completionCode: null }), tr)).toBe(tr("timelineSparseCompletion"));
    expect(checkCompletedDetail(event({}), tr)).toBe(tr("timelineSparseCompletion"));
    const sparse = checkCompletedDetail(event({ completionCode: null }), tr);
    expect(sparse).not.toMatch(/[A-Z]{2,}\.\d/);
  });

  it("renders the shared timeline with localized rows and one message row", () => {
    const tr = trFor("en");
    const html = renderToString(
      createElement(CaseTimeline, {
        tr,
        formatDate: (value: string) => value,
        events: [
          event({ id: "e1", completionCode: "FOUND_AT_ORIGINAL", originalLocation: "01.AA.1" }),
          { id: "e2", eventType: "CASE_MESSAGE_ADDED", createdAt: "2026-09-28T10:01:00.000Z", actorName: "System" },
        ],
        messages,
      }),
    );
    expect(html).toContain(tr("timelineResolutionFOUND_AT_ORIGINAL"));
    expect(html).toContain("01.AA.1");
    expect(html).toContain("looking into it");
    expect(html.match(/timeline-message/g)?.length ?? 0).toBe(1);
  });
});

describe("status badges", () => {
  it("groups coded statuses into waiting / ready / done", () => {
    expect(statusGroupFor("OPEN")).toBe("waiting");
    expect(statusGroupFor("CHECKING")).toBe("waiting");
    expect(statusGroupFor("TROUBLESHOOTING")).toBe("waiting");
    expect(statusGroupFor("NOT_FOUND")).toBe("waiting");
    expect(statusGroupFor("WRONG_LOCATION")).toBe("waiting");
    expect(statusGroupFor("FOUND")).toBe("ready");
    expect(statusGroupFor("FOUND_AT_ORIGINAL")).toBe("ready");
    expect(statusGroupFor("RETRIEVING")).toBe("ready");
    expect(statusGroupFor("FOUND", "PENDING")).toBe("ready");
    expect(statusGroupFor("RESOLVED")).toBe("done");
    expect(statusGroupFor("RETRIEVED")).toBe("done");
    expect(statusGroupFor("CLOSED")).toBe("done");
    expect(statusGroupFor("CANCELLED")).toBe("done");
    expect(statusGroupFor("SOMETHING_NEW")).toBe("waiting");
  });

  it("renders the stable CSS class per group in all four languages", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const [status, group] of [["OPEN", "waiting"], ["FOUND", "ready"], ["RESOLVED", "done"]] as const) {
        const html = renderToString(createElement(CaseStatusBadge, { status, tr }));
        expect(html).toContain(`case-status-${group}`);
        expect(html).toContain(`status-badge-case-${group}`);
        expect(html).not.toBe(status);
      }
    }
  });
});

describe("timeline surfaces render badges and codes", () => {
  const dashboardProps = {
    locale: "en",
    canCreateManual: false,
    canMessage: false,
    canAssign: false,
    canClose: false,
    canReopen: false,
    canChangePhase: false,
  } as const;

  it("dashboard renders (case cards fetch client-side; badge unit covered separately)", () => {
    const html = renderToString(createElement(OperationsDashboard, { ...dashboardProps, tr: trFor("en") }));
    expect(html).toContain("Operations dashboard");
    expect(html).not.toContain("status-badge-case-");
  });

  it("picker detail timeline section is wired to the shared timeline", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/components/picker-workflow.tsx", import.meta.url)), "utf8");
    expect(source).toContain("case-timeline-section");
    expect(source).toContain("<CaseTimeline");
  });

  it("picker My Work and check views render without crashing", () => {
    const picker = renderToString(
      createElement(PickerWorkflow, {
        userId: "u1",
        locale: "en",
        tr: trFor("en"),
        canReportShortPick: true,
        canViewOwnCases: false,
        canOverrideDuplicateLine: false,
        canStage: false,
        canConfirmRetrieval: false,
        canClose: false,
      }),
    );
    expect(picker).toContain("picker-workflow");
    const checks = renderToString(
      createElement(CheckWorkflow, {
        locale: "en",
        tr: trFor("en"),
        canViewAvailable: false,
        canClaim: false,
        canComplete: false,
        canAssign: false,
        canReassign: false,
        canRetrieve: false,
        canMessage: false,
      }),
    );
    expect(checks).toContain("check-workflow");
  });
});

describe("badge and timeline CSS (390px)", () => {
  const ruleBody = (css: string, selector: string): string => {
    const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"));
    if (!match) throw new Error(`missing CSS rule: ${selector}`);
    return match[1]!;
  };
  it("wraps badge rows with no overflow at 390px", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");
    const badge = ruleBody(css, "\\.case-status-badge");
    expect(badge).toMatch(/max-width:\s*100%/);
    expect(badge).toMatch(/overflow-wrap:\s*anywhere/);
    expect(badge).not.toMatch(/overflow:\s*hidden/);
    const row = ruleBody(css, "\\.case-badges");
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    const timeline = ruleBody(css, "\\.case-shared-timeline li");
    expect(timeline).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
