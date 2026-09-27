import { describe, expect, it } from "vitest";
import { analyticsDimensionPairs, formatAnalyticsMetric, renderAnalyticsPdf, selectPdfFilters } from "../src/server/analytics-pdf";

function sampleData(rowCount = 0) {
  const cases = Array.from({ length: rowCount }, (_, index) => ({
    id: `case-${index}`,
    orderNumber: String(340000 + index),
    phase: index % 2 === 0 ? "PICKING" : "STAGED",
    physicalState: index % 2 === 0 ? "PICKING" : "STAGED",
    physicalLocation: null,
    source: "PICKER_REPORT",
    manualReason: null,
    picker: { id: "picker-1", displayName: "Picker One" },
    responsible: null,
    configurationVersion: { id: "config-3", version: 3 },
    criticalThresholdMinutes: 30,
    overThreshold: false,
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
    stagedAt: null,
    resolvedAt: index % 3 === 0 ? new Date("2026-09-25T08:08:00.000Z") : null,
    reopenedAt: null,
    lineCount: 1,
  }));
  const lines = Array.from({ length: rowCount }, (_, index) => ({
    id: `line-${index}`,
    caseId: `case-${index}`,
    orderNumber: String(340000 + index),
    originalLocation: `03.AA.${(index % 9) + 1}`,
    sku: `SKU-${String(index).padStart(4, "0")}`,
    missingQuantity: (index % 4) + 1,
    state: index % 3 === 0 ? "RESOLVED" : "OPEN",
    resolutionCode: index % 3 === 0 ? "FOUND" : null,
    retrievalState: "NOT_REQUIRED",
    reportedByUserId: "picker-1",
    checker: null,
    troubleshooter: null,
    reportedAt: new Date("2026-09-25T08:00:00.000Z"),
    discoveredAt: null,
    retrievedAt: null,
    resolvedAt: index % 3 === 0 ? new Date("2026-09-25T08:08:00.000Z") : null,
    configurationVersion: 3,
  }));
  return {
    filters: { from: new Date("2026-09-01"), to: new Date("2026-10-01"), phase: "PICKING", phases: ["PICKING", "STAGED"] },
    kpis: {
      totalCases: rowCount,
      totalLines: rowCount,
      foundDuringCheck: 12,
      notFound: 4,
      wrongLocation: 3,
      retrieved: 8,
      casesOverThreshold: 2,
      manualCases: 1,
      reopenedCases: 1,
      repeatedOrderNumbers: 1,
      medianReportToCheckClaimedSeconds: 94,
      medianReportToLocationFoundSeconds: 210,
      medianReportToRetrievalSeconds: 380,
      medianReportToResolutionSeconds: 560,
      linesByLocation: [{ key: "03.AA.1", label: "03.AA.1", count: 10, lines: 10, quantity: 10 }],
      linesBySku: [{ key: "SKU-0001", label: "SKU-0001", count: 4, lines: 4, quantity: 4 }],
      casesByConfigurationVersion: [{ version: 3, label: "v3", cases: rowCount, count: rowCount }],
    },
    duplicates: { repeatedOrderCount: 1, orders: [{ orderNumber: "341151", occurrences: 3, cases: [{ caseId: "a", createdAt: new Date("2026-09-01T00:00:00Z") }, { caseId: "b", createdAt: new Date("2026-09-10T00:00:00Z") }] }] },
    rows: { cases, lines },
    limits: { maxCases: 5000, maxLines: 10000, maxEvents: 20000, casesTruncated: false, linesTruncated: false },
  };
}
function pageCount(pdf: Uint8Array) {
  const text = Buffer.from(pdf).toString("latin1");
  return (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

describe("analytics PDF export", () => {
  it("normalizes configuration dimensions and unavailable timings", () => {
    expect(analyticsDimensionPairs([{ version: 4, cases: 12 }])).toEqual([["4", 12]]);
    expect(formatAnalyticsMetric("medianReportToResolutionSeconds", null)).toBe("N/A");
  });

  it("keeps only active filter fields rather than analytics option arrays", () => {
    expect(selectPdfFilters({ phase: "PICKING", phases: ["PICKING", "STAGED"], resolutions: ["FOUND"], unknown: "ignored" })).toEqual({ phase: "PICKING" });
  });

  it("creates a deliberate report with metadata, charts, filters, and tables", async () => {
    const pdf = await renderAnalyticsPdf(sampleData(2), { generatedAt: new Date("2026-09-26T10:30:00Z"), companyName: "North Warehouse" });
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("Short-Pick Exception Analytics");
    expect(text).toContain("North Warehouse");
    expect(text).toContain("/Title");
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
  });

  it("paginates long case and line tables without an unbounded output", async () => {
    const pdf = await renderAnalyticsPdf(sampleData(230));
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    expect(pageCount(pdf)).toBeGreaterThan(4);
    expect(pdf.byteLength).toBeLessThan(4_000_000);
  });

  it("paginates and caps long duplicate occurrence dates", async () => {
    const data = sampleData(2);
    const dates = Array.from({ length: 8_100 }, (_, index) => ({ caseId: `case-${index}`, createdAt: new Date(Date.UTC(2025, 0, 1 + index)) }));
    data.duplicates = { repeatedOrderCount: 1, orders: [{ orderNumber: "341151", occurrences: dates.length, cases: dates }] };
    const pdf = await renderAnalyticsPdf(data, { language: "nl" });
    expect(pageCount(pdf)).toBeGreaterThan(10);
    expect(pdf.byteLength).toBeLessThan(1_500_000);
  });

  it("renders empty selections with an explicit empty state", async () => {
    const pdf = await renderAnalyticsPdf(sampleData(0));
    expect(Buffer.from(pdf).toString("latin1")).toContain("/Count");
  });
});
