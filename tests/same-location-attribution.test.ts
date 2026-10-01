import { describe, expect, it } from "vitest";
import { computeSameLocationFound } from "../src/server/analytics";

const FROM = new Date("2026-09-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");
const IN_RANGE = new Date("2026-09-15T12:00:00.000Z");

describe("same-location attribution stays with the reporter", () => {
  it("attributes FOUND_AT_ORIGINAL completed by the checker to the reporting picker", () => {
    const lines = [
      { id: "l1", reportedByUserId: "picker-A", reportedAt: IN_RANGE },
      { id: "l2", reportedByUserId: "picker-A", reportedAt: IN_RANGE },
    ];
    const tasks = [
      { shortPickLineId: "l1", completionCode: "FOUND_AT_ORIGINAL", completedAt: new Date("2026-09-15T13:00:00.000Z"), createdAt: new Date("2026-09-15T12:05:00.000Z") },
      { shortPickLineId: "l2", completionCode: "FOUND", completedAt: new Date("2026-09-15T13:00:00.000Z"), createdAt: new Date("2026-09-15T12:05:00.000Z") },
    ];
    const { overall, byReporter } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(overall).toMatchObject({ numerator: 1, denominator: 2 });
    expect(byReporter.get("picker-A")).toEqual(["FOUND_AT_ORIGINAL", "FOUND"]);
    expect(byReporter.has("checker-B")).toBe(false);
  });

  it("attributes a FOUND outcome on the reporter's line to the reporter, not the checker", () => {
    const lines = [{ id: "l1", reportedByUserId: "picker-A", reportedAt: IN_RANGE }];
    const tasks = [
      { shortPickLineId: "l1", completionCode: "FOUND", completedAt: new Date("2026-09-15T13:00:00.000Z"), createdAt: new Date("2026-09-15T12:05:00.000Z") },
    ];
    const { byReporter } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(byReporter.get("picker-A")).toEqual(["FOUND"]);
    expect(byReporter.has("checker-B")).toBe(false);
  });
});
