"use client";

import { useEffect, useRef } from "react";

/** Handle for a scheduled browser timer (window.setInterval / window.setTimeout ids). */
export type PollingTimer = number;

/** Browser surface the poller needs; injectable so the core is unit-testable. */
export type VisibilityPollerEnv = {
  isOnline: () => boolean;
  isVisible: () => boolean;
  setInterval: (callback: () => void, ms: number) => PollingTimer;
  clearInterval: (id: PollingTimer) => void;
  setTimeout: (callback: () => void, ms: number) => PollingTimer;
  clearTimeout: (id: PollingTimer) => void;
  addWindowListener: (type: string, listener: () => void) => void;
  removeWindowListener: (type: string, listener: () => void) => void;
  addDocumentListener: (type: string, listener: () => void) => void;
  removeDocumentListener: (type: string, listener: () => void) => void;
};

export type VisibilityPollingOptions = { immediate?: boolean };

/** Lazily binds the real browser globals; safe to import outside the browser. */
export function browserPollingEnv(): VisibilityPollerEnv {
  return {
    isOnline: () => navigator.onLine,
    isVisible: () => document.visibilityState === "visible",
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (id) => window.clearInterval(id),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
    addDocumentListener: (type, listener) => document.addEventListener(type, listener),
    removeDocumentListener: (type, listener) => document.removeEventListener(type, listener),
  };
}

export type VisibilityPoller = {
  /** Runs one poll when active, visible, online, and idle; resolves true when it polled. */
  run: () => Promise<boolean>;
  start: () => void;
  stop: () => void;
};

/**
 * Interval polling that costs nothing in background tabs or offline.
 * Skips ticks while hidden/offline, refetches promptly on
 * visibilitychange/online instead of waiting out a full interval, never
 * overlaps in-flight requests, and releases every timer/listener on stop.
 * Mirrors the guards in use-live-refresh for a consistent polling story.
 * Callers own error handling: poll must settle (not reject) its own failures.
 */
export function createVisibilityPoller(
  poll: () => Promise<void>,
  intervalMs: number,
  env: VisibilityPollerEnv = browserPollingEnv(),
  options: VisibilityPollingOptions = {},
): VisibilityPoller {
  const { immediate = true } = options;
  let active = false;
  let inFlight = false;
  let cleanup: Array<() => void> = [];

  const run = async (): Promise<boolean> => {
    if (!active || inFlight || !env.isOnline() || !env.isVisible()) return false;
    inFlight = true;
    try {
      await poll();
      return true;
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (active) return;
    active = true;
    const tick = () => { void run(); };
    const timerId = env.setInterval(tick, intervalMs);
    const initialId = immediate ? env.setTimeout(tick, 0) : null;
    const handleOnline = () => { void run(); };
    const handleVisibility = () => { if (env.isVisible()) void run(); };
    env.addWindowListener("online", handleOnline);
    env.addDocumentListener("visibilitychange", handleVisibility);
    cleanup = [
      () => env.clearInterval(timerId),
      ...(initialId !== null ? [() => env.clearTimeout(initialId)] : []),
      () => env.removeWindowListener("online", handleOnline),
      () => env.removeDocumentListener("visibilitychange", handleVisibility),
    ];
  };

  const stop = () => {
    active = false;
    for (const release of cleanup) release();
    cleanup = [];
  };

  return { run, start, stop };
}

/**
 * Poll on a fixed cadence while the page is visible and online.
 * Foreground cadence is unchanged; background/offline ticks are skipped
 * and resume with a prompt fetch. Tears everything down on unmount.
 */
export function useVisibilityPolling(
  poll: () => Promise<void>,
  intervalMs: number,
  enabled = true,
  options: VisibilityPollingOptions = {},
): void {
  const { immediate = true } = options;
  const pollRef = useRef(poll);
  useEffect(() => { pollRef.current = poll; }, [poll]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const poller = createVisibilityPoller(() => pollRef.current(), intervalMs, browserPollingEnv(), { immediate });
    poller.start();
    return () => { poller.stop(); };
  }, [enabled, intervalMs, immediate]);
}
