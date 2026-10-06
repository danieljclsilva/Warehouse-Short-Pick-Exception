"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { PaginationControls } from "@/components/pagination-controls";
import { PushSettings } from "@/components/push-settings";
import styles from "./notification-center.module.css";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

type NotificationPayload = Record<string, unknown>;
type NotificationRecord = {
  id: string;
  type: string;
  caseId?: string | null;
  shortPickLineId?: string | null;
  payload?: NotificationPayload | null;
  createdAt: string;
  readAt?: string | null;
};
type NotificationsResponse = { notifications?: NotificationRecord[]; unreadCount?: number; error?: string };
type PreferencesResponse = { preferences?: Record<string, unknown>; thresholdMinutes?: Record<string, unknown>; error?: string };

type PreferenceKey =
  | "NEW_SHORT_PICK"
  | "CHECK_CLAIMED"
  | "NEW_LOCATION"
  | "TROUBLESHOOTER_MESSAGE"
  | "UNRESOLVED_OVER_THRESHOLD"
  | "CASE_RESOLVED";

type PreferenceState = Record<PreferenceKey, boolean>;
type ThresholdState = Record<PreferenceKey, number | null>;

export type NotificationOpenTarget = { caseId: string; lineId: string | null; notification: NotificationRecord };
type Props = {
  tr: Translator;
  locale: string;
  canManagePreferences: boolean;
  onOpenCase?: (caseId: string, lineId?: string | null, notification?: NotificationOpenTarget) => void;
  onReviewPhotos?: () => void;
  onUnreadChange?: (unreadCount: number) => void;
};


const dateLocales: Record<string, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

const defaultPreferences: PreferenceState = {
  NEW_SHORT_PICK: true,
  CHECK_CLAIMED: false,
  NEW_LOCATION: true,
  TROUBLESHOOTER_MESSAGE: true,
  UNRESOLVED_OVER_THRESHOLD: true,
  CASE_RESOLVED: false,
};

const defaultThresholds: ThresholdState = {
  NEW_SHORT_PICK: null,
  CHECK_CLAIMED: null,
  NEW_LOCATION: null,
  TROUBLESHOOTER_MESSAGE: null,
  UNRESOLVED_OVER_THRESHOLD: 10,
  CASE_RESOLVED: null,
};

const preferenceDefinitions: Array<{ key: PreferenceKey; label: MessageKey }> = [
  { key: "NEW_SHORT_PICK", label: "notificationPreferenceNewShortPick" },
  { key: "CHECK_CLAIMED", label: "notificationPreferenceCheckClaimed" },
  { key: "NEW_LOCATION", label: "notificationPreferenceNewLocation" },
  { key: "TROUBLESHOOTER_MESSAGE", label: "notificationPreferenceTroubleshooterMessage" },
  { key: "UNRESOLVED_OVER_THRESHOLD", label: "notificationPreferenceUnresolved" },
  { key: "CASE_RESOLVED", label: "notificationPreferenceCaseResolved" },
];

function asPayload(value: unknown): NotificationPayload {
  return value && typeof value === "object" && !Array.isArray(value) ? value as NotificationPayload : {};
}

function payloadText(payload: NotificationPayload, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(dateLocales[locale] || "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function notificationTitleKey(type: string): MessageKey {
  const normalized = type.toUpperCase().replace(/[-\s]/g, "_");
  const keys: Record<string, MessageKey> = {
    RESPONSIBILITY_CASE_ASSIGNED: "notificationResponsibilityChanged",
    RESPONSIBILITY_CHECK_ASSIGNED: "notificationCheckAssigned",
    RESPONSIBILITY_RETRIEVAL_ASSIGNED: "notificationRetrievalAssigned",
    RESPONSIBILITY_NEW_LOCATION: "notificationNewLocationFound",
    RESPONSIBILITY_CASE_REOPENED: "notificationCaseReopened",
    CHECK_ASSIGNED: "notificationCheckAssigned",
    CHECK_CLAIMED: "notificationCheckClaimed",
    NEW_LOCATION_FOUND: "notificationNewLocationFound",
    NEW_LOCATION: "notificationNewLocationFound",
    RETRIEVAL_ASSIGNED: "notificationRetrievalAssigned",
    TROUBLESHOOTER_ASSIGNED: "notificationTroubleshooterAssigned",
    CASE_RESPONSIBILITY_CHANGED: "notificationResponsibilityChanged",
    RESPONSIBILITY_CHANGED: "notificationResponsibilityChanged",
    CASE_MESSAGE: "notificationCaseMessage",
    CASE_MESSAGE_ADDED: "notificationCaseMessage",
    NEW_SHORT_PICK: "notificationNewShortPick",
    SHORT_PICK_REPORTED: "notificationNewShortPick",
    NEW_SHORT_PICK_REPORTED: "notificationNewShortPick",
    MONITOR_NEW_SHORT_PICK: "notificationNewShortPick",
    MONITOR_CHECK_CLAIMED: "notificationCheckClaimed",
    MONITOR_NEW_LOCATION: "notificationNewLocationFound",
    MONITOR_TROUBLESHOOTER_MESSAGE: "notificationCaseMessage",
    MONITOR_UNRESOLVED_OVER_THRESHOLD: "notificationCaseUnresolved",
    MONITOR_CASE_RESOLVED: "notificationCaseResolved",
    CASE_UNRESOLVED_THRESHOLD: "notificationCaseUnresolved",
    UNRESOLVED_OVER_THRESHOLD: "notificationCaseUnresolved",
    CASE_RESOLVED: "notificationCaseResolved",
    PROFILE_PHOTO_APPROVAL_REQUIRED: "notificationPhotoApprovalRequired",
    PHOTO_APPROVAL_REQUIRED: "notificationPhotoApprovalRequired",
  };
  return keys[normalized] ?? "notificationUpdate";
}

function readPreference(raw: Record<string, unknown>, key: PreferenceKey) {
  const camel = key.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = raw[key] ?? raw[camel] ?? raw[key.toLowerCase()];
  return typeof value === "boolean" ? value : defaultPreferences[key];
}

function normalizePreferences(raw: Record<string, unknown> | undefined): PreferenceState {
  return preferenceDefinitions.reduce((result, definition) => {
    result[definition.key] = readPreference(raw || {}, definition.key);
    return result;
  }, { ...defaultPreferences });
}

function normalizeThresholds(raw: Record<string, unknown> | undefined): ThresholdState {
  return preferenceDefinitions.reduce((result, definition) => {
    const value = raw?.[definition.key];
    result[definition.key] = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultThresholds[definition.key];
    return result;
  }, { ...defaultThresholds });
}

async function readBody<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}
export function NotificationCenter({ tr, locale, canManagePreferences, onOpenCase, onReviewPhotos, onUnreadChange }: Props) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageMeta, setPageMeta] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [preferences, setPreferences] = useState<PreferenceState>(defaultPreferences);
  const [thresholds, setThresholds] = useState<ThresholdState>(defaultThresholds);
  const [loading, setLoading] = useState(true);
  const [preferencesLoading, setPreferencesLoading] = useState(canManagePreferences);
  const [busyId, setBusyId] = useState("");
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [error, setError] = useState("");
  const [markAllError, setMarkAllError] = useState("");
  const [preferencesError, setPreferencesError] = useState("");
  const [saved, setSaved] = useState(false);

  const loadNotifications = useCallback(async (silent = false, nextPage = 1) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/notifications?page=${nextPage}&pageSize=50`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody<NotificationsResponse & { total?: number; page?: number; pageSize?: number; totalPages?: number }>(response);
      if (!response.ok) throw new Error(body.error || tr("notificationsLoadError"));
      setNotifications(body.notifications || []);
      setPage(typeof body.page === "number" && body.page >= 1 ? body.page : nextPage);
      setPageMeta({
        total: typeof body.total === "number" ? body.total : (body.notifications || []).length,
        page: typeof body.page === "number" && body.page >= 1 ? body.page : nextPage,
        pageSize: typeof body.pageSize === "number" && body.pageSize >= 1 ? body.pageSize : 50,
        totalPages: typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : 1,
      });
      const nextUnread = typeof body.unreadCount === "number" ? body.unreadCount : (body.notifications || []).filter((notification) => !notification.readAt).length;
      setUnreadCount(nextUnread);
      onUnreadChange?.(nextUnread);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("notificationsLoadError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [tr, onUnreadChange]);

  const loadPreferences = useCallback(async () => {
    if (!canManagePreferences) return;
    setPreferencesLoading(true);
    try {
      const response = await fetch("/api/notifications/preferences", { credentials: "same-origin", cache: "no-store" });
      const body = await readBody<PreferencesResponse>(response);
      if (!response.ok) throw new Error(body.error || tr("notificationPreferencesLoadError"));
      setPreferences(normalizePreferences(body.preferences));
      setThresholds(normalizeThresholds(body.thresholdMinutes));
      setPreferencesError("");
    } catch (cause) {
      setPreferencesError(cause instanceof Error ? cause.message : tr("notificationPreferencesLoadError"));
    } finally {
      setPreferencesLoading(false);
    }
  }, [canManagePreferences, tr]);

  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void loadNotifications(false, pageRef.current);
      if (canManagePreferences) void loadPreferences();
    }, 0);
    const timer = window.setInterval(() => { void loadNotifications(true, pageRef.current); }, 10_000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, [canManagePreferences, loadNotifications, loadPreferences]);

  const markRead = async (notification: NotificationRecord) => {
    if (notification.readAt || busyId === notification.id) return;
    setBusyId(notification.id);
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST", credentials: "same-origin" });
      const body = await readBody<{ error?: string }>(response);
      if (!response.ok) throw new Error(body.error || tr("notificationReadError"));
      const readAt = new Date().toISOString();
      const nextItems = notifications.map((item) => item.id === notification.id ? { ...item, readAt } : item);
      const nextUnread = nextItems.filter((item) => !item.readAt).length;
      setNotifications(nextItems);
      setUnreadCount(nextUnread);
      onUnreadChange?.(nextUnread);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("notificationReadError"));
    } finally {
      setBusyId("");
    }
  };

  const markAllRead = async () => {
    if (markAllBusy || unreadCount === 0) return;
    setMarkAllBusy(true);
    setMarkAllError("");
    try {
      const response = await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" });
      const body = await readBody<{ updated?: number; unreadCount?: number; error?: string }>(response);
      if (!response.ok) throw new Error(body.error || tr("markAllNotificationsReadError"));
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => item.readAt ? item : { ...item, readAt }));
      const nextUnread = typeof body.unreadCount === "number" ? body.unreadCount : 0;
      setUnreadCount(nextUnread);
      onUnreadChange?.(nextUnread);
    } catch (cause) {
      setMarkAllError(cause instanceof Error ? cause.message : tr("markAllNotificationsReadError"));
    } finally {
      setMarkAllBusy(false);
    }
  };

  const openNotificationCase = (notification: NotificationRecord) => {
    if (!notification.caseId || !onOpenCase) return;
    if (!notification.readAt && busyId !== notification.id) {
      setBusyId(notification.id);
      void (async () => {
        try {
          const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST", credentials: "same-origin" });
          const body = await readBody<{ error?: string }>(response);
          if (!response.ok) throw new Error(body.error || tr("notificationReadError"));
          const readAt = new Date().toISOString();
          const nextItems = notifications.map((item) => item.id === notification.id ? { ...item, readAt } : item);
          const nextUnread = nextItems.filter((item) => !item.readAt).length;
          setNotifications(nextItems);
          setUnreadCount(nextUnread);
          onUnreadChange?.(nextUnread);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : tr("notificationReadError"));
        } finally {
          setBusyId("");
        }
      })();
    }
    const lineId = notification.shortPickLineId ?? null;
    const payload = asPayload(notification.payload);
    const payloadLineId = typeof payload.shortPickLineId === "string" ? payload.shortPickLineId
      : typeof payload.lineId === "string" ? payload.lineId : null;
    onOpenCase(notification.caseId, lineId ?? payloadLineId, { caseId: notification.caseId, lineId: lineId ?? payloadLineId, notification });
  };

  const savePreferences = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingPreferences(true);
    setSaved(false);
    setPreferencesError("");
    try {
      const response = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ preferences, thresholdMinutes: { UNRESOLVED_OVER_THRESHOLD: thresholds.UNRESOLVED_OVER_THRESHOLD } }),
      });
      const body = await readBody<PreferencesResponse>(response);
      if (!response.ok) throw new Error(body.error || tr("notificationPreferencesSaveError"));
      if (body.preferences) setPreferences(normalizePreferences(body.preferences));
      if (body.thresholdMinutes) setThresholds(normalizeThresholds(body.thresholdMinutes));
      setSaved(true);
    } catch (cause) {
      setPreferencesError(cause instanceof Error ? cause.message : tr("notificationPreferencesSaveError"));
    } finally {
      setSavingPreferences(false);
    }
  };

  const notificationRows = useMemo(() => notifications.map((notification) => {
    const payload = asPayload(notification.payload);
    const isPhotoApproval = notification.type === "PROFILE_PHOTO_APPROVAL_REQUIRED";
    const detailParts = [
      payloadText(payload, "orderNumber", "order_number"),
      payloadText(payload, "location", "discoveredLocation", "discovered_location"),
      payloadText(payload, "actorName", "actor_name", "responsibleName", "responsible_name"),
      isPhotoApproval ? payloadText(payload, "photoOwnerDisplayName", "photoOwnerName", "displayName") : "",
    ].filter(Boolean);
    return { notification, payload, detailParts, isPhotoApproval };
  }), [notifications]);

  return (
    <div className={styles.center}>
      <div className={styles.heading}>
        <div>
          <h1>{tr("notificationsTitle")}</h1>
          <p>{tr("notificationsDescription")}</p>
        </div>
        <span className={styles.unreadBadge} aria-live="polite">{tr("notificationsUnread", { count: String(unreadCount) })}</span>
      </div>

      <section className={styles.section} aria-labelledby="notification-list-title">
        <div className={styles.sectionHeading}>
          <h2 id="notification-list-title">{tr("notificationUpdates")}</h2>
          <div className={styles.headingActions}>
            <button type="button" className={styles.refreshButton} onClick={() => void markAllRead()} disabled={markAllBusy || loading || unreadCount === 0}>{markAllBusy ? tr("saving") : tr("markAllNotificationsRead")}</button>
            <button type="button" className={styles.refreshButton} onClick={() => void loadNotifications(false, pageRef.current)} disabled={loading}>{tr("refresh")}</button>
          </div>
        </div>
        {markAllError && <p className={styles.preferenceError} role="alert">{markAllError}</p>}
        {loading ? <p className={styles.loading} aria-live="polite">{tr("notificationsLoading")}</p> : error ? (
          <div className={styles.error} role="alert"><span>{error}</span><div className={styles.errorActions}><button type="button" className={styles.refreshButton} onClick={() => void loadNotifications(false, pageRef.current)}>{tr("tryAgain")}</button></div></div>
        ) : notificationRows.length === 0 ? <p className={styles.empty}>{tr("notificationsEmpty")}</p> : (
          <><div className={styles.list}>
            {notificationRows.map(({ notification, payload, detailParts, isPhotoApproval }) => (
              <article className={`${styles.row} ${notification.readAt ? "" : styles.rowUnread}`} key={notification.id}>
                <span className={styles.dot} aria-hidden="true" />
                <div className={styles.rowContent}>
                  <h3 className={styles.rowTitle}>{tr(notificationTitleKey(notification.type))}</h3>
                  {detailParts.length > 0 && <div className={styles.rowDetails}>{detailParts.map((part, index) => <span key={`${notification.id}-${index}`}>{part}</span>)}</div>}
                  {payloadText(payload, "message", "note", "reason") && <div className={styles.rowDetails}><span>{payloadText(payload, "message", "note", "reason")}</span></div>}
                  <time className={styles.rowTime} dateTime={notification.createdAt}>{formatDate(notification.createdAt, locale)}</time>
                </div>
                <div className={styles.rowActions}>
                  {isPhotoApproval && onReviewPhotos && <button type="button" className={styles.caseButton} onClick={onReviewPhotos}>{tr("reviewPhoto")}</button>}
                  {notification.caseId && onOpenCase && <button type="button" className={styles.caseButton} onClick={() => void openNotificationCase(notification)} disabled={busyId === notification.id}>{tr("openCase")}</button>}
                  {!notification.readAt && <button type="button" className={styles.readButton} onClick={() => void markRead(notification)} disabled={busyId === notification.id}>{busyId === notification.id ? tr("saving") : tr("markNotificationRead")}</button>}
                </div>
              </article>
            ))}
          </div>
          <PaginationControls tr={tr} meta={pageMeta} loading={loading} onPage={(next) => void loadNotifications(false, next)} /></>
        )}
      </section>

      <section className={styles.section}>
        <PushSettings tr={tr} locale={locale} />
      </section>

      {canManagePreferences && <section className={styles.section} aria-labelledby="notification-preferences-title">
        <div className={styles.sectionHeading}><h2 id="notification-preferences-title">{tr("notificationPreferencesTitle")}</h2></div>
        <form className={styles.preferences} onSubmit={savePreferences}>
          <p className={styles.preferencesIntro}>{tr("notificationPreferencesDescription")}</p>
          {preferencesLoading ? <p className={styles.loading}>{tr("notificationsLoading")}</p> : <>
            <dl className={styles.preferenceList}>
              {preferenceDefinitions.map((definition) => <div className={styles.preferenceRow} key={definition.key}>
                <dt>{tr(definition.label)}{definition.key === "UNRESOLVED_OVER_THRESHOLD" && <label className={styles.thresholdField}><span>{tr("notificationThresholdMinutes")}</span><input type="number" min={1} max={1440} step={1} value={thresholds.UNRESOLVED_OVER_THRESHOLD ?? 10} onChange={(event) => { setSaved(false); setThresholds((current) => ({ ...current, UNRESOLVED_OVER_THRESHOLD: Number(event.target.value) || 1 })); }} /></label>}</dt>
                <dd><label className={styles.toggleLabel}><input type="checkbox" checked={preferences[definition.key]} onChange={(event) => { setSaved(false); setPreferences((current) => ({ ...current, [definition.key]: event.target.checked })); }} /><span>{preferences[definition.key] ? tr("notificationPreferenceOn") : tr("notificationPreferenceOff")}</span></label></dd>
              </div>)}
            </dl>
            <p className={styles.responsibilityNote}>{tr("responsibilityNotificationsAlwaysOn")}</p>
            {preferencesError && <p className={styles.preferenceError} role="alert">{preferencesError}</p>}
            <div className={styles.preferenceActions}><span className={styles.saved} role="status">{saved ? tr("notificationPreferencesSaved") : ""}</span><button className={styles.saveButton} type="submit" disabled={savingPreferences || preferencesLoading}>{savingPreferences ? tr("saving") : tr("saveNotificationPreferences")}</button></div>
          </>}
        </form>
      </section>}
    </div>
  );
}
