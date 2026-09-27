import { describe, expect, it } from "vitest";
import { normalizeScannedValue } from "@/components/scan-input";

describe("normalizeScannedValue", () => {
  it("extracts the numeric order identifier from a prefixed barcode payload", () => {
    expect(normalizeScannedValue("NLVW341151", "order")).toBe("341151");
  });

  it("trims order input without altering digits", () => {
    expect(normalizeScannedValue("  341151  ", "order")).toBe("341151");
  });

  it("uppercases scanned locations the way the server stores them", () => {
    expect(normalizeScannedValue("03.aa.1", "location")).toBe("03.AA.1");
  });

  it("uppercases scanned SKUs without otherwise altering them", () => {
    expect(normalizeScannedValue("ff405d-42", "sku")).toBe("FF405D-42");
  });
});
