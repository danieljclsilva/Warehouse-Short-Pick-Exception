import { afterEach, expect, it, vi } from "vitest";
import { runPushWorker, transientPushDatabaseCode } from "../src/server/push-worker-loop";

afterEach(() => { vi.useRealTimers(); });

it("waits for an in-flight batch and stops without overlapping another claim", async () => {
  const stop = new AbortController();
  let finish!: () => void;
  const batch = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const result = vi.fn();
  const running = runPushWorker(batch, stop.signal, result, 5);
  stop.abort();
  expect(result).not.toHaveBeenCalled();
  finish(); await running;
  expect(batch).toHaveBeenCalledTimes(1);
  expect(result).toHaveBeenCalledTimes(1);
});

it("aborts a long idle poll promptly and propagates errors for supervisor restart", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const batch = vi.fn(async () => "ready");
  let calls = 0;
  const running = runPushWorker(batch, stop.signal, () => { calls += 1; if (calls === 2) stop.abort(); }, 60_000);
  await vi.advanceTimersByTimeAsync(60_000);
  await running;
  expect(batch).toHaveBeenCalledTimes(2);
  await expect(runPushWorker(async () => { throw new Error("database unavailable"); }, new AbortController().signal, () => {})).rejects.toThrow("database unavailable");
});

it("recovers from a database restart with serial backoff and rechecks the schedule", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const interrupted = new Error("query with private parameters", { cause: Object.assign(new Error("private connection"), { code: "CONNECTION_CLOSED" }) });
  const batch = vi.fn().mockRejectedValueOnce(interrupted).mockRejectedValueOnce(interrupted).mockResolvedValue("sent");
  const schedule = vi.fn(async () => true);
  const retry = vi.fn();
  const result = vi.fn(() => stop.abort());
  const running = runPushWorker(batch, stop.signal, result, 5000, schedule, retry);
  await vi.advanceTimersByTimeAsync(4999);
  expect(batch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(batch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  await running;
  expect(batch).toHaveBeenCalledTimes(3);
  expect(schedule).toHaveBeenCalledTimes(3);
  expect(result).toHaveBeenCalledExactlyOnceWith("sent");
  expect(retry.mock.calls).toEqual([["CONNECTION_CLOSED", 1], ["CONNECTION_CLOSED", 2]]);
});

it("recovers configuration reads without sending until current hours are known", async () => {
  vi.useFakeTimers();
  const batch = vi.fn();
  const schedule = vi.fn().mockRejectedValueOnce({ code: "57P01" }).mockResolvedValue(false);
  const running = runPushWorker(batch, new AbortController().signal, () => {}, 5000, schedule);
  await vi.advanceTimersByTimeAsync(5000);
  await running;
  expect(batch).not.toHaveBeenCalled();
  expect(schedule).toHaveBeenCalledTimes(2);
});

it("cancels retry backoff promptly without claiming another batch", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const batch = vi.fn().mockRejectedValue({ code: "ECONNREFUSED" });
  const running = runPushWorker(batch, stop.signal, () => {});
  await vi.advanceTimersByTimeAsync(0);
  stop.abort();
  await running;
  expect(batch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("caps consecutive retries and preserves the original failure", async () => {
  vi.useFakeTimers();
  const failure = Object.assign(new Error("private data"), { code: "CONNECT_TIMEOUT" });
  const batch = vi.fn().mockRejectedValue(failure);
  const retry = vi.fn();
  const outcome = runPushWorker(batch, new AbortController().signal, () => {}, 5000, undefined, retry).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await outcome).toBe(failure);
  expect(batch).toHaveBeenCalledTimes(6);
  expect(retry).toHaveBeenCalledTimes(5);
});

it("resets the recovery budget after a successful batch", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const batch = vi.fn().mockRejectedValueOnce({ code: "57P01" }).mockResolvedValueOnce("first")
    .mockRejectedValueOnce({ code: "ECONNRESET" }).mockResolvedValue("second");
  const retry = vi.fn();
  const running = runPushWorker(batch, stop.signal, (result) => { if (result === "second") stop.abort(); }, 5000, undefined, retry);
  await vi.advanceTimersByTimeAsync(15_000);
  await running;
  expect(retry.mock.calls).toEqual([["57P01", 1], ["ECONNRESET", 1]]);
});

it("does not retry validation/SQL errors or infer codes from exception messages", async () => {
  const invalid = Object.assign(new Error("CONNECTION_CLOSED password=secret"), { code: "23505" });
  await expect(runPushWorker(async () => { throw invalid; }, new AbortController().signal, () => {})).rejects.toBe(invalid);
  expect(transientPushDatabaseCode(invalid)).toBeUndefined();
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  expect(transientPushDatabaseCode(cyclic)).toBeUndefined();
});
