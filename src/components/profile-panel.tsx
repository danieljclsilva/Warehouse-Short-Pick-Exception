"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import type { Locale, MessageKey } from "@/i18n/messages";

type Profile = {
  id: string;
  displayName: string;
  role: string;
  status: string;
  preferredLanguage: Locale;
  profilePhotoStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
  photoUrl?: string | null;
};
type Props = { locale: Locale; tr: (key: MessageKey) => string; onLanguageChange: (locale: Locale) => void };

export function ProfilePanel({ locale, tr, onLanguageChange }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { profile?: Profile; error?: string };
        if (!response.ok || !body.profile) throw new Error(body.error || tr("profileLoadError"));
        if (!cancelled) { setProfile(body.profile); setName(body.profile.displayName); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("unknownError")); });
    return () => { cancelled = true; };
  }, [tr]);

  const updateProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/profile", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: name.trim(), preferredLanguage: locale }) });
      const body = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || tr("profileSaveError"));
      setProfile(body.profile); setName(body.profile.displayName); setNotice(tr("profileSaved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusy(false); }
  };

  const uploadPhoto = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!photo) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const form = new FormData(); form.set("photo", photo);
      const response = await fetch("/api/profile/photo", { method: "POST", credentials: "same-origin", body: form });
      const body = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || tr("photoUploadError"));
      setProfile(body.profile); setPhoto(null); setNotice(tr("photoPendingNotice"));
      const input = document.getElementById("profile-photo-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusy(false); }
  };

  return <div className="profile-page">
    <div className="content-heading"><div><h1>{tr("profileTitle")}</h1><p>{tr("profileDescription")}</p></div></div>
    {error && <p className="profile-message profile-error" role="alert">{error}</p>}
    {notice && <p className="profile-message profile-success" role="status">{notice}</p>}
    {!profile ? <p className="profile-empty" aria-live="polite">{tr("loading")}</p> : <>
      <section className="profile-card" aria-labelledby="profile-details-title">
        <h2 id="profile-details-title">{tr("profileDetails")}</h2>
        <div className="profile-identity">
          {profile.profilePhotoStatus === "APPROVED" ? <Image className="profile-avatar" src={profile.photoUrl || "/api/profile/photo"} alt="" width={70} height={70} unoptimized /> : <span className="profile-avatar profile-avatar-initials" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</span>}
          <div><strong>{profile.displayName}</strong><span>{tr(`role${profile.role}` as MessageKey)}</span><span>{tr(`photoStatus${profile.profilePhotoStatus}` as MessageKey)}</span></div>
        </div>
        <form className="profile-form" onSubmit={updateProfile}>
          <label className="form-field"><span>{tr("displayName")}</span><input value={name} maxLength={100} autoComplete="name" required onChange={(event) => setName(event.target.value)} /></label>
          <label className="form-field"><span>{tr("language")}</span><select value={locale} onChange={(event) => onLanguageChange(event.target.value as Locale)}><option value="en">English</option><option value="nl">Nederlands</option><option value="pl">Polski</option><option value="es">Español</option></select></label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("saving") : tr("saveProfile")}</button>
        </form>
      </section>
      <section className="profile-card" aria-labelledby="profile-photo-title">
        <h2 id="profile-photo-title">{tr("profilePhotoTitle")}</h2><p>{tr("profilePhotoDescription")}</p>
        <form className="profile-photo-form" onSubmit={uploadPhoto}>
          <label className="form-field"><span>{tr("choosePhoto")}</span><input id="profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhoto(event.target.files?.[0] || null)} /></label>
          <button className="secondary-button" type="submit" disabled={busy || !photo}>{busy ? tr("uploadingPhoto") : tr("uploadPhoto")}</button>
        </form>
      </section>
    </>}
  </div>;
}
