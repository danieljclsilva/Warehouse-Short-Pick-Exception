import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";

describe("configuration working-hours section", () => {
  it("exposes working-hours keys in all four locales", () => {
    for (const locale of ["en", "nl", "pl", "es"] as const) {
      const { messages } = getMessages(locale);
      for (const key of [
        "configurationWorkingHoursTitle",
        "configurationWorkingHoursDescription",
        "configurationWorkingHoursTimezoneValue",
        "configurationWorkingHoursDays",
        "configurationWorkingHoursStart",
        "configurationWorkingHoursEnd",
        "configurationWorkingHoursEmptyDays",
        "configurationWorkingHoursInvalidRange",
        "workingHoursMonday",
        "workingHoursFriday",
        "analyticsTimingNote",
      ] as const) {
        expect(messages[key], `${locale}.${key}`).toBeTruthy();
      }
    }
  });
});
