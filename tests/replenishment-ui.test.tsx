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
  it("offers the state-only writer on manager surfaces, never on picker My Work", () => {
    for (const surface of [
      "../src/components/check-workflow.tsx",
      "../src/components/operations-dashboard.tsx",
    ]) {
      const source = read(surface);
      expect(source).toContain("SharedCaseLineCard");
      expect(source).toContain("canRecordReplenishment");
    }
    expect(read("../src/components/case-line-card.tsx")).toContain("ReplenishmentForm");
    const picker = read("../src/components/picker-workflow.tsx");
    expect(picker).not.toContain("ReplenishmentForm");
    expect(picker).not.toContain("SharedCaseLineCard");
    expect(picker).toContain("replenishment-badge");
  });

  it("posts state only: no note, no assignment, no directory fetch", () => {
    const form = read("../src/components/replenishment-form.tsx");
    expect(form).toContain("JSON.stringify({ state })");
    expect(form).not.toContain("/api/users/directory");
    expect(form).not.toContain("/api/admin/users");
    expect(form).not.toContain("retrieverUserId");
  });

  it("localizes the writer, badge, location reporter, retrieval prompt, and notices in all four languages", () => {
    for (const locale of supportedLocales) {
      const tr = trFor(locale);
      for (const key of [
        "replenishmentAction",
        "replenishmentWaitingOption",
        "replenishmentCompletedOption",
        "replenishmentSaved",
        "replenishmentFailed",
        "lineReplenishmentState",
        "event_REPLENISHMENT_WAITING",
        "event_REPLENISHMENT_COMPLETED",
        "reportLocationAction",
        "reportLocationPlaceholder",
        "reportLocationSaved",
        "reportLocationFailed",
        "pickerRetrievalPrompt",
      ] as const) {
        const text = tr(key);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
      expect(tr("pickerRetrievalPrompt", { location: "02.BB.9" })).toContain("02.BB.9");
    }
  });
});
