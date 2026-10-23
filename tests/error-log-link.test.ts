import { describe, expect, it } from "vitest";

import { buildErrorLogHref } from "@/components/error-log-link";

const BASE = "https://script.google.com/macros/s/abc/exec";

describe("buildErrorLogHref", () => {
  it("returns null when no base URL is configured", () => {
    expect(buildErrorLogHref(undefined, "172024", [{ location: "08.CA.2", sku: "A" }], "case-1")).toBeNull();
    expect(buildErrorLogHref("  ", "172024", [{ location: "08.CA.2", sku: "A" }], "case-1")).toBeNull();
  });

  it("returns null for invalid or non-HTTPS base URLs", () => {
    expect(buildErrorLogHref("not a url", "172024", [], "case-1")).toBeNull();
    expect(buildErrorLogHref("http://example.com/exec", "172024", [], "case-1")).toBeNull();
  });

  it("passes the order number, distinct location and SKU pairs and the case id", () => {
    const href = buildErrorLogHref(BASE, "172024", [
      { location: "08.CA.2", sku: "STEF-X12F-L" },
      { location: "08.CA.2", sku: "STEF-X12F-L" },
      { location: "08.CA.2", sku: "STEF-SF1-L" },
      { location: "H.A/BACKWALL1.01", sku: null },
      { location: " ", sku: "IGNORED" },
    ], "case-1");
    const url = new URL(href!);
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("order")).toBe("172024");
    expect(url.searchParams.getAll("loc")).toEqual(["08.CA.2", "08.CA.2", "H.A/BACKWALL1.01"]);
    expect(url.searchParams.getAll("sku")).toEqual(["STEF-X12F-L", "STEF-SF1-L", ""]);
    expect(url.searchParams.get("case")).toBe("case-1");
  });

  it("omits the case id when it is missing", () => {
    const url = new URL(buildErrorLogHref(BASE, "172024", [{ location: "01.AA.1", sku: "X" }])!);
    expect(url.searchParams.has("case")).toBe(false);
  });
  it("replaces configured payload params and normalizes locations and SKUs", () => {
    const url = new URL(buildErrorLogHref(`${BASE}?loc=stale&sku=stale&case=stale&view=research`, " 172024 ", [{ location: "3aa1", sku: " mixed-sku " }])!);
    expect(url.searchParams.getAll("loc")).toEqual(["03.AA.1"]);
    expect(url.searchParams.getAll("sku")).toEqual(["MIXED-SKU"]);
    expect(url.searchParams.has("case")).toBe(false);
    expect(url.searchParams.get("view")).toBe("research");
  });

});
