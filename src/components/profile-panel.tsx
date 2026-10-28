"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import type { Locale, MessageKey } from "@/i18n/messages";
import { hasHighPrivilegeAccess, type Role } from "@/domain/permissions";

type Profile = {
  id: string;
  displayName: string;
  role: string;
  status: string;
  preferredLanguage: Locale;
  profilePhotoStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
  credentialType: "PIN" | "PASSWORD";
  permissions?: string[];
  photoUrl?: string | null;
};
type Props = { locale: Locale; tr: (key: MessageKey, values?: Record<string, string>) => string; onLanguageChange: (locale: Locale) => void; onProfileSaved?: (profile: Pick<Profile, "id" | "displayName">) => void };

export function ProfilePanel({ locale, tr, onLanguageChange, onProfileSaved }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [current, setCurrent] = useState("");
  const [nextSecret, setNextSecret] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [targetType, setTargetType] = useState<"PIN" | "PASSWORD">("PIN");
  const [warningDismissed, setWarningDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { profile?: Profile; error?: string };
        if (!response.ok || !body.profile) throw new Error(body.error || tr("profileLoadError"));
        if (!cancelled) {
          setProfile(body.profile); setName(body.profile.displayName);
          setTargetType(body.profile.credentialType);
        }
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
      onProfileSaved?.({ id: body.profile.id, displayName: body.profile.displayName });
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

  const removePhoto = async () => {
    if (!window.confirm(tr("removePhotoConfirm"))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/profile/photo", { method: "DELETE", credentials: "same-origin" });
      const body = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || tr("photoUploadError"));
      setProfile(body.profile); setPhoto(null); setNotice(tr("photoRemoved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusy(false); }
  };

  const changeCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(""); setNotice("");
    if (!current || !nextSecret || !confirmSecret) { setError(tr("required")); return; }
    if (nextSecret !== confirmSecret) { setError(tr("credentialMismatch")); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetType === "PIN" ? { credential: "PIN", current, pin: nextSecret } : { credential: "PASSWORD", current, password: nextSecret }) });
      const body = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !body.profile) {
        if (response.status === 401) throw new Error(tr("wrongCurrentCredential"));
        throw new Error(body.error || tr("profileSaveError"));
      }
      setProfile(body.profile); setTargetType(body.profile.credentialType);
      setCurrent(""); setNextSecret(""); setConfirmSecret("");
      setNotice(tr("credentialSaved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusy(false); }
  };

  const showPasswordWarning = profile !== null
    && profile.credentialType === "PIN"
    && !warningDismissed
    && hasHighPrivilegeAccess(profile.role as Role, profile.permissions ?? []);

  return <div className="profile-page">
    <div className="content-heading"><div><h1>{tr("profileTitle")}</h1><p>{tr("profileDescription")}</p></div></div>
    {error && <p className="profile-message profile-error" role="alert">{error}</p>}
    {notice && <p className="profile-message profile-success" role="status">{notice}</p>}
    {!profile ? <p className="profile-empty" aria-live="polite">{tr("loading")}</p> : <>
      {showPasswordWarning && <div className="profile-message profile-warning" role="status">
        <p><strong>{tr("passwordRecommendationTitle")}</strong></p>
        <p>{tr("passwordRecommendationDescription")}</p>
        <button className="secondary-button" type="button" onClick={() => setWarningDismissed(true)}>{tr("dismiss")}</button>
      </div>}
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
      <section className="profile-card" aria-labelledby="profile-security-title">
        <h2 id="profile-security-title">{tr("securityTitle")}</h2><p>{tr("securityDescription")}</p>
        <p className="profile-credential-status"><span className="profile-credential-label">{tr("credentialCurrentLabel")}</span><span className={`credential-badge credential-badge-${profile.credentialType}`}>{tr(`credentialType${profile.credentialType}` as MessageKey)}</span></p>
        <form className="profile-form" onSubmit={changeCredential}>
          <fieldset className="credential-choice">
            <legend>{tr("credentialChoiceLegend")}</legend>
            <label className="credential-option"><input type="radio" name="credential-type" value="PIN" checked={targetType === "PIN"} onChange={() => { setTargetType("PIN"); setNextSecret(""); setConfirmSecret(""); }} /><span>{tr("credentialTypePIN")}</span><small>{tr("credentialHintPIN")}</small></label>
            <label className="credential-option"><input type="radio" name="credential-type" value="PASSWORD" checked={targetType === "PASSWORD"} onChange={() => { setTargetType("PASSWORD"); setNextSecret(""); setConfirmSecret(""); }} /><span>{tr("credentialTypePASSWORD")}</span><small>{tr("credentialHintPASSWORD")}</small></label>
          </fieldset>
          <label className="form-field"><span>{tr(`currentCredential${profile.credentialType}` as MessageKey)}</span><input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required /></label>
          {targetType === "PIN"
            ? <label className="form-field"><span>{tr("newCredentialPIN")}</span><input type="password" autoComplete="new-password" inputMode="numeric" value={nextSecret} onChange={(event) => setNextSecret(event.target.value.replace(/\D/g, ""))} placeholder={tr("pinPlaceholder")} minLength={6} required aria-describedby="credential-save-note" /></label>
            : <label className="form-field"><span>{tr("newCredentialPASSWORD")}</span><input type="password" autoComplete="new-password" value={nextSecret} onChange={(event) => setNextSecret(event.target.value)} minLength={8} maxLength={200} required aria-describedby="credential-save-note" /></label>}
          <label className="form-field"><span>{tr(`confirmCredential${targetType}` as MessageKey)}</span><input type="password" autoComplete="new-password" value={confirmSecret} onChange={(event) => setConfirmSecret(event.target.value)} required aria-describedby="credential-save-note" /></label>
          <p className="credential-note" id="credential-save-note">{tr("credentialSignOutNote")}</p>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("saving") : tr(`credentialSave${targetType}` as MessageKey)}</button>
        </form>
      </section>
      <section className="profile-card" aria-labelledby="profile-photo-title">
        <h2 id="profile-photo-title">{tr("profilePhotoTitle")}</h2><p>{tr("profilePhotoDescription")}</p>
        <form className="profile-photo-form" onSubmit={uploadPhoto}>
          <label className="form-field"><span>{tr("choosePhoto")}</span><input id="profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhoto(event.target.files?.[0] || null)} /></label>
          <button className="secondary-button" type="submit" disabled={busy || !photo}>{busy ? tr("uploadingPhoto") : tr("uploadPhoto")}</button>
        </form>
        {profile.profilePhotoStatus !== "NONE" && <button className="secondary-button profile-photo-remove" type="button" disabled={busy} onClick={() => void removePhoto()}>{tr("removePhoto")}</button>}
      </section>
    </>}
  </div>;
}
