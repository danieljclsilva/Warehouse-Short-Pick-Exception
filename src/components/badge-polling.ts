/**
 * Badge polling orchestration for AuthApp.
 *
 * The sequence is split into two dependent requests (notification unread
 * count, then the admin photo-review queue total). Either await can resolve
 * after the session changed: logout, a different user signing in, a reduced
 * role/permission set, the workspace view being left, or unmount. A stale run
 * must neither fire the second request with a stale user closure nor write
 * badge state that belongs to a previous session.
 *
 * Cancellation is generation-based rather than AbortController-based: the
 * caller captures a generation at call start and invalidates it on every
 * user/view transition and on unmount. This helper re-checks `isCurrent`
 * after each await (and before the second request) and returns early when
 * stale. No timers, retries, or delays live here, so fresh-user foreground
 * polling cadence is unchanged.
 */
export type BadgePollUser = {
  id: string;
  role: string;
  permissions: string[];
};

export type BadgeFetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

export type BadgePollDeps = {
  user: BadgePollUser | null;
  /** Synchronous still-current check: same user object, same generation, still enabled. */
  isCurrent: () => boolean;
  fetchJson: (url: string) => Promise<BadgeFetchResponse>;
  setUnreadCount: (count: number) => void;
  setPendingPhotoCount: (count: number) => void;
};

type NotificationsBody = { unreadCount?: number };
type PhotoQueueBody = { photos?: unknown[]; total?: number };

/** Sequential badge refresh that drops stale generations instead of writing them. */
export async function refreshBadgeCounts({
  user,
  isCurrent,
  fetchJson,
  setUnreadCount,
  setPendingPhotoCount,
}: BadgePollDeps): Promise<void> {
  if (!user || !isCurrent()) return;
  try {
    const response = await fetchJson("/api/notifications");
    if (!isCurrent()) return;
    if (response.ok) {
      const body = (await response.json()) as NotificationsBody;
      if (!isCurrent()) return;
      if (typeof body.unreadCount === "number") setUnreadCount(body.unreadCount);
    }
  } catch {
    /* Badge-only; the notification center surfaces fetch errors. */
  }
  if (!isCurrent()) return;
  if (!user.permissions.includes("APPROVE_PROFILE_PHOTO") && user.role !== "ADMIN") {
    setPendingPhotoCount(0);
    return;
  }
  try {
    const response = await fetchJson("/api/admin/profile-photos?page=1&pageSize=1");
    if (!isCurrent()) return;
    if (response.ok) {
      const body = (await response.json()) as PhotoQueueBody;
      if (!isCurrent()) return;
      setPendingPhotoCount(
        typeof body.total === "number" ? body.total : Array.isArray(body.photos) ? body.photos.length : 0,
      );
    }
  } catch {
    /* Badge-only; the photo queue surfaces fetch errors. */
  }
}
