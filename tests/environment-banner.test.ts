import { describe, expect, it } from "vitest";
import { shouldShowTestBanner } from "@/components/environment-banner";

describe("shouldShowTestBanner", () => {
  it("shows the banner for the test environment", () => {
    expect(shouldShowTestBanner({ NEXT_PUBLIC_APP_ENV: "test" })).toBe(true);
  });

  it("hides the banner when the marker is unset (production build)", () => {
    expect(shouldShowTestBanner({})).toBe(false);
  });

  it("hides the banner for any other value", () => {
    expect(shouldShowTestBanner({ NEXT_PUBLIC_APP_ENV: "production" })).toBe(false);
    expect(shouldShowTestBanner({ NEXT_PUBLIC_APP_ENV: "development" })).toBe(false);
  });
});
