"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveRefreshState = "checking" | "fresh" | "stale";

/** Poll while the page is visible, and retry as soon as the browser reconnects. */
export function useLiveRefresh(refresh: () => Promise<void>, intervalMs = 5_000, enabled = true) {
  const refreshRef = useRef(refresh);
  const inFlight = useRef(false);
  const [state, setState] = useState<LiveRefreshState>("checking");

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const run = useCallback(async () => {
    if (!enabled || !navigator.onLine || document.visibilityState !== "visible" || inFlight.current) return;
    inFlight.current = true;
    try {
      await refreshRef.current();
      setState("fresh");
    } catch {
      setState("stale");
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const markOffline = () => setState("stale");
    const handleOnline = () => { setState("checking"); void run(); };
    const handleVisibility = () => { if (document.visibilityState === "visible") void run(); };
    const timer = window.setInterval(() => { void run(); }, intervalMs);
    const offlineTimer = !navigator.onLine ? window.setTimeout(markOffline, 0) : undefined;
    const initialTimer = navigator.onLine ? window.setTimeout(() => { void run(); }, 0) : undefined;

    window.addEventListener("offline", markOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      if (offlineTimer !== undefined) window.clearTimeout(offlineTimer);
      if (initialTimer !== undefined) window.clearTimeout(initialTimer);
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, intervalMs, run]);

  return state;
}
