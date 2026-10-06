"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "@/i18n/messages";
import { PaginationControls, type PageMeta } from "@/components/pagination-controls";

type HistoryCase = { id: string; orderNumber: string; createdAt: string; resolvedAt: string | null };
type HistoryResponse = { cases?: HistoryCase[] } & Partial<PageMeta> & { error?: string };

export function CaseHistory({ locale, tr, onOpenCase }: {
  locale: Locale;
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  onOpenCase: (caseId: string) => void;
}) {
  const [cases, setCases] = useState<HistoryCase[]>([]);
  const [meta, setMeta] = useState<PageMeta>({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageRef = useRef(1);
  const load = useCallback(async (page: number) => {
    try {
      const response = await fetch(`/api/picker/history?page=${page}&pageSize=20`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as HistoryResponse;
      if (!response.ok) throw new Error(body.error || tr("historyLoadError"));
      setCases(body.cases || []);
      setMeta({ total: body.total ?? 0, page: body.page ?? page, pageSize: body.pageSize ?? 20, totalPages: body.totalPages ?? 1 });
      pageRef.current = page;
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("historyLoadError")); }
    finally { setLoading(false); }
  }, [tr]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/picker/history?page=1&pageSize=20", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as HistoryResponse;
        if (!response.ok) throw new Error(body.error || tr("historyLoadError"));
        if (cancelled) return;
        setCases(body.cases || []);
        setMeta({ total: body.total ?? 0, page: body.page ?? 1, pageSize: body.pageSize ?? 20, totalPages: body.totalPages ?? 1 });
        pageRef.current = 1;
        setError("");
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("historyLoadError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tr]);
  const dateLocale = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" }[locale];
  return <section className="my-cases-section" aria-labelledby="case-history-title">
    <div className="content-heading"><div><h1 id="case-history-title">{tr("history")}</h1><p>{tr("historyDescription")}</p></div><button type="button" className="refresh-cases-button" onClick={() => { setLoading(true); void load(pageRef.current); }} disabled={loading}>{tr("refresh")}</button></div>
    {error ? <p className="case-alert" role="alert">{error}</p> : null}
    {loading ? <p className="case-list-empty" aria-live="polite">{tr("historyLoading")}</p> : cases.length === 0 ? <p className="case-list-empty">{tr("historyEmpty")}</p> : <>
      <div className="picker-case-list">{cases.map((item) => <article className="picker-case-row" key={item.id}>
        <div className="picker-case-main"><strong>{item.orderNumber}</strong><span>{tr("caseClosed")}{item.resolvedAt ? ` · ${new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.resolvedAt))}` : ""}</span></div>
        <button className="case-open-button" type="button" onClick={() => onOpenCase(item.id)}>{tr("reviewHistoryCase")}</button>
      </article>)}</div>
      <PaginationControls tr={tr} meta={meta} loading={loading} onPage={(page) => { setLoading(true); void load(page); }} />
    </>}
  </section>;
}
