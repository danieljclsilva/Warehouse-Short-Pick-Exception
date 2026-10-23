import { normalizeWarehouseLocation } from "@/domain/warehouse-location";

/** Base URL of the external error log app; the link is hidden when this is not set. */
export const errorLogBaseUrl = process.env.NEXT_PUBLIC_ERROR_LOG_URL;

export type ErrorLogItem = { location?: string | null; sku?: string | null };

/**
 * Builds the link that opens the external error log app with the case's order number,
 * its distinct location and SKU pairs (as parallel loc/sku parameters) and the case id prefilled.
 * Returns null when no valid HTTPS base URL is configured.
 */
export function buildErrorLogHref(baseUrl: string | undefined, orderNumber: string, items: ReadonlyArray<ErrorLogItem>, caseId?: string): string | null {
  const base = baseUrl?.trim();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  url.searchParams.set("order", orderNumber.trim());
  url.searchParams.delete("loc");
  url.searchParams.delete("sku");
  url.searchParams.delete("case");
  const seen = new Set<string>();
  for (const item of items) {
    const location = normalizeWarehouseLocation(item.location ?? "");
    const sku = (item.sku ?? "").trim().toUpperCase();
    const key = `${location}\u0000${sku}`;
    if (!location || seen.has(key)) continue;
    seen.add(key);
    url.searchParams.append("loc", location);
    url.searchParams.append("sku", sku);
  }
  if (caseId) url.searchParams.set("case", caseId);
  return url.toString();
}
