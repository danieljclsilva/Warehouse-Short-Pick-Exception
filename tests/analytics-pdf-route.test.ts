import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  hasAuthPermission: vi.fn(),
  parseAnalyticsFilters: vi.fn(),
  getAnalyticsReportData: vi.fn(),
  renderAnalyticsPdf: vi.fn(),
  persistAnalyticsReport: vi.fn(),
  logServerError: vi.fn(),
}));

vi.mock("../src/server/auth", () => ({ authenticate: mocks.authenticate, hasAuthPermission: mocks.hasAuthPermission }));
vi.mock("../src/server/analytics", () => ({ parseAnalyticsFilters: mocks.parseAnalyticsFilters, getAnalyticsReportData: mocks.getAnalyticsReportData }));
vi.mock("../src/server/analytics-pdf", () => ({ renderAnalyticsPdf: mocks.renderAnalyticsPdf }));
vi.mock("../src/server/analytics-report-storage", () => ({ persistAnalyticsReport: mocks.persistAnalyticsReport }));
vi.mock("../src/server/logger", () => ({ logServerError: mocks.logServerError }));

import { GET } from "../src/app/api/analytics/export/pdf/route";

const context = { user: { id: "user-1", displayName: "Leader", loginIdentifier: "leader", role: "TEAM_LEADER", preferredLanguage: "en", permissions: ["EXPORT_ANALYTICS"] }, sessionId: "session-1" };

describe("analytics PDF route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseAnalyticsFilters.mockReturnValue({ from: new Date("2026-09-01"), to: new Date("2026-10-01") });
    mocks.getAnalyticsReportData.mockResolvedValue({ kpis: {}, rows: { cases: [], lines: [] }, duplicates: {}, filters: {}, limits: {} });
    mocks.renderAnalyticsPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    mocks.persistAnalyticsReport.mockResolvedValue("report-1");
  });

  it("rejects unauthenticated requests before reading analytics", async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/analytics/export/pdf"));
    expect(response.status).toBe(401);
    expect(mocks.getAnalyticsReportData).not.toHaveBeenCalled();
  });

  it("requires EXPORT_ANALYTICS on the server", async () => {
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(false);
    const response = await GET(new Request("http://localhost/api/analytics/export/pdf?phase=PICKING"));
    expect(response.status).toBe(403);
    expect(mocks.getAnalyticsReportData).not.toHaveBeenCalled();
  });

  it("streams a PDF after applying the shared filter parser", async () => {
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(true);
    const response = await GET(new Request("http://localhost/api/analytics/export/pdf?phase=PICKING"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-report-retention")).toBe("retained");
    expect(response.headers.get("content-disposition")).toMatch(/short-pick-analytics-.*\.pdf/);
    expect(mocks.parseAnalyticsFilters).toHaveBeenCalledWith(expect.any(URLSearchParams));
    expect(mocks.getAnalyticsReportData).toHaveBeenCalledWith(context, expect.any(Object));
    expect(mocks.renderAnalyticsPdf).toHaveBeenCalledWith(expect.any(Object), { language: "en" });
    expect(mocks.persistAnalyticsReport).toHaveBeenCalledWith(context, expect.stringMatching(/\.pdf$/), expect.any(Object), expect.any(Uint8Array));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("still streams the generated PDF when retention fails", async () => {
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(true);
    mocks.persistAnalyticsReport.mockRejectedValue(new Error("retention unavailable"));
    const response = await GET(new Request("http://localhost/api/analytics/export/pdf?phase=PICKING"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-report-retention")).toBe("unavailable");
    expect(response.headers.get("x-report-id")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("logs only the failing stage when PDF rendering throws", async () => {
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(true);
    mocks.renderAnalyticsPdf.mockRejectedValue(new Error("private renderer detail"));

    const response = await GET(new Request("http://localhost/api/analytics/export/pdf"));

    expect(response.status).toBe(500);
    expect(mocks.logServerError).toHaveBeenCalledWith("report.pdf.generation_failed", expect.any(Error), {
      area: "reports",
      route: "/api/analytics/export/pdf",
      reason: "stage_pdf_render",
    });
    expect(JSON.stringify(mocks.logServerError.mock.calls)).not.toContain("private renderer detail");
  });
});
