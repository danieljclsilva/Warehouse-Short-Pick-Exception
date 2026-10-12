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

  it("buckets open-case aging in working hours and ignores resolved cases", () => {
      // Friday 2026-10-02 16:00 CEST: 1 working hour remains until 17:00 close.
      // Monday 2026-10-05 08:00 CEST snapshot.
      const now = Date.parse("2026-10-05T08:00:00+02:00");
      const buckets = agingBuckets([
        { createdAt: "2026-10-02T16:00:00+02:00", resolvedAt: null },
        // Three working days earlier: Wed 09:00 -> Fri close (2x9h) + nothing over the weekend.
        { createdAt: "2026-09-30T09:00:00+02:00", resolvedAt: null },
        { createdAt: "2026-09-30T09:00:00+02:00", resolvedAt: "2026-10-01T09:00:00+02:00" },
      ], now);
      expect(buckets).toMatchObject({ open: 2, under1d: 1, d1to3: 1 });
    });

  it("prefers pinned elapsedWorkingSeconds under the row schedule", () => {
      const now = Date.parse("2026-10-05T08:00:00+02:00");
      const buckets = agingBuckets([
        { createdAt: "2026-09-01T00:00:00+02:00", resolvedAt: null, elapsedWorkingSeconds: 60 * 60 },
      ], now);
      expect(buckets).toMatchObject({ open: 1, under1d: 1 });
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
