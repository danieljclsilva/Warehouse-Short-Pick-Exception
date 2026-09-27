import { describe, expect, it } from "vitest";
import { formatPhotoApprovalDate } from "../src/components/photo-approval";

describe("profile photo approval dates", () => {
  it("formats the submission date in the selected application language", () => {
    const date = "2026-05-07T12:00:00.000Z";

    expect(formatPhotoApprovalDate(date, "en")).toBe("7 May 2026");
    expect(formatPhotoApprovalDate(date, "nl")).toBe("7 mei 2026");
    expect(formatPhotoApprovalDate(date, "pl")).toBe("7 maj 2026");
    expect(formatPhotoApprovalDate(date, "es")).toBe("7 may 2026");
  });
});
