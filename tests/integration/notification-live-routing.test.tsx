import { describe, expect, it } from "vitest";
import { liveSectionForUser } from "@/components/auth-app";

const pickerChecks = [
  "REPORT_SHORT_PICK",
  "VIEW_OWN_CASES",
  "VIEW_AVAILABLE_CHECKS",
  "CLAIM_CHECK",
  "COMPLETE_CHECK",
];

describe("Notification open routes to the native case surface", () => {
  it("sends dashboard-access users to the dashboard drawer surface", () => {
    expect(
      liveSectionForUser({ role: "PICKER", permissions: [...pickerChecks, "VIEW_ALL_OPEN_CASES"] }, "CHECK_CLAIMED"),
    ).toBe("openCases");
    expect(
      liveSectionForUser({ role: "TEAM_LEADER", permissions: ["VIEW_ALL_OPEN_CASES", "CLAIM_CHECK"] }, "TROUBLESHOOTER_MESSAGE"),
    ).toBe("openCases");
  });

  it("sends pickers to Checks for check notifications and My Work otherwise", () => {
    const picker = { role: "PICKER", permissions: pickerChecks };
    expect(liveSectionForUser(picker, "RESPONSIBILITY_CHECK_ASSIGNED")).toBe("checks");
    expect(liveSectionForUser(picker, "check_claimed")).toBe("checks");
    expect(liveSectionForUser(picker, "TROUBLESHOOTER_MESSAGE")).toBe("myWork");
    expect(liveSectionForUser(picker, "RESPONSIBILITY_RETRIEVAL_ASSIGNED")).toBe("myWork");
    expect(liveSectionForUser(picker, null)).toBe("myWork");
  });

  it("falls back to My Work when a picker cannot use checks", () => {
    expect(
      liveSectionForUser({ role: "PICKER", permissions: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES"] }, "CHECK_CLAIMED"),
    ).toBe("myWork");
  });

  it("sends checks-only users to Checks and keeps the rest on the read-only panel", () => {
    expect(
      liveSectionForUser({ role: "TROUBLESHOOTER", permissions: ["VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK"] }, "NEW_SHORT_PICK"),
    ).toBe("checks");
    expect(liveSectionForUser({ role: "ADMIN", permissions: ["VIEW_ANALYTICS"] }, "NEW_SHORT_PICK")).toBeNull();
    expect(liveSectionForUser(null, "NEW_SHORT_PICK")).toBeNull();
  });
});
