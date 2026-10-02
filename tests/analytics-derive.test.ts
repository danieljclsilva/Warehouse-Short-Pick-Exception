import { describe, expect, it } from "vitest";
import { agingBuckets, buildVolumeSeries, phaseMix, periodKindForRange, reporterVolume, topN } from "../src/components/analytics/derive";

describe("analytics derive helpers", () => {
  it("classifies period granularity by range length", () => {
    const day = 86_400_000;
    expect(periodKindForRange(0, 10 * day)).toBe("day");
    expect(periodKindForRange(0, 100 * day)).toBe("week");
    expect(periodKindForRange(0, 400 * day)).toBe("month");
  });

  it("merges server period totals with slice-based resolved counts", () => {
    const series = buildVolumeSeries(
      [{ label: "2026-09-01", count: 2, lines: 3 }],
      [
        { resolvedAt: new Date("2026-09-01T10:00:00.000Z") },
        { resolvedAt: null },
      ],
      "day",
    );
    expect(series).toEqual([{ period: "2026-09-01", cases: 2, lines: 3, resolved: 1 }]);
  });

  it("takes the top-N by count with label tiebreak", () => {
    expect(topN([{ label: "b", count: 1 }, { label: "a", count: 1 }, { label: "c", count: 2 }], 2)).toEqual([
      { label: "c", count: 2 },
      { label: "a", count: 1 },
    ]);
  });

  it("buckets open-case aging and ignores resolved cases", () => {
    const day = 86_400_000;
    const now = new Date("2026-10-02T00:00:00.000Z").getTime();
    const buckets = agingBuckets([
      { createdAt: new Date(now - 2 * day).toISOString(), resolvedAt: null },
      { createdAt: new Date(now - 10 * day).toISOString(), resolvedAt: null },
      { createdAt: new Date(now - 10 * day).toISOString(), resolvedAt: new Date(now - day).toISOString() },
    ], now);
    expect(buckets).toMatchObject({ open: 2, d1to3: 1, over7d: 1 });
  });

  it("counts phase mix and reporter volume over slices", () => {
    expect(phaseMix([{ phase: "OPEN" }, { phase: "OPEN" }, {}])).toEqual([
      { phase: "OPEN", count: 2 },
      { phase: "UNKNOWN", count: 1 },
    ]);
    const volume = reporterVolume(
      [{ reportedByUserId: "u1" }, { reportedByUserId: "u1" }, { reportedByUserId: "u2" }, {}],
      (id) => (id === "u1" ? "Ann" : null),
      8,
    );
    expect(volume).toEqual([
      { userId: "u1", label: "Ann", count: 2 },
      { userId: "u2", label: "u2", count: 1 },
    ]);
  });
});
