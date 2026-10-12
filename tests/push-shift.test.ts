import { describe, expect, it, vi } from "vitest";
import { currentWorkingWindowStart, DEFAULT_WORKING_HOURS, isWithinPushWorkerHours } from "../src/domain/working-hours";
import { runPushWorker } from "../src/server/push-worker-loop";

describe("push shift schedule", () => {
  it("warms 15 minutes before opening, stops at closing and stays off over weekends", () => {
    const schedule = DEFAULT_WORKING_HOURS;
    expect(isWithinPushWorkerHours("2026-10-12T05:44:59Z", schedule)).toBe(false);
    expect(isWithinPushWorkerHours("2026-10-12T05:45:00Z", schedule)).toBe(true);
    expect(currentWorkingWindowStart("2026-10-12T05:45:00Z", schedule)).toBeNull();
    expect(currentWorkingWindowStart("2026-10-12T06:00:00Z", schedule)?.toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(isWithinPushWorkerHours("2026-10-12T15:00:00Z", schedule)).toBe(false);
    expect(isWithinPushWorkerHours("2026-10-17T06:00:00Z", schedule)).toBe(false);
  });

  it("uses winter offsets, changed days/times and warm-up across midnight", () => {
    expect(currentWorkingWindowStart("2026-10-26T07:00:00Z", DEFAULT_WORKING_HOURS)?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    const schedule = { ...DEFAULT_WORKING_HOURS, days: [2], start: "00:05", end: "03:00" };
    expect(isWithinPushWorkerHours("2026-10-12T21:50:00Z", schedule)).toBe(true);
    expect(currentWorkingWindowStart("2026-10-12T22:05:00Z", schedule)?.toISOString()).toBe("2026-10-12T22:05:00.000Z");
    expect(isWithinPushWorkerHours("2026-10-13T06:00:00Z", schedule)).toBe(false);
  });

  it("counts the correct shift on both occurrences of the autumn repeated hour", () => {
    const schedule = { ...DEFAULT_WORKING_HOURS, days: [7], start: "02:00", end: "04:00" };
    expect(currentWorkingWindowStart("2026-10-25T00:30:00Z", schedule)?.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(currentWorkingWindowStart("2026-10-25T01:30:00Z", schedule)?.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  it("exits immediately outside the window without running a delivery batch", async () => {
    const batch = vi.fn();
    await runPushWorker(batch, new AbortController().signal, () => {}, 5, async () => false);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rechecks the schedule and exits when the shift closes", async () => {
    const batch = vi.fn(async () => 1);
    const shouldRun = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await runPushWorker(batch, new AbortController().signal, () => {}, 1, shouldRun);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(shouldRun).toHaveBeenCalledTimes(2);
  });
});
