import { beforeEach, describe, expect, it } from "vitest";
import { addPending, clearPending, discardUnscopedPending, readPending, removePending, removePendingItems } from "@/components/error-log-storage";

const store = new Map<string, string>();
const events: string[] = [];
Object.assign(globalThis, { window: {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => store.delete(key) },
  dispatchEvent: (event: Event) => { events.push(event.type); return true; },
} });
const user = "picker-a";
const key = "shortpick.errorLogPending.v2.picker-a";
const entry = { caseId: "c1", orderNumber: "172024", items: [{ location: "08.CA.2", sku: "A" }] };

describe("error log reminders", () => {
  beforeEach(() => { store.clear(); events.length = 0; });
  it("merges each distinct item only once, including duplicates within the new entry", () => {
    addPending(user, entry, 1_000);
    addPending(user, { ...entry, items: [...entry.items, { location: "09.DA.3", sku: "B" }, { location: "09.DA.3", sku: "B" }] }, 2_000);
    expect(readPending(user, 3_000)[0]).toMatchObject({ createdAt: 2_000, items: [...entry.items, { location: "09.DA.3", sku: "B" }] });
    expect(events).toHaveLength(2);
  });
  it("keeps reminders private to their user and clears only that user's storage", () => {
    addPending(user, entry);
    expect(readPending("picker-b")).toEqual([]);
    addPending("picker-b", { ...entry, caseId: "c2" });
    clearPending(user);
    expect(readPending(user)).toEqual([]);
    expect(readPending("picker-b").map((item) => item.caseId)).toEqual(["c2"]);
  });
  it("discards legacy ownerless data instead of exposing it to a new account", () => {
    store.set("shortpick.errorLogPending", JSON.stringify([entry]));
    discardUnscopedPending();
    expect(store.has("shortpick.errorLogPending")).toBe(false);
    expect(readPending(user)).toEqual([]);
  });
  it("removes a complete case only when its case link is opened", () => {
    addPending(user, entry);
    addPending(user, { ...entry, caseId: "c2" });
    removePending(user, "c1");
    expect(readPending(user).map((item) => item.caseId)).toEqual(["c2"]);
  });
  it("preserves A when Log now opens only a newly reported B in the same case", () => {
    addPending(user, entry);
    const newer = { ...entry, items: [{ location: "09.DA.3", sku: "B" }] };
    removePendingItems(user, newer);
    expect(readPending(user)[0]?.items).toEqual(entry.items);
    addPending(user, newer);
    removePendingItems(user, newer);
    expect(readPending(user)[0]?.items).toEqual(entry.items);
    removePendingItems(user, entry);
    expect(readPending(user)).toEqual([]);
  });
  it("drops expired/future entries and rejects malformed nested items", () => {
    addPending(user, entry, 0);
    expect(readPending(user, 8 * 24 * 60 * 60 * 1000)).toEqual([]);
    for (const items of [[null], [{ location: 123 }], [{ sku: {} }]]) {
      store.set(key, JSON.stringify([{ ...entry, items, createdAt: 1000 }]));
      expect(readPending(user, 2000)).toEqual([]);
    }
    store.set(key, JSON.stringify([{ ...entry, createdAt: 3000 }]));
    expect(readPending(user, 2000)).toEqual([]);
    store.set(key, "not json");
    expect(readPending(user)).toEqual([]);
  });
  it("caps writes and hostile stored lists at twenty newest entries", () => {
    for (let index = 0; index < 25; index++) addPending(user, { ...entry, caseId: `c${index}` });
    expect(readPending(user)).toHaveLength(20);
    expect(readPending(user)[0]?.caseId).toBe("c5");
    store.set(key, JSON.stringify(Array.from({ length: 25 }, (_, index) => ({ ...entry, caseId: `c${index}`, createdAt: Date.now() }))));
    expect(readPending(user)).toHaveLength(20);
  });
  it("does not break reporting if localStorage is blocked", () => {
    const storage = window.localStorage;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    expect(() => addPending(user, entry)).not.toThrow();
    expect(readPending(user)).toEqual([]);
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  });
});
