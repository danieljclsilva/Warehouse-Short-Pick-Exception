"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { PERMISSIONS, permissionsAllowedForRole, type Role } from "@/domain/permissions";
import type { MessageKey } from "@/i18n/messages";

type ManagedUser = { id: string; displayName: string; loginIdentifier: string; role: string; status: "ACTIVE" | "DISABLED" | "ARCHIVED"; preferredLanguage: string; permissions: string[]; profilePhotoStatus?: string; photoUrl?: string | null };
type Props = { actorId: string; actorRole: string; actorPermissions: string[]; tr: (key: MessageKey) => string };

const permissionManage: Record<string, string> = { PICKER: "EDIT_PICKER_PERMISSIONS", TROUBLESHOOTER: "EDIT_TROUBLESHOOTER_PERMISSIONS", ASSISTANT: "EDIT_ASSISTANT_PERMISSIONS", TEAM_LEADER: "EDIT_TL_PERMISSIONS" };

export function UserManagement({ actorId, actorRole, actorPermissions, tr }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pinTarget, setPinTarget] = useState("");
  const [pin, setPin] = useState("");
  const [permissionTarget, setPermissionTarget] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);

  const loadUsers = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/users", { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { users?: ManagedUser[]; error?: string };
      if (!response.ok) throw new Error(body.error || tr("usersLoadError"));
      setUsers(body.users || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setLoading(false); }
  }, [tr]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { users?: ManagedUser[]; error?: string };
        if (!response.ok) throw new Error(body.error || tr("usersLoadError"));
        if (!cancelled) setUsers(body.users || []);
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : tr("unknownError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tr]);

  const mutate = async (target: ManagedUser, input: Record<string, unknown>, success: string) => {
    setBusyId(target.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || tr("userActionError"));
      setNotice(success); await loadUsers();
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("unknownError")); }
    finally { setBusyId(""); }
  };

  const savePin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = users.find((candidate) => candidate.id === pinTarget);
    if (!target) return;
    await mutate(target, { action: "resetPin", pin }, tr("pinResetDone")); setPin(""); setPinTarget("");
  };
  const savePermissions = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = users.find((candidate) => candidate.id === permissionTarget);
    if (!target) return;
    await mutate(target, { action: "permissions", permissions }, tr("permissionsSaved")); setPermissionTarget("");
  };

  const canManage = (target: ManagedUser) => target.id !== actorId && (actorRole === "ADMIN" || actorRole === "TEAM_LEADER" && target.role !== "ADMIN" || actorRole === "ASSISTANT" && (target.role === "PICKER" || target.role === "TROUBLESHOOTER") && actorPermissions.includes(permissionManage[target.role] || ""));
  const canEditPermissions = (target: ManagedUser) => canManage(target) && (actorRole === "ADMIN" || actorRole === "TEAM_LEADER" || actorPermissions.includes(permissionManage[target.role] || ""));
  const editablePermission = (target: ManagedUser, permission: string) => {
    return permissionsAllowedForRole(target.role as Role, [permission]);
  };

  return <div className="users-page">
      <div className="content-heading"><div><h1>{tr("usersTitle")}</h1><p>{tr("usersDescription")}</p></div><button className="refresh-cases-button" type="button" onClick={() => { setLoading(true); void loadUsers(); }} disabled={loading}>{tr("refreshUsers")}</button></div>
    {error && <p className="profile-message profile-error" role="alert">{error}</p>}{notice && <p className="profile-message profile-success" role="status">{notice}</p>}
    {loading ? <p className="profile-empty" aria-live="polite">{tr("loading")}</p> : users.length === 0 ? <p className="profile-empty">{tr("usersEmpty")}</p> : <div className="users-list">{users.map((target) => {
      const manageable = canManage(target);
      const editable = canEditPermissions(target);
      return <article className="user-card" key={target.id}>
        <div className="user-card-heading">{target.profilePhotoStatus === "APPROVED" && target.photoUrl ? <Image className="avatar" src={target.photoUrl} alt="" width={34} height={34} unoptimized /> : <span className="avatar" aria-hidden="true">{target.displayName.slice(0, 1).toUpperCase()}</span>}<div className="user-primary"><strong>{target.displayName}</strong><span>{target.loginIdentifier}</span></div><span className={`invite-status ${target.status === "ACTIVE" ? "status-active" : "status-muted"}`}>{tr(`accountStatus${target.status}` as MessageKey)}</span></div>
        <dl className="user-facts"><div><dt>{tr("roleLabel")}</dt><dd>{tr(`role${target.role}` as MessageKey)}</dd></div><div><dt>{tr("language")}</dt><dd>{target.preferredLanguage.toUpperCase()}</dd></div><div><dt>{tr("permissionCount")}</dt><dd>{target.permissions.length}</dd></div><div><dt>{tr("profilePhotoTitle")}</dt><dd>{tr(`photoStatus${target.profilePhotoStatus || "NONE"}` as MessageKey)}</dd></div></dl>
        {manageable && <div className="user-actions">
          {editable && <button className="text-button" type="button" onClick={() => { setPermissionTarget(target.id); setPermissions(target.permissions); }}>{tr("editPermissions")}</button>}
          {actorPermissions.includes("DISABLE_USERS") && target.status !== "ARCHIVED" && <button className="text-button" type="button" disabled={busyId === target.id} onClick={() => void mutate(target, { action: "status", status: target.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }, tr("userStatusSaved"))}>{target.status === "ACTIVE" ? tr("disableUser") : tr("enableUser")}</button>}
          {actorPermissions.includes("ARCHIVE_USERS") && target.status !== "ARCHIVED" && <button className="revoke-button" type="button" disabled={busyId === target.id} onClick={() => void mutate(target, { action: "status", status: "ARCHIVED" }, tr("userStatusSaved"))}>{tr("archiveUser")}</button>}
          {actorPermissions.includes("ARCHIVE_USERS") && target.status === "ARCHIVED" && <button className="text-button" type="button" disabled={busyId === target.id} onClick={() => void mutate(target, { action: "status", status: "ACTIVE" }, tr("userStatusSaved"))}>{tr("restoreUser")}</button>}
          {actorPermissions.includes("RESET_USER_PIN") && <button className="text-button" type="button" onClick={() => setPinTarget(target.id)}>{tr("resetPin")}</button>}
          {actorPermissions.includes("REVOKE_USER_SESSIONS") && <button className="text-button" type="button" disabled={busyId === target.id} onClick={() => void mutate(target, { action: "revokeSessions" }, tr("sessionsRevoked"))}>{tr("revokeSessions")}</button>}
        </div>}
      </article>;
    })}</div>}
    {pinTarget && <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPinTarget(""); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-dialog-title"><h2 id="pin-dialog-title">{tr("resetPin")}</h2><form className="profile-form" onSubmit={savePin}><label className="form-field"><span>{tr("newPin")}</span><input type="password" inputMode="numeric" pattern="[0-9]{6,}" minLength={6} autoComplete="new-password" required value={pin} onChange={(event) => setPin(event.target.value)} /></label><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setPinTarget("")}>{tr("cancel")}</button><button className="primary-button" type="submit" disabled={busyId === pinTarget}>{tr("savePin")}</button></div></form></section></div>}
    {permissionTarget && users.find((target) => target.id === permissionTarget) && <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPermissionTarget(""); }}><section className="profile-dialog permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-dialog-title"><h2 id="permission-dialog-title">{tr("editPermissions")}</h2><p>{users.find((target) => target.id === permissionTarget)?.displayName}</p><form onSubmit={savePermissions}><div className="permission-list">{PERMISSIONS.filter((permission) => editablePermission(users.find((target) => target.id === permissionTarget)!, permission)).map((permission) => <label key={permission} className="permission-option"><input type="checkbox" checked={permissions.includes(permission)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, permission] : current.filter((item) => item !== permission))} /><span>{tr(`permission_${permission}` as MessageKey)}</span></label>)}</div><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setPermissionTarget("")}>{tr("cancel")}</button><button className="primary-button" type="submit" disabled={busyId === permissionTarget}>{tr("savePermissions")}</button></div></form></section></div>}
  </div>;
}
