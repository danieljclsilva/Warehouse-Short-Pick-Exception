import { afterEach, expect, it, vi } from "vitest";
import { runPushWorker } from "../src/server/push-worker-loop";

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
