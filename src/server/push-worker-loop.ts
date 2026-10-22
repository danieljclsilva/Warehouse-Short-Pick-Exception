// Only transport/restart errors are retryable. Never inspect or log SQL/messages.
const transientDatabaseCodes = new Set([
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
  "08000", "08001", "08003", "08006", "57P01", "57P02", "57P03", "53300",
]);

/** Drizzle wraps driver errors in cause; return only a fixed, safe code. */
export function transientPushDatabaseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && error && typeof error === "object" && !seen.has(error); depth += 1) {
    seen.add(error);
    const candidate = error as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && transientDatabaseCodes.has(candidate.code)) return candidate.code;
    error = candidate.cause;
  }
}

async function waitForPoll(signal: AbortSignal, milliseconds: number) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Serial polling with bounded recovery across database restarts; never overlap claims. */
export async function runPushWorker<T>(batch: () => Promise<T>, signal: AbortSignal, onResult: (result: T) => void, intervalMs = 5000,
  shouldRun?: () => Promise<boolean>, onRetry?: (code: string, attempt: number) => void) {
  let failures = 0;
  while (!signal.aborted) {
    let result: T;
    try {
      if (shouldRun && (!await shouldRun() || signal.aborted)) break;
      result = await batch();
    } catch (error) {
      if (signal.aborted) break;
      const code = transientPushDatabaseCode(error);
      if (!code || failures >= 5) throw error;
      failures += 1;
      onRetry?.(code, failures);
      await waitForPoll(signal, Math.min(5000 * 2 ** (failures - 1), 30_000));
      continue;
    }
    failures = 0;
    onResult(result);
    await waitForPoll(signal, intervalMs);
  }
}
