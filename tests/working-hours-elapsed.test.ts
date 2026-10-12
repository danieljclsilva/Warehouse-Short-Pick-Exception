import { describe, expect, it } from "vitest";
import { formatCaseElapsedTime } from "../src/components/case-detail-view";

/**
 * Working-hours case clock (default Mon–Fri 08:00–17:00 Europe/Amsterdam).
 * 2026-10-02 is a Friday; 2026-10-05 is the following Monday.
 */
describe("formatCaseElapsedTime working-hours clock", () => {
  it("counts 1 working hour from Fri 16:30 to Mon 08:30", () => {
    expect(
      formatCaseElapsedTime("2026-10-02T16:30:00+02:00", "2026-10-05T08:30:00+02:00", undefined, Date.parse("2026-10-05T08:30:00+02:00")),
    ).toBe("1h");
  });

  it("pauses the clock on weekends", () => {
    const saturdayNoon = Date.parse("2026-10-03T12:00:00+02:00");
    expect(
      formatCaseElapsedTime("2026-10-02T16:30:00+02:00", null, undefined, saturdayNoon),
    ).toBe("30m");
  });

  it("freezes at closure instead of running forever", () => {
    const frozen = formatCaseElapsedTime(
      "2026-10-02T10:00:00+02:00",
      "2026-10-02T12:00:00+02:00",
      undefined,
      Date.parse("2026-10-09T12:00:00+02:00"),
    );
    expect(frozen).toBe("2h");
    // A week later the closed value is unchanged: end is pinned to resolvedAt.
    expect(
      formatCaseElapsedTime(
        "2026-10-02T10:00:00+02:00",
        "2026-10-02T12:00:00+02:00",
        undefined,
        Date.parse("2026-10-16T12:00:00+02:00"),
      ),
    ).toBe(frozen);
  });

  it("returns an em dash without a start", () => {
    expect(formatCaseElapsedTime(undefined)).toBe("—");
  });
});
