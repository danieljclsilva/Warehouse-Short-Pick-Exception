"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import type { MessageKey } from "@/i18n/messages";

type PendingPhoto = { id: string; userId: string; displayName: string; createdAt: string };
type Props = { tr: (key: MessageKey, values?: Record<string, string>) => string; onQueueChange?: (pendingCount: number) => void };

export function PhotoApproval({ tr, onQueueChange }: Props) {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/profile-photos", { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { photos?: PendingPhoto[]; error?: string };
      if (!response.ok) throw new Error(body.error || tr("photoQueueError"));
      setPhotos(body.photos || []);
      onQueueChange?.((body.photos || []).length);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setLoading(false); }
  }, [tr, onQueueChange]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/profile-photos", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { photos?: PendingPhoto[]; error?: string };
        if (!response.ok) throw new Error(body.error || tr("photoQueueError"));
        if (!cancelled) { setPhotos(body.photos || []); onQueueChange?.((body.photos || []).length); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("unknownError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tr, onQueueChange]);

  const decide = async (photo: PendingPhoto, decision: "approve" | "reject") => {
    setBusyId(photo.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/profile-photos/${encodeURIComponent(photo.id)}/${decision}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || tr("photoDecisionError"));
      setPhotos((current) => {
        const next = current.filter((item) => item.id !== photo.id);
        onQueueChange?.(next.length);
        return next;
      });
      setNotice(tr(decision === "approve" ? "photoApproved" : "photoRejected"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusyId(""); }
  };

  return <div className="photo-approval-page"><div className="content-heading"><div><h1>{tr("photoQueueTitle")}</h1><p>{tr("photoQueueDescription")}</p></div><button className="refresh-cases-button" type="button" onClick={() => { setLoading(true); void load(); }} disabled={loading}>{tr("refreshUsers")}</button></div>
    {error && <p className="profile-message profile-error" role="alert">{error}</p>}{notice && <p className="profile-message profile-success" role="status">{notice}</p>}
    {loading ? <p className="profile-empty" aria-live="polite">{tr("loading")}</p> : photos.length === 0 ? <p className="profile-empty">{tr("photoQueueEmpty")}</p> : <div className="photo-queue">{photos.map((photo) => <article className="photo-queue-card" key={photo.id}><Image src={`/api/profile/photo?userId=${encodeURIComponent(photo.userId)}`} alt={tr("pendingPhotoAlt", { name: photo.displayName })} width={92} height={92} sizes="(max-width: 760px) 68px, 92px" unoptimized /><div className="photo-queue-details"><strong>{photo.displayName}</strong><span>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(photo.createdAt))}</span></div><div className="photo-queue-actions"><button className="primary-button" type="button" disabled={busyId === photo.id} onClick={() => void decide(photo, "approve")}>{tr("approvePhoto")}</button><button className="revoke-button" type="button" disabled={busyId === photo.id} onClick={() => void decide(photo, "reject")}>{tr("rejectPhoto")}</button></div></article>)}</div>}
  </div>;
}
