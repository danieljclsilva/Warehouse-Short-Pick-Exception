import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_ERROR_LOG_URL", "https://example.com/exec");
const { ErrorLogUserScope, ErrorLogPrompt } = await import("@/components/error-log-reminders");
const { CaseDetailView } = await import("@/components/case-detail-view");
afterAll(() => vi.unstubAllEnvs());
const tr = (key: string) => key;
const name = "Zoë & Łukasz + Ana";
const entry = { caseId: "case-1", orderNumber: "123", items: [{ location: "01.AA.1", sku: "X" }] };
function linkedName(child: ReactNode, displayName?: string) {
  const html = renderToStaticMarkup(<ErrorLogUserScope userId="user-1" displayName={displayName}>{child}</ErrorLogUserScope>);
  const href = html.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
  return new URL(href).searchParams.get("by");
}
it("uses the signed-in display name in the report prompt", () => {
  const prompt = createElement(ErrorLogPrompt, { tr, entry, onDone: () => {} });
  expect(linkedName(prompt, name)).toBe(name);
  expect(linkedName(prompt, "Another user")).toBe("Another user");
  expect(linkedName(prompt)).toBeNull();
});
it("uses the actor's name for the shared case link without changing case data", () => {
  const detail = createElement(CaseDetailView, {
    tr, titleId: "case-title", orderNumber: entry.orderNumber, phaseLabel: "Picking", lines: [], linesClassName: "lines", events: [],
    formatTimestamp: (value: string) => value, showTimeline: false, errorLog: { caseId: entry.caseId, items: entry.items },
  });
  expect(linkedName(detail, name)).toBe(name);
  expect(linkedName(detail)).toBeNull();
});
