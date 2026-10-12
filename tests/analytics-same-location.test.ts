import { describe, expect, it } from "vitest";
import {
  SAME_LOCATION_FOUND_MIN_DENOMINATOR,
  computeSameLocationFound,
  sameLocationFoundCsv,
  sameLocationFoundOverallCsv,
} from "../src/server/analytics";

const FROM = new Date("2026-09-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");
const IN_RANGE = new Date("2026-09-15T12:00:00.000Z");

function line(id: string, reporter: string, reportedAt = IN_RANGE) {
  return { id, reportedByUserId: reporter, reportedAt };
}

function task(lineId: string, code: unknown, completedAt: string, createdAt = "2026-09-15T12:05:00.000Z") {
  return { shortPickLineId: lineId, completionCode: code, completedAt: new Date(completedAt), createdAt: new Date(createdAt) };
}

describe("same-location-found metric", () => {
  it("latest conclusive outcome wins and repeat checks never double-count", () => {
    const lines = [line("l1", "picker-1"), line("l2", "picker-1")];
    const tasks = [
      task("l1", "FOUND", "2026-09-15T13:00:00.000Z"),
      task("l1", "FOUND_AT_ORIGINAL", "2026-09-15T14:00:00.000Z"),
      task("l2", "NOT_FOUND", "2026-09-15T13:00:00.000Z"),
      task("l2", "NOT_FOUND", "2026-09-15T15:00:00.000Z"),
    ];
    const { overall, byReporter } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(overall).toMatchObject({ numerator: 1, denominator: 2, counts: { FOUND_AT_ORIGINAL: 1, NOT_FOUND: 1, FOUND: 0, WRONG_LOCATION: 0 } });
    expect(byReporter.get("picker-1")).toEqual(["FOUND_AT_ORIGINAL", "NOT_FOUND"]);
  });

  it("excludes unfinished lines, OTHER, and cancelled lines without a conclusive check", () => {
    const lines = [
      line("unfinished", "picker-1"),
      line("other-only", "picker-1"),
      line("cancelled-clean", "picker-1"),
      line("cancelled-conclusive", "picker-1"),
      line("kept", "picker-1"),
    ];
    const tasks = [
      task("other-only", "OTHER", "2026-09-15T13:00:00.000Z"),
      task("cancelled-conclusive", "WRONG_LOCATION", "2026-09-15T13:00:00.000Z"),
      task("kept", "FOUND", "2026-09-15T13:00:00.000Z"),
    ];
    const { overall } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(overall.denominator).toBe(2);
    expect(overall.counts).toMatchObject({ WRONG_LOCATION: 1, FOUND: 1 });
  });

  it("suppresses the percentage below 20 eligible lines but always shows counts", () => {
    const lines = Array.from({ length: 3 }, (_, index) => line(`l${index}`, "picker-1"));
    const tasks = lines.map((l) => task(l.id, "FOUND_AT_ORIGINAL", "2026-09-15T13:00:00.000Z"));
    const { overall } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(overall).toMatchObject({ numerator: 3, denominator: 3, percentage: null, percentageSuppressed: true });
    expect(overall.counts.FOUND_AT_ORIGINAL).toBe(3);

    const manyLines = Array.from({ length: SAME_LOCATION_FOUND_MIN_DENOMINATOR }, (_, index) => line(`m${index}`, "picker-1"));
    const manyTasks = manyLines.map((l, index) => task(l.id, index % 2 ? "FOUND" : "FOUND_AT_ORIGINAL", "2026-09-15T13:00:00.000Z"));
    const big = computeSameLocationFound(manyLines, manyTasks, FROM, TO).overall;
    expect(big).toMatchObject({ numerator: 10, denominator: 20, percentage: 50, percentageSuppressed: false });
  });

  it("restricts lines to the chosen date range by reportedAt", () => {
    const lines = [
      line("inside", "picker-1", IN_RANGE),
      line("before", "picker-1", new Date("2026-08-15T12:00:00.000Z")),
      line("after", "picker-1", new Date("2026-10-15T12:00:00.000Z")),
    ];
    const tasks = lines.map((l) => task(l.id, "FOUND_AT_ORIGINAL", "2026-09-15T13:00:00.000Z"));
    const { overall, byReporter } = computeSameLocationFound(lines, tasks, FROM, TO);
    expect(overall.denominator).toBe(1);
    expect(byReporter.get("picker-1")).toEqual(["FOUND_AT_ORIGINAL"]);
  });

  it("tolerates FOUND_AT_ORIGINAL as a plain string before the enum migration lands", () => {
    const { overall } = computeSameLocationFound([line("l1", "picker-1")], [task("l1", "FOUND_AT_ORIGINAL", "2026-09-15T13:00:00.000Z")], FROM, TO);
    expect(overall).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("keeps CSV export parity with the dashboard counts", () => {
    const byUser = [{
      userId: "picker-1", displayName: "Picker One", role: "PICKER",
      numerator: 1, denominator: 2, percentage: null, percentageSuppressed: true,
      from: FROM, to: TO, counts: { FOUND_AT_ORIGINAL: 1, FOUND: 1, NOT_FOUND: 0, WRONG_LOCATION: 0 },
    }];
    const csv = sameLocationFoundCsv(byUser);
    expect(csv.split("\r\n")[0]).toBe("user_id,display_name,role,numerator_found_at_original,denominator_eligible_lines,percentage,count_found_at_original,count_found,count_not_found,count_wrong_location,from,to");
    expect(csv).toContain("picker-1,Picker One,PICKER,1,2,,1,1,0,0,");
    const overall = sameLocationFoundOverallCsv({ numerator: 1, denominator: 2, percentage: null, percentageSuppressed: true, from: FROM, to: TO, counts: { FOUND_AT_ORIGINAL: 1, FOUND: 1, NOT_FOUND: 0, WRONG_LOCATION: 0 } });
    expect(overall.split("\r\n")[0]).toBe("numerator_found_at_original,denominator_eligible_lines,percentage,count_found_at_original,count_found,count_not_found,count_wrong_location,from,to");
    expect(overall).toContain("1,2,,1,1,0,0,");
  });
  it("does not serialize administrative reporters in the per-user CSV", () => {
    const row = { userId: "staff", displayName: "Staff", role: "PICKER", numerator: 1, denominator: 2,
      percentage: null, percentageSuppressed: true, from: FROM, to: TO,
      counts: { FOUND_AT_ORIGINAL: 1, FOUND: 1, NOT_FOUND: 0, WRONG_LOCATION: 0 } };
    const csv = sameLocationFoundCsv([row, { ...row, userId: "excluded-admin", role: "ADMIN" }, { ...row, userId: "excluded-manager", role: "MANAGER" }]);
    expect(csv).toContain("staff,Staff,PICKER");
    expect(csv).not.toContain("excluded-admin");
    expect(csv).not.toContain("excluded-manager");
  });

});
