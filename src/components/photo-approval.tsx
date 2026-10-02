"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { Locale, MessageKey } from "@/i18n/messages";
import { PaginationControls } from "@/components/pagination-controls";

type PendingPhoto = { id: string; userId: string; displayName: string; createdAt: string };
type Props = { locale: Locale; tr: (key: MessageKey, values?: Record<string, string>) => string; onQueueChange?: (pendingCount: number) => void };

const dateLocales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

export function formatPhotoApprovalDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(dateLocales[locale], { dateStyle: "medium" }).format(new Date(value));
}

export function PhotoApproval({ locale, tr, onQueueChange }: Props) {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageMeta, setPageMeta] = useState({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const applyPhotoPage = useCallback((body: { photos?: PendingPhoto[]; error?: string; total?: number; page?: number; pageSize?: number; totalPages?: number }, nextPage: number) => {
    setPhotos(body.photos || []);
    setPageMeta({
      total: typeof body.total === "number" ? body.total : (body.photos || []).length,
      page: typeof body.page === "number" && body.page >= 1 ? body.page : nextPage,
      pageSize: typeof body.pageSize === "number" && body.pageSize >= 1 ? body.pageSize : 20,
      totalPages: typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : 1,
    });
    onQueueChange?.(typeof body.total === "number" ? body.total : (body.photos || []).length);
  }, [onQueueChange]);
  const pageRef = useRef(pageMeta.page);
  useEffect(() => { pageRef.current = pageMeta.page; }, [pageMeta.page]);
  const load = useCallback(async (nextPage = 1) => {
    setError("");
    try {
      const response = await fetch(`/api/admin/profile-photos?page=${nextPage}&pageSize=20`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { photos?: PendingPhoto[]; error?: string; total?: number; page?: number; pageSize?: number; totalPages?: number };
      if (!response.ok) throw new Error(body.error || tr("photoQueueError"));
      applyPhotoPage(body, nextPage);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setLoading(false); }
  }, [tr, applyPhotoPage]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/profile-photos?page=1&pageSize=20", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { photos?: PendingPhoto[]; error?: string; total?: number; page?: number; pageSize?: number; totalPages?: number };
        if (!response.ok) throw new Error(body.error || tr("photoQueueError"));
        if (!cancelled) { applyPhotoPage(body, 1); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("unknownError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tr, applyPhotoPage]);
  const decide = async (photo: PendingPhoto, decision: "approve" | "reject") => {
    setBusyId(photo.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/profile-photos/${encodeURIComponent(photo.id)}/${decision}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || tr("photoDecisionError"));
      const remaining = photos.filter((item) => item.id !== photo.id);
      setPhotos(remaining);
      setPageMeta((meta) => {
        const total = typeof meta.total === "number" ? Math.max(0, meta.total - 1) : remaining.length;
        onQueueChange?.(total);
        return { ...meta, total, totalPages: Math.max(1, Math.ceil(total / meta.pageSize)) };
      });
      setNotice(tr(decision === "approve" ? "photoApproved" : "photoRejected"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusyId(""); }
  };

  return <div className="photo-approval-page"><div className="content-heading"><div><h1>{tr("photoQueueTitle")}</h1><p>{tr("photoQueueDescription")}</p></div><button className="refresh-cases-button" type="button" onClick={() => { setLoading(true); void load(pageRef.current); }} disabled={loading}>{tr("refreshUsers")}</button></div>
    {error && <p className="profile-message profile-error" role="alert">{error}</p>}{notice && <p className="profile-message profile-success" role="status">{notice}</p>}
    {loading ? <p className="profile-empty" aria-live="polite">{tr("loading")}</p> : photos.length === 0 ? <p className="profile-empty">{tr("photoQueueEmpty")}</p> : <><div className="photo-queue">{photos.map((photo) => <article className="photo-queue-card" key={photo.id}><Image src={`/api/profile/photo?userId=${encodeURIComponent(photo.userId)}`} alt={tr("pendingPhotoAlt", { name: photo.displayName })} width={92} height={92} sizes="(max-width: 760px) 68px, 92px" unoptimized /><div className="photo-queue-details"><strong>{photo.displayName}</strong><time dateTime={photo.createdAt}>{formatPhotoApprovalDate(photo.createdAt, locale)}</time></div><div className="photo-queue-actions"><button className="primary-button" type="button" disabled={busyId === photo.id} onClick={() => void decide(photo, "approve")}>{tr("approvePhoto")}</button><button className="revoke-button" type="button" disabled={busyId === photo.id} onClick={() => void decide(photo, "reject")}>{tr("rejectPhoto")}</button></div></article>)}</div><PaginationControls tr={tr} meta={pageMeta} loading={loading} onPage={(next) => { setLoading(true); void load(next); }} /></>}
  </div>;
}
