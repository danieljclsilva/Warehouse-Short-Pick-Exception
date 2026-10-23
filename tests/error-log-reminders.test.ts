import { beforeEach, describe, expect, it } from "vitest";

import { addPending, readPending, removePending } from "@/components/error-log-reminders";

const store = new Map<string, string>();
const events: string[] = [];
Object.assign(globalThis, {
  window: {
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  },
});

describe("error log reminders", () => {
  beforeEach(() => { store.clear(); events.length = 0; });

  it("adds a case and merges new items for the same case without duplicates", () => {
    addPending({ caseId: "c1", orderNumber: "172024", items: [{ location: "08.CA.2", sku: "A" }] }, 1_000);
    addPending({ caseId: "c1", orderNumber: "172024", items: [{ location: "08.CA.2", sku: "A" }, { location: "09.DA.3", sku: "B" }] }, 2_000);
    const pending = readPending(3_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].items).toEqual([{ location: "08.CA.2", sku: "A" }, { location: "09.DA.3", sku: "B" }]);
    expect(events.length).toBe(2);
  });

  it("removes a case once it is opened", () => {
    addPending({ caseId: "c1", orderNumber: "1", items: [] });
    addPending({ caseId: "c2", orderNumber: "2", items: [] });
    removePending("c1");
    expect(readPending().map((item) => item.caseId)).toEqual(["c2"]);
  });

  it("drops reminders older than seven days and ignores corrupt storage", () => {
    addPending({ caseId: "old", orderNumber: "1", items: [] }, 0);
    expect(readPending(8 * 24 * 60 * 60 * 1000)).toEqual([]);
    store.set("shortpick.errorLogPending", "not json");
    expect(readPending()).toEqual([]);
  });
});
