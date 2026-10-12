/** Serial polling: never overlap claims, and abort only the idle wait. */
export async function runPushWorker<T>(batch: () => Promise<T>, signal: AbortSignal, onResult: (result: T) => void, intervalMs = 5000,
  shouldRun?: () => Promise<boolean>) {
  while (!signal.aborted) {
    if (shouldRun && (!await shouldRun() || signal.aborted)) break;
    onResult(await batch());
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, intervalMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
