import { describe, expect, it } from "vitest";
import { buildLocalizedPushPayload } from "../src/server/push";
import { getMessages, translate, type MessageKey } from "../src/i18n/messages";

const notification = (type: string) => ({ id: "00000000-0000-4000-8000-000000000000", type });

describe("localized push payloads", () => {
  it("localizes title and body per locale", () => {
    for (const locale of ["en", "nl", "pl", "es"] as const) {
      const { messages } = getMessages(locale);
      const payload = buildLocalizedPushPayload(notification("NEW_SHORT_PICK"), locale);
      expect(payload.title).toBe(translate(messages, "notificationNewShortPick"));
      expect(payload.body).toBe(translate(messages, "pushNotificationBody"));
      expect(payload.notificationId).toBe("00000000-0000-4000-8000-000000000000");
    }
  });

  it("maps new informational types to localized titles in every locale", () => {
    const pairs: Array<[string, MessageKey]> = [
      ["CHECK_RESOLVED_EXTERNALLY", "notificationCheckResolvedExternally"],
      ["ORDER_STAGED", "notificationOrderStaged"],
    ];
    for (const locale of ["en", "nl", "pl", "es"] as const) {
      const { messages } = getMessages(locale);
      for (const [type, key] of pairs) {
        expect(buildLocalizedPushPayload(notification(type), locale).title).toBe(translate(messages, key));
      }
    }
  });

  it("falls back to English for unknown or null languages", () => {
    const { messages } = getMessages("en");
    for (const language of [null, undefined, "xx", "EN", ""]) {
      const payload = buildLocalizedPushPayload(notification("CASE_RESOLVED"), language);
      expect(payload.title).toBe(translate(messages, "notificationCaseResolved"));
      expect(payload.body).toBe(translate(messages, "pushNotificationBody"));
    }
  });

  it("emits only generic fields plus notificationId", () => {
    const payload = buildLocalizedPushPayload(notification("CASE_RESOLVED"), "en");
    expect(Object.keys(payload).sort()).toEqual(["body", "notificationId", "title"]);
    expect(JSON.stringify(payload)).not.toMatch(/ORD|order|location|sku|[A-Z]{2,}\.\d/i);
  });
});
