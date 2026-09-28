import { describe, expect, it } from "vitest";
import { normalizeScannedValue } from "@/components/scan-input";

describe("normalizeScannedValue", () => {
  it("normalizes an NLVW order payload", () => {
    expect(normalizeScannedValue("NLVW341151", "order")).toBe("341151");
  });

  it("preserves ambiguous order payloads", () => {
    expect(normalizeScannedValue("NLVW341151-02", "order")).toBe("NLVW341151-02");
  });

  it("trims order input without altering digits", () => {
    expect(normalizeScannedValue("  341151  ", "order")).toBe("341151");
  });

  it("does not invent an order identifier", () => {
    expect(normalizeScannedValue("NLVW", "order")).toBe("NLVW");
  });

  it("uppercases locations and SKUs", () => {
    expect(normalizeScannedValue("03.aa.1", "location")).toBe("03.AA.1");
    expect(normalizeScannedValue("ff405d-42", "sku")).toBe("FF405D-42");
  });
});
