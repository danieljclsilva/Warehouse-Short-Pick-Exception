"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { PaginationControls } from "@/components/pagination-controls";
import { PushSettings } from "@/components/push-settings";
import { useVisibilityPolling } from "@/components/use-visibility-polling";
import {
  createFocusedTargetTracker,
  createGenerationGuard,
  createMutationQueue,
  createPendingReadTracker,
  type MutationQueue,
  type NotificationReadResult,
  type PendingReadTracker,
} from "@/components/notification-read-coordination";
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
  focusedNotificationId?: string | null;
  onNotificationConsumed?: () => void;
  recipientScope?: string | null;
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
    CHECK_RESOLVED_EXTERNALLY: "notificationCheckResolvedExternally",
    ORDER_STAGED: "notificationOrderStaged",
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
export function NotificationCenter({ tr, locale, canManagePreferences, onOpenCase, onReviewPhotos, onUnreadChange, focusedNotificationId, onNotificationConsumed, recipientScope = null }: Props) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageMeta, setPageMeta] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [preferences, setPreferences] = useState<PreferenceState>(defaultPreferences);
  const [thresholds, setThresholds] = useState<ThresholdState>(defaultThresholds);
  const [loading, setLoading] = useState(true);
  const [preferencesLoading, setPreferencesLoading] = useState(canManagePreferences);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [error, setError] = useState("");
  const [focusedError, setFocusedError] = useState("");
  const [markAllError, setMarkAllError] = useState("");
  const [preferencesError, setPreferencesError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pushEnabledHere, setPushEnabledHere] = useState<boolean | null>(null);

  const generationRef = useRef(createGenerationGuard());
  const [mutationQueue] = useState<MutationQueue>(() => createMutationQueue());
  const trRef = useRef(tr);
  useEffect(() => { trRef.current = tr; }, [tr]);
  const [pendingReads] = useState<PendingReadTracker<NotificationReadResult>>(() => createPendingReadTracker<NotificationReadResult>((id) => mutationQueue(async () => {
    const response = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST", credentials: "same-origin" });
    const body = await readBody<{ id?: string; readAt?: string | null; unreadCount?: number; error?: string }>(response);
    if (!response.ok) throw new Error("NOTIFICATION_READ_FAILED");
    if (typeof body.unreadCount !== "number") throw new Error("NOTIFICATION_READ_FAILED");
    return { readAt: typeof body.readAt === "string" ? body.readAt : new Date().toISOString(), unreadCount: body.unreadCount };
  })));
  const pendingReadsRef = useRef(pendingReads);
  useEffect(() => { pendingReadsRef.current = pendingReads; }, [pendingReads]);
  const focusedTrackerRef = useRef(createFocusedTargetTracker());
  const unreadRef = useRef(0);
  useEffect(() => { unreadRef.current = unreadCount; }, [unreadCount]);

  const recipientScopeRef = useRef(recipientScope);
  useEffect(() => { recipientScopeRef.current = recipientScope; }, [recipientScope]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const onUnreadChangeRef = useRef(onUnreadChange);
  useEffect(() => { onUnreadChangeRef.current = onUnreadChange; }, [onUnreadChange]);
  const onOpenCaseRef = useRef(onOpenCase);
  useEffect(() => { onOpenCaseRef.current = onOpenCase; }, [onOpenCase]);
  const onReviewPhotosRef = useRef(onReviewPhotos);
  useEffect(() => { onReviewPhotosRef.current = onReviewPhotos; }, [onReviewPhotos]);
  const onNotificationConsumedRef = useRef(onNotificationConsumed);
  useEffect(() => { onNotificationConsumedRef.current = onNotificationConsumed; }, [onNotificationConsumed]);

  const applyServerCount = useCallback((nextUnread: number, scope: string | null) => {
    if (!mountedRef.current || recipientScopeRef.current !== scope) return;
    setUnreadCount(nextUnread);
    onUnreadChangeRef.current?.(nextUnread);
  }, []);

  const loadNotifications = useCallback(async (silent = false, nextPage = 1) => {
    const guard = generationRef.current;
    const generation = guard.next();
    const scope = recipientScopeRef.current;
    if (!silent) {
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      setLoading(true);
    }
    try {
      const response = await fetch(`/api/notifications?page=${nextPage}&pageSize=50`, { credentials: "same-origin", cache: "no-store" });
      const body = await readBody<NotificationsResponse & { total?: number; page?: number; pageSize?: number; totalPages?: number }>(response);
      if (!response.ok) throw new Error(body.error || tr("notificationsLoadError"));
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      if (!guard.isCurrent(generation)) {
        if (!silent) setLoading(false);
        return;
      }
      setNotifications(body.notifications || []);
      setPage(typeof body.page === "number" && body.page >= 1 ? body.page : nextPage);
      setPageMeta({
        total: typeof body.total === "number" ? body.total : (body.notifications || []).length,
        page: typeof body.page === "number" && body.page >= 1 ? body.page : nextPage,
        pageSize: typeof body.pageSize === "number" && body.pageSize >= 1 ? body.pageSize : 50,
        totalPages: typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : 1,
      });
      if (typeof body.unreadCount === "number") applyServerCount(body.unreadCount, scope);
      setError("");
      if (!silent) setLoading(false);
    } catch (cause) {
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      if (!guard.isCurrent(generation)) {
        if (!silent) setLoading(false);
        return;
      }
      setError(cause instanceof Error ? cause.message : tr("notificationsLoadError"));
      if (!silent) setLoading(false);
    }
  }, [tr, applyServerCount]);

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
  const pollNotifications = useCallback(() => loadNotifications(true, pageRef.current), [loadNotifications]);
  useVisibilityPolling(pollNotifications, 10_000, true, { immediate: false });
  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void loadNotifications(false, pageRef.current);
      if (canManagePreferences) void loadPreferences();
    }, 0);
    return () => { window.clearTimeout(initialTimer); };
  }, [canManagePreferences, loadNotifications, loadPreferences]);

  const readNotificationOnServer = useCallback((id: string) => pendingReads.read(id), [pendingReads]);

  const resolveTarget = useCallback((notification: NotificationRecord) => {
    const lineId = notification.shortPickLineId ?? null;
    const payload = asPayload(notification.payload);
    const payloadLineId = typeof payload.shortPickLineId === "string" ? payload.shortPickLineId
      : typeof payload.lineId === "string" ? payload.lineId : null;
    const targetLine = lineId ?? payloadLineId;
    return { targetLine, openTarget: { caseId: notification.caseId ?? "", lineId: targetLine, notification } satisfies NotificationOpenTarget };
  }, []);

  const markRead = useCallback(async (notification: NotificationRecord) => {
    const pending = pendingReadsRef.current;
    if (!pending || notification.readAt || pending.has(notification.id)) return;
    const guard = generationRef.current;
    const scope = recipientScopeRef.current;
    guard.invalidate();
    setBusyIds((current) => new Set(current).add(notification.id));
    try {
      const result = await readNotificationOnServer(notification.id);
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: result.readAt } : item));
      applyServerCount(result.unreadCount, scope);
    } catch {
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      setError(tr("notificationReadError"));
    } finally {
      if (mountedRef.current && recipientScopeRef.current === scope) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(notification.id);
          return next;
        });
      }
      guard.invalidate();
    }
  }, [applyServerCount, readNotificationOnServer, tr]);

  const markAllRead = useCallback(async () => {
    if (markAllBusy || unreadRef.current === 0) return;
    const guard = generationRef.current;
    const scope = recipientScopeRef.current;
    setMarkAllBusy(true);
    setMarkAllError("");
    guard.invalidate();
    const run = mutationQueue(async () => {
      const response = await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" });
      const body = await readBody<{ updated?: number; unreadCount?: number; error?: string }>(response);
      if (!response.ok) throw new Error(body.error || tr("markAllNotificationsReadError"));
      return typeof body.unreadCount === "number" ? body.unreadCount : 0;
    });
    try {
      const nextUnread = await run;
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => item.readAt ? item : { ...item, readAt }));
      applyServerCount(nextUnread, scope);
    } catch (cause) {
      if (!mountedRef.current || recipientScopeRef.current !== scope) return;
      setMarkAllError(cause instanceof Error ? cause.message : tr("markAllNotificationsReadError"));
    } finally {
      if (mountedRef.current && recipientScopeRef.current === scope) setMarkAllBusy(false);
      guard.invalidate();
    }
  }, [applyServerCount, markAllBusy, mutationQueue, tr]);

  const openNotificationCase = useCallback(async (
    notification: NotificationRecord,
    options?: { beforeNavigate?: () => void; shouldNavigate?: () => boolean },
  ): Promise<boolean> => {
    const openCase = onOpenCaseRef.current;
    const reviewPhotos = onReviewPhotosRef.current;
    const scope = recipientScopeRef.current;
    if (!openCase && !(notification.type === "PROFILE_PHOTO_APPROVAL_REQUIRED" && reviewPhotos)) return false;
    const navigate = (record: NotificationRecord) => {
      if (options?.shouldNavigate && !options.shouldNavigate()) return false;
      if (!mountedRef.current || recipientScopeRef.current !== scope) return false;
      options?.beforeNavigate?.();
      const { targetLine, openTarget } = resolveTarget(record);
      if (record.caseId && openCase) {
        openCase(record.caseId, targetLine, openTarget);
      } else if (record.type === "PROFILE_PHOTO_APPROVAL_REQUIRED" && reviewPhotos) {
        reviewPhotos();
      }
      return true;
    };
    if (notification.readAt) return navigate(notification);
    generationRef.current.invalidate();
    setBusyIds((current) => new Set(current).add(notification.id));
    try {
      // Unread, even with an in-flight deduped read: await the shared request
      // (no new fetch) so the global count applies before routing.
      const result = await readNotificationOnServer(notification.id);
      if (!mountedRef.current || recipientScopeRef.current !== scope) return false;
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: result.readAt } : item));
      applyServerCount(result.unreadCount, scope);
      return navigate({ ...notification, readAt: result.readAt });
    } catch {
      if (!mountedRef.current || recipientScopeRef.current !== scope) return false;
      setError(tr("notificationReadError"));
      return false;
    } finally {
      if (mountedRef.current && recipientScopeRef.current === scope) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(notification.id);
          return next;
        });
      }
      generationRef.current.invalidate();
    }
  }, [applyServerCount, readNotificationOnServer, resolveTarget, tr]);

  const openNotificationCaseRef = useRef(openNotificationCase);
  useEffect(() => { openNotificationCaseRef.current = openNotificationCase; }, [openNotificationCase]);

  useEffect(() => {
    const targetId = focusedNotificationId ?? null;
    const tracker = focusedTrackerRef.current;
    if (!tracker.shouldFetch(targetId)) return;
    let cancelled = false;
    const scope = recipientScopeRef.current;
    const consumeFocused = () => {
      if (!cancelled && mountedRef.current && recipientScopeRef.current === scope) {
        tracker.markHandled(targetId);
        onNotificationConsumedRef.current?.();
      }
    };
    (async () => {
      try {
        const response = await fetch(`/api/notifications/${encodeURIComponent(targetId)}`, { credentials: "same-origin", cache: "no-store" });
        const body = await readBody<{ notification?: NotificationRecord; error?: string; code?: string }>(response);
        if (!response.ok || !body.notification) {
          if (!cancelled && mountedRef.current && recipientScopeRef.current === scope) {
            setFocusedError(tr("notificationReadError"));
            tracker.markHandled(targetId);
            onNotificationConsumedRef.current?.();
          }
          return;
        }
        if (cancelled || !mountedRef.current || recipientScopeRef.current !== scope) return;
        const notification = body.notification;
        setNotifications((current) => current.some((item) => item.id === notification.id) ? current.map((item) => item.id === notification.id ? { ...item, ...notification } : item) : [notification, ...current]);
        // Consume before navigating: routing unmounts this center, so a
        // post-navigate consume would never run and the id would reopen.
        const opened = await openNotificationCaseRef.current(notification, {
          beforeNavigate: consumeFocused,
          shouldNavigate: () => !cancelled && mountedRef.current && recipientScopeRef.current === scope,
        });
        if (!opened && !cancelled && mountedRef.current && recipientScopeRef.current === scope) {
          setError("");
          setFocusedError(tr("notificationReadError"));
        }
      } catch {
        if (!cancelled && mountedRef.current && recipientScopeRef.current === scope) {
          setFocusedError(tr("notificationReadError"));
          tracker.markHandled(targetId);
          onNotificationConsumedRef.current?.();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [focusedNotificationId, tr]);
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

      <section className={`${styles.section} ${styles.notificationsSection} ${pushEnabledHere === false ? styles.notificationsSectionAfterPush : ""}`} aria-labelledby="notification-list-title">
        <div className={styles.sectionHeading}>
          <h2 id="notification-list-title">{tr("notificationUpdates")}</h2>
          <div className={styles.headingActions}>
            <button type="button" className={styles.refreshButton} onClick={() => void markAllRead()} disabled={markAllBusy || loading || unreadCount === 0}>{markAllBusy ? tr("saving") : tr("markAllNotificationsRead")}</button>
            <button type="button" className={styles.refreshButton} onClick={() => void loadNotifications(false, pageRef.current)} disabled={loading}>{tr("refresh")}</button>
          </div>
        </div>
        {markAllError && <p className={styles.preferenceError} role="alert">{markAllError}</p>}
        {focusedError && <div className={styles.error} role="alert"><span>{focusedError}</span></div>}
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
                  {notification.caseId && onOpenCase && <button type="button" className={styles.caseButton} onClick={() => void openNotificationCase(notification)} disabled={busyIds.has(notification.id)}>{tr("openCase")}</button>}
                  {!notification.readAt && <button type="button" className={styles.readButton} onClick={() => void markRead(notification)} disabled={busyIds.has(notification.id)}>{busyIds.has(notification.id) ? tr("saving") : tr("markNotificationRead")}</button>}
                </div>
              </article>
            ))}
          </div>
          <PaginationControls tr={tr} meta={pageMeta} loading={loading} onPage={(next) => void loadNotifications(false, next)} /></>
        )}
      </section>

      <section className={`${styles.section} ${styles.pushSettingsSection} ${pushEnabledHere === false ? styles.pushSectionFirst : ""}`}>
        <PushSettings tr={tr} locale={locale} onDeviceEnabledChange={setPushEnabledHere} />
      </section>

      {canManagePreferences && <section className={`${styles.section} ${styles.preferencesSection}`} aria-labelledby="notification-preferences-title">
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
