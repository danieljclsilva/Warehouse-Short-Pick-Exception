import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  hasAuthPermission: vi.fn(),
  getAnalyticsReport: vi.fn(),
  deleteAnalyticsReport: vi.fn(),
}));

vi.mock("../src/server/auth", () => ({ authenticate: mocks.authenticate, hasAuthPermission: mocks.hasAuthPermission }));
vi.mock("../src/server/analytics-report-storage", () => ({ getAnalyticsReport: mocks.getAnalyticsReport, deleteAnalyticsReport: mocks.deleteAnalyticsReport }));

import { DELETE, GET } from "../src/app/api/analytics/reports/[id]/route";
import { CaseApiError } from "../src/server/case-errors";

const context = { user: { id: "user-1", displayName: "Leader", loginIdentifier: "leader", role: "TEAM_LEADER", preferredLanguage: "en", permissions: ["EXPORT_ANALYTICS"] }, sessionId: "session-1" };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("analytics report download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(context);
    mocks.hasAuthPermission.mockReturnValue(true);
    mocks.getAnalyticsReport.mockResolvedValue({ body: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf", filename: "short-pick-analytics-2026-09-27.pdf" });
    mocks.deleteAnalyticsReport.mockResolvedValue({ id: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("rejects unauthenticated requests before reading the report", async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(401);
    expect(mocks.getAnalyticsReport).not.toHaveBeenCalled();
  });

  it("requires EXPORT_ANALYTICS on the server", async () => {
    mocks.hasAuthPermission.mockReturnValue(false);
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(403);
    expect(mocks.getAnalyticsReport).not.toHaveBeenCalled();
  });

  it("rejects malformed report ids", async () => {
    const response = await GET(new Request("http://localhost/api/analytics/reports/not-a-uuid"), params("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(mocks.getAnalyticsReport).not.toHaveBeenCalled();
  });

  it("streams the retained PDF with download headers", async () => {
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="short-pick-analytics-2026-09-27.pdf"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("falls back to a safe filename for unexpected stored names", async () => {
    mocks.getAnalyticsReport.mockResolvedValue({ body: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf", filename: "evil\"\r\nSet-Cookie: x.pdf" });
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="short-pick-analytics.pdf"');
  });

  it("propagates unknown reports as 404", async () => {
    mocks.getAnalyticsReport.mockRejectedValue(new CaseApiError("CASE_NOT_FOUND", "Analytics report not found", 404));
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(404);
  });

  it("propagates service-level permission denial", async () => {
    mocks.getAnalyticsReport.mockRejectedValue(new CaseApiError("CASE_ACCESS_DENIED", "EXPORT_ANALYTICS permission required", 403));
    const response = await GET(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000"), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(403);
  });

  it("requires EXPORT_ANALYTICS before deleting a retained report", async () => {
    mocks.hasAuthPermission.mockReturnValue(false);
    const response = await DELETE(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" }), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(403);
    expect(mocks.deleteAnalyticsReport).not.toHaveBeenCalled();
  });

  it("deletes a retained report and returns its id", async () => {
    const response = await DELETE(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" }), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ id: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("surfaces storage failures without returning success", async () => {
    mocks.deleteAnalyticsReport.mockRejectedValue(new CaseApiError("STORAGE_UNAVAILABLE", "The report could not be deleted from storage; retry later", 503));
    const response = await DELETE(new Request("http://localhost/api/analytics/reports/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" }), params("123e4567-e89b-12d3-a456-426614174000"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The report could not be deleted from storage; retry later", code: "STORAGE_UNAVAILABLE" });
  });
});
