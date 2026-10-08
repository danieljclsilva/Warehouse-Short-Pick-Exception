import { describe, expect, it, vi } from "vitest";
import { createVisibilityPoller, type VisibilityPollerEnv } from "@/components/use-visibility-polling";
import {
  refreshBadgeCounts,
  type BadgeFetchResponse,
  type BadgePollUser,
} from "@/components/badge-polling";

const admin: BadgePollUser = { id: "admin-1", role: "ADMIN", permissions: ["APPROVE_PROFILE_PHOTO"] };
const picker: BadgePollUser = { id: "picker-1", role: "PICKER", permissions: ["REPORT_SHORT_PICK"] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown): BadgeFetchResponse {
  return { ok: true, json: async () => body };
}

/**
 * Faithful mirror of the pre-fix baseline sequence: identical request order
 * and state writes, but no generation/validity re-checks after awaits. Used
 * only to prove the regression tests detect the old stale-write behavior.
 */
async function legacyRefreshBadges(options: {
  user: BadgePollUser | null;
  fetchJson: (url: string) => Promise<BadgeFetchResponse>;
  setUnreadCount: (count: number) => void;
  setPendingPhotoCount: (count: number) => void;
}): Promise<void> {
  const { user, fetchJson, setUnreadCount, setPendingPhotoCount } = options;
  if (!user) return;
  try {
    const response = await fetchJson("/api/notifications");
    if (response.ok) {
      const body = (await response.json()) as { unreadCount?: number };
      if (typeof body.unreadCount === "number") setUnreadCount(body.unreadCount);
    }
  } catch {
    /* badge-only; center shows errors */
  }
  if (!user.permissions.includes("APPROVE_PROFILE_PHOTO") && user.role !== "ADMIN") {
    setPendingPhotoCount(0);
    return;
  }
  try {
    const response = await fetchJson("/api/admin/profile-photos?page=1&pageSize=1");
    if (response.ok) {
      const body = (await response.json()) as { photos?: unknown[]; total?: number };
      setPendingPhotoCount(
        typeof body.total === "number" ? body.total : Array.isArray(body.photos) ? body.photos.length : 0,
      );
    }
  } catch {
    /* badge-only; queue shows errors */
  }
}

/** Mutable session harness mirroring the AuthApp generation contract. */
function createSession(initial: BadgePollUser | null, enabled = true) {
  const state = {
    user: initial,
    enabled,
    generation: 0,
    mounted: true,
  };
  const calls: string[] = [];
  const setUnreadCount = vi.fn();
  const setPendingPhotoCount = vi.fn();
  const isCurrent = (capturedUser: BadgePollUser | null, generation: number) =>
    state.mounted
    && state.enabled
    && state.generation === generation
    && capturedUser !== null
    && state.user?.id === capturedUser.id;
  return { state, calls, setUnreadCount, setPendingPhotoCount, isCurrent };
}

describe("refreshBadgeCounts cancellation", () => {
  it("writes both badges on the happy path with no added delay", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const photos = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return url === "/api/notifications" ? notifications.promise : photos.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    notifications.resolve(jsonResponse({ unreadCount: 4 }));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(session.calls).toContain("/api/admin/profile-photos?page=1&pageSize=1");
    photos.resolve(jsonResponse({ total: 2 }));
    await run;
  });

  it("logout mid-flight writes neither badge state", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return notifications.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    session.state.user = null;
    session.state.generation += 1;
    notifications.resolve(jsonResponse({ unreadCount: 9 }));
    await run;
    expect(session.setUnreadCount).not.toHaveBeenCalled();
    expect(session.setPendingPhotoCount).not.toHaveBeenCalled();
    expect(session.calls).toEqual(["/api/notifications"]);
  });

  it("user replacement mid-flight writes neither badge state", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return notifications.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    session.state.user = { id: "admin-2", role: "ADMIN", permissions: ["APPROVE_PROFILE_PHOTO"] };
    session.state.generation += 1;
    notifications.resolve(jsonResponse({ unreadCount: 7 }));
    await run;
    expect(session.setUnreadCount).not.toHaveBeenCalled();
    expect(session.setPendingPhotoCount).not.toHaveBeenCalled();
    expect(session.calls).toEqual(["/api/notifications"]);
  });

  it("a stale closure never fires the second request after permission loss", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return notifications.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    session.state.user = picker;
    session.state.generation += 1;
    notifications.resolve(jsonResponse({ unreadCount: 3 }));
    await run;
    expect(session.calls).toEqual(["/api/notifications"]);
    expect(session.setUnreadCount).not.toHaveBeenCalled();
    expect(session.setPendingPhotoCount).not.toHaveBeenCalled();
  });

  it("a current non-privileged user skips the admin request and clears the photo badge", async () => {
    const session = createSession(picker);
    const fetchJson = vi.fn(async () => jsonResponse({ unreadCount: 1 }));
    const generation = session.state.generation;
    await refreshBadgeCounts({
      user: picker,
      isCurrent: () => session.isCurrent(picker, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(session.setUnreadCount).toHaveBeenCalledWith(1);
    expect(session.setPendingPhotoCount).toHaveBeenCalledWith(0);
  });

  it("view-disable before the first write lands drops every badge write", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const photos = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return url === "/api/notifications" ? notifications.promise : photos.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    session.state.enabled = false;
    session.state.generation += 1;
    notifications.resolve(jsonResponse({ unreadCount: 5 }));
    photos.resolve(jsonResponse({ total: 6 }));
    await run;
    expect(session.setUnreadCount).not.toHaveBeenCalled();
    expect(session.setPendingPhotoCount).not.toHaveBeenCalled();
    expect(session.calls).toEqual(["/api/notifications"]);
  });

  it("view-disable after the second request fires drops only the pending write", async () => {
    const session = createSession(admin);
    const notifications = deferred<BadgeFetchResponse>();
    const photos = deferred<BadgeFetchResponse>();
    const fetchJson = vi.fn(async (url: string) => {
      session.calls.push(url);
      return url === "/api/notifications" ? notifications.promise : photos.promise;
    });
    const generation = session.state.generation;
    const run = refreshBadgeCounts({
      user: admin,
      isCurrent: () => session.isCurrent(admin, generation),
      fetchJson,
      setUnreadCount: session.setUnreadCount,
      setPendingPhotoCount: session.setPendingPhotoCount,
    });
    notifications.resolve(jsonResponse({ unreadCount: 5 }));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(session.calls).toContain("/api/admin/profile-photos?page=1&pageSize=1");
    expect(session.setUnreadCount).toHaveBeenCalledWith(5);
    session.state.enabled = false;
    session.state.generation += 1;
    photos.resolve(jsonResponse({ total: 6 }));
    await run;
    expect(session.setUnreadCount).toHaveBeenCalledTimes(1);
    expect(session.setPendingPhotoCount).not.toHaveBeenCalled();
  });
});

describe("legacy badge sequence (pre-fix baseline)", () => {
  it("writes stale badge state after logout mid-flight", async () => {
    const calls: string[] = [];
    const setUnreadCount = vi.fn();
    const setPendingPhotoCount = vi.fn();
    const notifications = deferred<BadgeFetchResponse>();
    const run = legacyRefreshBadges({
      user: admin,
      fetchJson: async (url: string) => {
        calls.push(url);
        return notifications.promise;
      },
      setUnreadCount,
      setPendingPhotoCount,
    });
    notifications.resolve(jsonResponse({ unreadCount: 9 }));
    await run;
    expect(setUnreadCount).toHaveBeenCalledWith(9);
  });

  it("fires the second request with a stale closure after permission loss", async () => {
    const calls: string[] = [];
    const setUnreadCount = vi.fn();
    const setPendingPhotoCount = vi.fn();
    const notifications = deferred<BadgeFetchResponse>();
    const photos = deferred<BadgeFetchResponse>();
    const run = legacyRefreshBadges({
      user: admin,
      fetchJson: async (url: string) => {
        calls.push(url);
        return url === "/api/notifications" ? notifications.promise : photos.promise;
      },
      setUnreadCount,
      setPendingPhotoCount,
    });
    notifications.resolve(jsonResponse({ unreadCount: 3 }));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    photos.resolve(jsonResponse({ total: 4 }));
    await run;
    expect(calls).toContain("/api/admin/profile-photos?page=1&pageSize=1");
    expect(setPendingPhotoCount).toHaveBeenCalledWith(4);
  });
});

describe("badge poller lifecycle", () => {
  function createEnv() {
    const intervals: Array<() => void> = [];
    const timeouts: Array<() => void> = [];
    const windowListeners: Record<string, Array<() => void>> = {};
    const documentListeners: Record<string, Array<() => void>> = {};
    const env: VisibilityPollerEnv = {
      isOnline: () => true,
      isVisible: () => true,
      setInterval: (callback) => {
        intervals.push(callback);
        return intervals.length - 1;
      },
      clearInterval: (id) => {
        intervals[id] = () => {};
      },
      setTimeout: (callback) => {
        timeouts.push(callback);
        return timeouts.length - 1;
      },
      clearTimeout: (id) => {
        timeouts[id] = () => {};
      },
      addWindowListener: (type, listener) => {
        windowListeners[type] = [...(windowListeners[type] ?? []), listener];
      },
      removeWindowListener: (type, listener) => {
        windowListeners[type] = (windowListeners[type] ?? []).filter((entry) => entry !== listener);
      },
      addDocumentListener: (type, listener) => {
        documentListeners[type] = [...(documentListeners[type] ?? []), listener];
      },
      removeDocumentListener: (type, listener) => {
        documentListeners[type] = (documentListeners[type] ?? []).filter((entry) => entry !== listener);
      },
    };
    return { env, intervals, timeouts, windowListeners, documentListeners };
  }

  async function drain() {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }

  it("overlapping remount runs don't double-write or leak timers/listeners", async () => {
    const first = createEnv();
    const second = createEnv();
    const firstPoll = vi.fn(async () => {});
    const secondPoll = vi.fn(async () => {});
    const firstPoller = createVisibilityPoller(firstPoll, 15_000, first.env);
    firstPoller.start();
    for (const callback of [...first.timeouts]) callback();
    await drain();
    await Promise.all(firstPoll.mock.results.map((result) => result.value));
    expect(firstPoll).toHaveBeenCalledTimes(1);

    // Remount: stop the old poller before starting the replacement one.
    firstPoller.stop();
    const secondPoller = createVisibilityPoller(secondPoll, 15_000, second.env);
    secondPoller.start();
    for (const callback of [...second.timeouts]) callback();
    await drain();
    await Promise.all(secondPoll.mock.results.map((result) => result.value));
    expect(secondPoll).toHaveBeenCalledTimes(1);

    // Old timers/listeners are inert after stop.
    for (const callback of [...first.intervals]) callback();
    for (const callback of [...first.timeouts]) callback();
    for (const listeners of Object.values(first.windowListeners)) for (const listener of [...listeners]) listener();
    for (const listeners of Object.values(first.documentListeners)) for (const listener of [...listeners]) listener();
    await drain();
    expect(firstPoll).toHaveBeenCalledTimes(1);

    expect(first.windowListeners.online ?? []).toHaveLength(0);
    expect(first.documentListeners.visibilitychange ?? []).toHaveLength(0);
    expect(second.windowListeners.online).toHaveLength(1);
    expect(second.documentListeners.visibilitychange).toHaveLength(1);

    secondPoller.stop();
    expect(second.windowListeners.online ?? []).toHaveLength(0);
    expect(second.documentListeners.visibilitychange ?? []).toHaveLength(0);
  });
});
