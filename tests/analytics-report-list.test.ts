import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), hasAuthPermission: vi.fn(), listAnalyticsReports: vi.fn() }));
vi.mock("../src/server/auth", () => ({ authenticate: mocks.authenticate, hasAuthPermission: mocks.hasAuthPermission }));
vi.mock("../src/server/analytics-report-storage", () => ({ listAnalyticsReports: mocks.listAnalyticsReports }));

import { GET } from "../src/app/api/analytics/reports/route";

const context = { user: { id: "user-1", displayName: "Leader", loginIdentifier: "leader", role: "TEAM_LEADER", preferredLanguage: "en", permissions: ["EXPORT_ANALYTICS"] }, sessionId: "session-1" };

describe("analytics report list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(true);
    mocks.listAnalyticsReports.mockResolvedValue({ reports: [{ id: "report-1", filename: "report.pdf", createdAt: new Date("2026-09-27T10:00:00Z"), byteSize: 64, filters: {} }], nextCursor: "opaque-next-page" });
  });

  it("requires authentication and export permission", async () => {
    mocks.authenticate.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/api/analytics/reports"))).status).toBe(401);
    mocks.hasAuthPermission.mockReturnValue(false);
    expect((await GET(new Request("http://localhost/api/analytics/reports"))).status).toBe(403);
    expect(mocks.listAnalyticsReports).not.toHaveBeenCalled();
  });

  it("returns bounded report metadata with private no-store caching", async () => {
    const response = await GET(new Request("http://localhost/api/analytics/reports"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ reports: [{ id: "report-1", filename: "report.pdf", byteSize: 64 }], nextCursor: "opaque-next-page" });
    expect(mocks.listAnalyticsReports).toHaveBeenCalledWith(context, undefined);
  });

  it("passes the opaque cursor through and rejects duplicate cursors", async () => {
    await GET(new Request("http://localhost/api/analytics/reports?cursor=opaque-next-page"));
    expect(mocks.listAnalyticsReports).toHaveBeenCalledWith(context, "opaque-next-page");
    const response = await GET(new Request("http://localhost/api/analytics/reports?cursor=one&cursor=two"));
    expect(response.status).toBe(400);
    expect(mocks.listAnalyticsReports).toHaveBeenCalledTimes(1);
  });
});
