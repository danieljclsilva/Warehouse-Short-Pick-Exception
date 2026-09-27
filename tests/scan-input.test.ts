import { describe, expect, it } from "vitest";
import { normalizeScannedValue } from "@/components/scan-input";

describe("normalizeScannedValue", () => {
  it("normalizes a clear keyboard-wedge order payload to its numeric identifier", () => {
    expect(normalizeScannedValue("NLVW341151", "order")).toBe("341151");
  });

  it("preserves an order payload with multiple numeric runs for validation", () => {
    expect(normalizeScannedValue("NLVW341151-02", "order")).toBe("NLVW341151-02");
  });

  it("trims order input without altering digits", () => {
    expect(normalizeScannedValue("  341151  ", "order")).toBe("341151");
  });

  it("does not invent an order identifier when there are no digits", () => {
    expect(normalizeScannedValue("NLVW", "order")).toBe("NLVW");
  });

  it("uppercases scanned locations the way the server stores them", () => {
    expect(normalizeScannedValue("03.aa.1", "location")).toBe("03.AA.1");
  });

  it("uppercases scanned SKUs without otherwise altering them", () => {
    expect(normalizeScannedValue("ff405d-42", "sku")).toBe("FF405D-42");
  });
});
