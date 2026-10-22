import { closeDb } from "../src/db";
import { deliverPushBatch } from "../src/server/push";
import { runPushWorker, transientPushDatabaseCode } from "../src/server/push-worker-loop";
import { logServerError, logServerEvent } from "../src/server/logger";
import { getCurrentConfiguration } from "../src/server/configuration";
import { shouldRunPushWorker } from "../src/server/push-worker-schedule";

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
console.log(JSON.stringify({ event: "push.worker.started", intervalMs: 5000 }));
void runPushWorker(() => deliverPushBatch(25), stop.signal, (counters) => {
  if (counters.attempted) console.log(JSON.stringify({ event: "push.worker.batch", ...counters }));
}, 5000, async () => {
  const configuration = await getCurrentConfiguration();
  return shouldRunPushWorker(configuration.values, new Date(), process.env.RAILWAY_ENVIRONMENT_NAME);
}, (code, attemptCount) => {
  logServerEvent("warn", "notification.push.database_retry", { area: "notifications", code, attemptCount });
}).catch((error) => {
  logServerError("notification.push.worker_failed", error, { area: "notifications", code: transientPushDatabaseCode(error) });
  process.exitCode = 1;
}).finally(async () => { await closeDb(); console.log(JSON.stringify({ event: "push.worker.stopped" })); });
