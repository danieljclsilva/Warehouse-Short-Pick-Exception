import { z } from "zod";

/**
 * Shared offset-pagination contract for every potentially-long list.
 *
 * Servers accept `page` (1-based) + `pageSize` (bounded), validate/clamp via
 * `paginationQuerySchema`, and return `{ items, total, page, pageSize,
 * totalPages }` (or the same metadata alongside a legacy collection key).
 * Cursor pagination stays where keyset ordering fits better (checks queue,
 * analytics retained reports, case timeline feed).
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
/** Default page size for chronological feeds (notifications, case timeline). Tables default to 20. */
export const FEED_DEFAULT_PAGE_SIZE = 50;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationParams = z.infer<typeof paginationQuerySchema>;

export function parsePaginationParams(params: URLSearchParams, defaultPageSize = DEFAULT_PAGE_SIZE): PaginationParams {
  const rawPageSize = params.get("pageSize") ?? params.get("limit") ?? undefined;
  return paginationQuerySchema.parse({
    page: params.get("page") ?? undefined,
    pageSize: rawPageSize ?? defaultPageSize,
  });
}

export function paginationMeta(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** OFFSET for the requested page. Callers MUST also apply LIMIT pageSize. */
export function paginationOffset(page: number, pageSize: number) {
  return (page - 1) * pageSize;
}
