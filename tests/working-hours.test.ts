import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKING_HOURS,
  elapsedWorkingMinutes,
  isWithinWorkingHours,
  workingElapsedMilliseconds,
  workingHoursFromConfiguration,
  type WorkingHours,
} from "../src/domain/working-hours";

const schedule: WorkingHours = DEFAULT_WORKING_HOURS;
// Mon 2026-10-12 / Fri 2026-10-09; Amsterdam is UTC+2 (CEST) in October.
const minutes = (start: string, end: string, custom: WorkingHours = schedule) =>
  workingElapsedMilliseconds(new Date(start), new Date(end), custom) / 60_000;

describe("working-hours case clock", () => {
  it("derives defaults from legacy configuration without the keys", () => {
    expect(workingHoursFromConfiguration({ WARNING_THRESHOLD_MINUTES: 5 })).toEqual(DEFAULT_WORKING_HOURS);
    expect(workingHoursFromConfiguration(null)).toEqual(DEFAULT_WORKING_HOURS);
    expect(workingHoursFromConfiguration({
      WORKING_HOURS_TIME_ZONE: "Europe/Amsterdam",
      WORKING_HOURS_DAYS: [1, 2, 3],
      WORKING_HOURS_START: "09:00",
      WORKING_HOURS_END: "17:30",
    })).toEqual({ timeZone: "Europe/Amsterdam", days: [1, 2, 3], start: "09:00", end: "17:30" });
  });

  it("rejects invalid days, times, and reversed windows back to defaults", () => {
    expect(workingHoursFromConfiguration({ WORKING_HOURS_DAYS: [] }).days).toEqual([1, 2, 3, 4, 5]);
    expect(workingHoursFromConfiguration({ WORKING_HOURS_DAYS: [1, 1, 2] }).days).toEqual([1, 2, 3, 4, 5]);
    expect(workingHoursFromConfiguration({ WORKING_HOURS_DAYS: [0, 8] }).days).toEqual([1, 2, 3, 4, 5]);
    expect(workingHoursFromConfiguration({ WORKING_HOURS_START: "25:00" }).start).toBe("08:00");
    expect(workingHoursFromConfiguration({ WORKING_HOURS_START: "17:00", WORKING_HOURS_END: "08:00" })).toMatchObject({ start: "08:00", end: "17:00" });
    expect(workingHoursFromConfiguration({ WORKING_HOURS_START: "08:00", WORKING_HOURS_END: "08:00" })).toMatchObject({ start: "08:00", end: "17:00" });
    expect(workingHoursFromConfiguration({ WORKING_HOURS_TIME_ZONE: "America/New_York" }).timeZone).toBe("Europe/Amsterdam");
  });

  it("treats the window as half-open at both edges", () => {
    expect(isWithinWorkingHours(new Date("2026-10-12T06:00:00Z"), schedule)).toBe(true); // Mon 08:00
    expect(isWithinWorkingHours(new Date("2026-10-12T05:59:00Z"), schedule)).toBe(false); // before opening
    expect(isWithinWorkingHours(new Date("2026-10-12T14:59:00Z"), schedule)).toBe(true); // 16:59
    expect(isWithinWorkingHours(new Date("2026-10-12T15:00:00Z"), schedule)).toBe(false); // 17:00 close
    expect(minutes("2026-10-12T06:00:00Z", "2026-10-12T06:01:00Z")).toBe(1);
    expect(minutes("2026-10-12T15:00:00Z", "2026-10-12T15:01:00Z")).toBe(0);
  });

  it("pauses overnight and over the weekend", () => {
    expect(minutes("2026-10-12T06:00:00Z", "2026-10-12T18:00:00Z")).toBe(540);
    expect(minutes("2026-10-12T18:00:00Z", "2026-10-13T06:00:00Z")).toBe(0);
    expect(minutes("2026-10-11T10:00:00Z", "2026-10-12T06:00:00Z")).toBe(0); // Sun 12:00 -> Mon 08:00 opening edge
    expect(minutes("2026-10-09T14:30:00Z", "2026-10-12T06:30:00Z")).toBe(60); // Fri 16:30 -> Mon 08:30
    expect(minutes("2026-10-10T10:00:00Z", "2026-10-11T10:00:00Z")).toBe(0); // Sat -> Sun
  });

  it("honors winter/summer offsets and DST transition weekends", () => {
    // Winter: CET (UTC+1), Mon 2026-01-12 09:00 local = 08:00Z.
    expect(isWithinWorkingHours(new Date("2026-01-12T08:00:00Z"), schedule)).toBe(true);
    expect(minutes("2026-01-12T07:00:00Z", "2026-01-12T09:00:00Z")).toBe(120);
    // Spring forward weekend 2026-03-28/29: Monday after still a 9h day.
    expect(minutes("2026-03-30T06:00:00Z", "2026-03-30T15:00:00Z")).toBe(540);
    // Autumn back weekend 2026-10-24/25: Monday after still a 9h day.
    expect(minutes("2026-10-26T07:00:00Z", "2026-10-26T16:00:00Z")).toBe(540);
  });

  it("handles invalid, reversed, and custom schedules", () => {
    expect(workingElapsedMilliseconds("nope", new Date(), schedule)).toBe(0);
    expect(workingElapsedMilliseconds(new Date("2026-10-12T10:00:00Z"), new Date("2026-10-12T09:00:00Z"), schedule)).toBe(0);
    expect(workingElapsedMilliseconds(new Date("2026-10-12T06:00:00Z"), new Date("2026-10-12T07:00:00Z"), { ...schedule, start: "17:00", end: "08:00" })).toBe(0);
    expect(minutes("2026-10-12T06:00:00Z", "2026-10-12T12:00:00Z", { ...schedule, days: [1], start: "09:00", end: "12:00" })).toBe(180);
    expect(minutes("2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", { ...schedule, days: [7], start: "08:00", end: "17:00" })).toBe(360);
  });

  it("keeps millisecond precision and floors whole minutes", () => {
    expect(workingElapsedMilliseconds(new Date("2026-10-12T06:00:00.250Z"), new Date("2026-10-12T06:00:01.750Z"), schedule)).toBe(1500);
    expect(elapsedWorkingMinutes(new Date("2026-10-12T06:00:00Z"), new Date("2026-10-12T06:00:59Z"), schedule)).toBe(0);
    expect(elapsedWorkingMinutes(new Date("2026-10-12T06:00:00Z"), new Date("2026-10-12T06:01:00Z"), schedule)).toBe(1);
  });

  it("supports multi-year intervals efficiently", () => {
    const start = new Date("2020-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:00:00Z");
    const begun = Date.now();
    const value = workingElapsedMilliseconds(start, end, schedule);
    expect(Date.now() - begun).toBeLessThan(2_000);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(end.getTime() - start.getTime());
  });
});
