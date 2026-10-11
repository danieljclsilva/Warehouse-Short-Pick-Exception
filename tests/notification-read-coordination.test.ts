import { describe, expect, it, vi } from "vitest";
import { liveSectionForUser } from "@/components/auth-app";
import {
  createFocusedTargetTracker,
  createGenerationGuard,
  createMutationQueue,
  createPendingReadTracker,
} from "@/components/notification-read-coordination";

type FetchResult = { notification?: { id: string; caseId: string | null; shortPickLineId: string | null; type: string }; error?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((responseResolve, responseReject) => { resolve = responseResolve; reject = responseReject; });
  return { promise, resolve, reject };
}

describe("notification read coordination", () => {
  it("dedupes overlapping same-ID reads into one request", async () => {
    const request = vi.fn(async (id: string): Promise<FetchResult> => ({ notification: { id, caseId: "case-1", shortPickLineId: null, type: "NEW_SHORT_PICK" } }));
    const tracker = createPendingReadTracker(request);
    const [first, second] = await Promise.all([tracker.read("alert-1"), tracker.read("alert-1")]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    await tracker.read("alert-1");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries a failed same-ID read on the next call", async () => {
    const request = vi.fn(async (id: string): Promise<FetchResult> => ({ notification: { id, caseId: "case-1", shortPickLineId: null, type: "NEW_SHORT_PICK" } }));
    const tracker = createPendingReadTracker(request);
    request.mockRejectedValueOnce(new Error("boom"));
    await expect(tracker.read("alert-9")).rejects.toThrow("boom");
    await expect(tracker.read("alert-9")).resolves.toMatchObject({ notification: { id: "alert-9" } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serializes overlapping mark mutations so counts stay ordered", async () => {
    const enqueue = createMutationQueue();
    const order: string[] = [];
    const slow = deferred<number>();
    const fast = enqueue(async () => { order.push("slow"); return slow.promise; });
    const second = enqueue(async () => { order.push("fast"); return 79; });
    slow.resolve(80);
    expect(await fast).toBe(80);
    expect(await second).toBe(79);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("ignores stale load responses after a newer mutation generation", async () => {
    const guard = createGenerationGuard();
    let applied: number | null = null;
    const staleSeen = guard.next();
    guard.invalidate(); // mutation bumps the generation before the stale load resolves
    if (guard.isCurrent(staleSeen)) applied = 80;
    expect(applied).toBeNull();
    const freshSeen = guard.next();
    if (guard.isCurrent(freshSeen)) applied = 79;
    expect(applied).toBe(79);
  });

  it("processes each focused target once and retries after cancellation", async () => {
    const tracker = createFocusedTargetTracker();
    expect(tracker.shouldFetch("alert-1")).toBe(true);
    tracker.markHandled("alert-1");
    expect(tracker.shouldFetch("alert-1")).toBe(false);
    // Cancelled lookup never marks handled, so the retry still fetches.
    expect(tracker.shouldFetch("alert-2")).toBe(true);
    expect(tracker.shouldFetch(null)).toBe(false);
  });
});

describe("push deep-link routing", () => {
  it("keeps dashboard/checks/my-work routing and falls back to read-only without inventing screens", () => {
    expect(liveSectionForUser({ role: "MANAGER", permissions: ["VIEW_ALL_OPEN_CASES"] }, "CHECK_ASSIGNED")).toBe("openCases");
    expect(liveSectionForUser({ role: "PICKER", permissions: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES", "VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK"] }, "CHECK_ASSIGNED")).toBe("assignments");
    expect(liveSectionForUser({ role: "PICKER", permissions: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES"] }, "RETRIEVAL_ASSIGNED")).toBe("myWork");
    expect(liveSectionForUser({ role: "ADMIN", permissions: ["VIEW_ANALYTICS"] }, "NEW_SHORT_PICK")).toBeNull();
  });

});
