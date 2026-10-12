import { describe, expect, it } from "vitest";
import { DEFAULT_WORKING_HOURS, isWithinWorkingHours, workingElapsedMilliseconds } from "@/domain/working-hours";

const minute = 60_000;
describe("working clock on custom daylight-saving transition shifts", () => {
  it("counts both occurrences of included repeated autumn wall minutes", () => {
    const schedule = { ...DEFAULT_WORKING_HOURS, days: [7], start: "02:30", end: "03:30" };
    expect(isWithinWorkingHours("2026-10-25T00:30:00Z", schedule)).toBe(true);
    expect(workingElapsedMilliseconds("2026-10-25T00:30:00Z", "2026-10-25T01:00:00Z", schedule)).toBe(30 * minute);
    expect(workingElapsedMilliseconds("2026-10-25T01:00:00Z", "2026-10-25T01:30:00Z", schedule)).toBe(0);
    expect(workingElapsedMilliseconds("2026-10-25T01:30:00Z", "2026-10-25T02:30:00Z", schedule)).toBe(60 * minute);
  });
  it("counts no time for a wholly skipped spring window", () => {
    const schedule = { ...DEFAULT_WORKING_HOURS, days: [7], start: "02:10", end: "02:50" };
    expect(workingElapsedMilliseconds("2026-03-28T23:00:00Z", "2026-03-29T04:00:00Z", schedule)).toBe(0);
  });
  it("retains exact sub-minute overlap on transition days", () => {
    const schedule = { ...DEFAULT_WORKING_HOURS, days: [7], start: "02:30", end: "03:30" };
    expect(workingElapsedMilliseconds("2026-10-25T00:29:59.500Z", "2026-10-25T00:30:01.250Z", schedule)).toBe(1250);
  });
});
