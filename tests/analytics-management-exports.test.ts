import { describe, expect, it } from "vitest";
import type { AnalyticsManagement } from "@/domain/analytics-management";
import { normalizeManagement, periodChange } from "@/domain/analytics-management";
import { managementAnalyticsCsv } from "@/server/analytics-management-csv";
import { renderAnalyticsPdf } from "@/server/analytics-pdf";

function fixture(): AnalyticsManagement {
  return {
    comparison: {
      current: { from: "2026-10-01T00:00:00Z", toExclusive: "2026-10-12T00:00:00Z", cases: 3, lines: 4, resolvedCases: 3 },
      previous: { from: "2026-09-20T00:00:00Z", toExclusive: "2026-10-01T00:00:00Z", cases: 0, lines: 0, resolvedCases: 1 },
      changes: { cases: periodChange(3,0), lines: periodChange(4,0), resolvedCases: periodChange(3,1) },
    },
    backlog: { asOf: "2026-10-12T08:00:00Z", totalOpen: 5001, picking: 5000, staged: 1, unassignedStaged: 1, oldestCreatedAt: "2026-01-01T08:00:00Z",
      evaluatedCases: 5000, truncated: true, overThreshold: 4999, aging: { under24h: 1, h24to72: 0, h72to168: 0, over168h: 4999 } },
    lifetimeRecurrence: { asOf: "2026-10-12T08:00:00Z", repeatedOrderCount: 1, groupsTruncated: false, datesTruncated: true,
      orders: [{ orderNumber: "341151", occurrences: 5001, selectedPeriodOccurrences: 1, firstSeenAt: "2026-01-01T08:00:00Z", lastSeenAt: "2026-10-05T08:00:00Z",
        datesTruncated: true, cases: [{ caseId: "history-one", createdAt: "2026-01-01T08:00:00Z" }] }] },
  };
}
describe("management export scope and completeness",()=>{
  it("leaves a zero-baseline percentage blank and exports exact counts with explicit scope",()=>{
    const csv=managementAnalyticsCsv(fixture());
    expect(csv).toContain("comparison_current,cases,3,0,3,,2026-10-01T00:00:00Z,2026-10-12T00:00:00Z");
    expect(csv).toContain("warehouse_backlog,totalOpen,5001");
    expect(csv).toContain("lifetime_recurrence,occurrences,5001");
    expect(csv).toContain("history-one");
    expect(csv).not.toMatch(/NaN|Infinity/);
  });
  it("omits capped age estimates instead of exporting them as warehouse totals",()=>{
    const data=fixture();
    expect(managementAnalyticsCsv(data)).not.toContain("warehouse_backlog_aging");
    expect(managementAnalyticsCsv(data)).not.toContain("warehouse_backlog,overThreshold");
    data.backlog.truncated=false;
    expect(managementAnalyticsCsv(data)).toContain("warehouse_backlog_aging");
    expect(managementAnalyticsCsv(data)).toContain("warehouse_backlog,overThreshold,4999");
  });
  it("accepts a serialized server payload and rejects missing sections instead of fabricated zeros",()=>{
    expect(normalizeManagement(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture());
    expect(normalizeManagement({ comparison: {} })).toBeUndefined();
  });
  it.each(["en","nl","pl","es"])("renders zero baselines, capped ages and lifetime history in %s PDF",async(language)=>{
    const pdf=await renderAnalyticsPdf({management:fixture(),rows:{cases:[],lines:[]}}, {language});
    expect(Buffer.from(pdf).subarray(0,5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(pdf.byteLength).toBeLessThan(1_000_000);
  });
});
