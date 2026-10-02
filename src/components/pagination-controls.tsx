"use client";

import type { MessageKey } from "@/i18n/messages";

export type PageMeta = { total: number; page: number; pageSize: number; totalPages: number };

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

function pageItems(page: number, totalPages: number): Array<number | "…"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const windowed = new Set([1, 2, page - 1, page, page + 1, totalPages - 1, totalPages].filter((value) => value >= 1 && value <= totalPages));
  const sorted = [...windowed].sort((a, b) => a - b);
  const items: Array<number | "…"> = [];
  for (const [index, value] of sorted.entries()) {
    if (index > 0 && value - sorted[index - 1]! > 1) items.push("…");
    items.push(value);
  }
  return items;
}

/**
 * Shared pagination control. Prev/next + page numbers (or load-more for
 * feeds via `variant="more"`), preserves caller filters (the caller keeps
 * its own filter state; this control only changes the page), shows the total
 * count, and renders an empty state through the caller's own empty copy.
 */
export function PaginationControls({ tr, meta, onPage, variant = "pages", loading = false }: {
  tr: Translator;
  meta: PageMeta;
  onPage: (page: number) => void;
  variant?: "pages" | "more";
  loading?: boolean;
}) {
  if (meta.total === 0) return null;
  if (variant === "more") {
    if (meta.page >= meta.totalPages) return null;
    return (
      <button type="button" className="pagination-more" onClick={() => onPage(meta.page + 1)} disabled={loading}>
        {loading ? tr("paginationLoading") : tr("paginationLoadMore")}
      </button>
    );
  }
  if (meta.totalPages <= 1) return <p className="pagination-total" aria-live="polite">{tr("paginationTotal", { count: String(meta.total) })}</p>;
  return (
    <nav className="pagination-controls" aria-label={tr("paginationLabel")}>
      <button type="button" className="pagination-prev" onClick={() => onPage(meta.page - 1)} disabled={loading || meta.page <= 1}>
        {tr("paginationPrevious")}
      </button>
      <span className="pagination-pages" role="group">
        {pageItems(meta.page, meta.totalPages).map((item, index) =>
          item === "…" ? <span key={`gap-${index}`} className="pagination-gap" aria-hidden="true">…</span> : (
            <button key={item} type="button" className={item === meta.page ? "pagination-page pagination-current" : "pagination-page"}
              aria-current={item === meta.page ? "page" : undefined} aria-label={tr("paginationPage", { page: String(item) })}
              onClick={() => onPage(item)} disabled={loading || item === meta.page}>
              {item}
            </button>
          ),
        )}
      </span>
      <button type="button" className="pagination-next" onClick={() => onPage(meta.page + 1)} disabled={loading || meta.page >= meta.totalPages}>
        {tr("paginationNext")}
      </button>
      <span className="pagination-total" aria-live="polite">{tr("paginationTotal", { count: String(meta.total) })}</span>
    </nav>
  );
}
