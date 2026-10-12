import { describe, expect, it } from "vitest";
import { hotspotConcentration, reportingRangeDays } from "@/components/analytics/derive";

describe("management hotspot concentration", () => {
  const items = [
    { label: "A", count: 1 }, { label: "B", count: 4 },
    { label: "C", count: 3 }, { label: "D", count: 2 },
  ];
  it("uses the three largest groups and the full line denominator", () => {
    expect(hotspotConcentration(items, 10, false)).toBe(0.9);
    expect(items[0]?.label).toBe("A");
  });
  it("supports fewer than three hotspots", () => {
    expect(hotspotConcentration([{ label: "A", count: 4 }], 4, false)).toBe(1);
  });
  it("suppresses empty and incomplete reporting rather than showing a misleading rate", () => {
    expect(hotspotConcentration([], 0, false)).toBeNull();
    expect(hotspotConcentration(items, 10, true)).toBeNull();
    expect(hotspotConcentration(items, 20, false)).toBeNull();
  });
  it("refuses invalid counts", () => {
    expect(hotspotConcentration([{ label: "A", count: -1 }], 1, false)).toBeNull();
    expect(hotspotConcentration(items, Number.NaN, false)).toBeNull();
  });
});

describe("reporting range display", () => {
  it("does not add the exclusive end day to the displayed range", () => {
    expect(reportingRangeDays("2026-09-12T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))
      .toEqual({ from: "2026-09-12", to: "2026-10-12" });
  });
  it("retains the end day for a timestamp inside that day", () => {
    expect(reportingRangeDays("2026-10-12T06:00:00Z", "2026-10-12T08:00:00Z"))
      .toEqual({ from: "2026-10-12", to: "2026-10-12" });
  });
  it("refuses invalid or reversed ranges", () => {
    expect(reportingRangeDays("invalid", "2026-10-13")).toBeNull();
    expect(reportingRangeDays("2026-10-13", "2026-10-12")).toBeNull();
  });
});
