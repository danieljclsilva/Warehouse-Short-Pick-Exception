import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, supportedLocales, translate, type Locale } from "@/i18n/messages";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("replenishment UI wiring", () => {
  it("shares one form across picker, checks, and operations surfaces", () => {
    for (const surface of [
      "../src/components/picker-workflow.tsx",
      "../src/components/check-workflow.tsx",
      "../src/components/operations-dashboard.tsx",
    ]) {
      const source = read(surface);
      expect(source).toContain("ReplenishmentForm");
      expect(source).toContain("canRecordReplenishment");
    }
    const auth = read("../src/components/auth-app.tsx");
    expect(auth.match(/canRecordReplenishment=\{user\.permissions\.includes\("RECORD_REPLENISHMENT"\)\}/g)?.length ?? 0).toBe(3);
  });

  it("names the retriever from the scoped directory, never the admin user list", () => {
    const form = read("../src/components/replenishment-form.tsx");
    expect(form).toContain("/api/users/directory");
    expect(form).not.toContain("/api/admin/users");
    const route = read("../src/app/api/users/directory/route.ts");
    expect(route).toContain("RECORD_REPLENISHMENT");
    expect(route).not.toContain("passwordHash");
    expect(route).not.toContain("pinHash");
  });

  it("localizes the writer, badge, timeline events, and notices in all four languages", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const key of [
        "replenishmentAction",
        "replenishmentWaitingOption",
        "replenishmentCompletedOption",
        "replenishmentNotePlaceholder",
        "replenishmentSaved",
        "replenishmentFailed",
        "lineReplenishmentState",
        "event_REPLENISHMENT_WAITING",
        "event_REPLENISHMENT_COMPLETED",
      ] as const) {
        const text = tr(key);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
    }
  });
});
