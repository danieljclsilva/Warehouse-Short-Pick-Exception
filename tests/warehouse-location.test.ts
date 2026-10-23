import { describe, expect, it } from "vitest";
import { formatLocationInput, normalizeWarehouseLocation, suggestWarehouseLocations } from "@/domain/warehouse-location";
import { addLineSchema } from "@/server/cases";
import { completeCheckSchema, discoveredLocationSchema } from "@/server/checks";
import { manualCaseSchema, repairCaseSchema } from "@/server/operations";

describe("assisted warehouse locations", () => {
  it.each([
    ["03.aa.1", "03.AA.1"], ["03aa1", "03.AA.1"], ["3 aa 1", "03.AA.1"],
    ["h.a/backwall1.01", "H.A/BACKWALL1.01"], ["h b / back wall 2 3", "H.B/BACKWALL2.03"],
    ["h.a/endcap -2", "H.A/ENDCAP -2"], ["h.a/a endcap - 1", "H.A/A ENDCAP -1"], ["H.A/I Endcap -1 ", "H.A/I ENDCAP -1"], ["H B/END CAP - 4", "H.B/ENDCAP -4"],
    [" old-rack north ", "OLD-RACK NORTH"], ["03.AA.12", "03.AA.12"], ["H.A/OTHER1", "H.A/OTHER1"],
  ])("normalizes %s without discarding legacy names", (raw, expected) => {
    expect(normalizeWarehouseLocation(raw)).toBe(expected);
    expect(normalizeWarehouseLocation(expected)).toBe(expected);
  });
  it("inserts rack separators only when the next segment arrives", () => {
    const steps = ["0", "03", "03a", "03.Aa", "03.AA1"];
    expect(steps.map(formatLocationInput)).toEqual(["0", "03", "03.A", "03.AA", "03.AA.1"]);
    expect(formatLocationInput("03.AA.")).toBe("03.AA.");
    expect(formatLocationInput("legacy-3a")).toBe("LEGACY-3A");
  });
  it("offers format completions for rack levels, backwalls and endcaps", () => {
    expect(suggestWarehouseLocations("03.aa")).toContain("03.AA.1");
    expect(suggestWarehouseLocations("H.A/BACKWALL1.")).toContain("H.A/BACKWALL1.01");
    expect(suggestWarehouseLocations("H.B/ENDCAP -")).toContain("H.B/ENDCAP -2");
    expect(suggestWarehouseLocations("H.A/A ENDCAP -")).toContain("H.A/A ENDCAP -1");
    expect(suggestWarehouseLocations("OLD-LOCATION")).toEqual([]);
  });
  it("normalizes the same way at every server entry point", () => {
    const location = "3aa1";
    expect(addLineSchema.parse({ location, sku: " mixed-Sku ", quantity: 1 })).toMatchObject({ location: "03.AA.1", sku: "MIXED-SKU" });
    expect(manualCaseSchema.parse({ orderNumber: "123", firstLine: { location, sku: "x", quantity: 1 } }).firstLine.location).toBe("03.AA.1");
    expect(completeCheckSchema.parse({ code: "FOUND", discoveredLocation: location }).discoveredLocation).toBe("03.AA.1");
    expect(discoveredLocationSchema.parse({ location }).location).toBe("03.AA.1");
    expect(repairCaseSchema.parse({ command: "CORRECT_LOCATION", reason: "typing correction", location }).location).toBe("03.AA.1");
  });
});
