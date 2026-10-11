"use client";

/**
 * Narrow coordination helpers shared by NotificationCenter (queue, dedupe,
 * generation invalidation, focused-target handling) and AuthApp (badge
 * generation boundary). Every helper is imported by the components below, so
 * the regression tests exercise the real coordination instead of mirrors.
 */

export interface NotificationReadResult {
  readAt: string;
  unreadCount: number;
}

export interface MutationQueue {
  <T>(run: () => Promise<T>): Promise<T>;
}

/** Serialized mutation queue: overlapping writes resolve in call order. */
export function createMutationQueue(): MutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export interface PendingReadTracker<T> {
  read: (id: string) => Promise<T>;
  has: (id: string) => boolean;
}

/** Same-ID dedupe: overlapping reads share one request; failures clear it. */
export function createPendingReadTracker<T>(request: (id: string) => Promise<T>): PendingReadTracker<T> {
  const pending = new Map<string, Promise<T>>();
  const read = (id: string): Promise<T> => {
    const existing = pending.get(id);
    if (existing) return existing;
    const tracked = request(id).finally(() => {
      if (pending.get(id) === tracked) pending.delete(id);
    });
    pending.set(id, tracked);
    return tracked;
  };
  return {
    read,
    has(id: string): boolean {
      return pending.has(id);
    },
  };
}

export interface GenerationGuard {
  next: () => number;
  invalidate: () => number;
  isCurrent: (seen: number) => boolean;
  current: () => number;
}

/** Monotonic generation boundary: stale loads/polls drop their writes. */
export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    invalidate(): number {
      generation += 1;
      return generation;
    },
    isCurrent(seen: number): boolean {
      return seen === generation;
    },
    current(): number {
      return generation;
    },
  };
}

export interface FocusedTargetTracker {
  shouldFetch: (id: string | null | undefined) => id is string;
  markHandled: (id: string) => void;
  has: (id: string) => boolean;
}

/**
 * Focused push-target handling: each id is fetched until it is handled
 * (success or error). Cancelled effects never mark handled, so a retry on
 * re-run is still allowed; handled ids are never refetched.
 */
export function createFocusedTargetTracker(): FocusedTargetTracker {
  const handled = new Set<string>();
  return {
    shouldFetch(id: string | null | undefined): id is string {
      return typeof id === "string" && id.length > 0 && !handled.has(id);
    },
    markHandled(id: string): void {
      handled.add(id);
    },
    has(id: string): boolean {
      return handled.has(id);
    },
  };
}
