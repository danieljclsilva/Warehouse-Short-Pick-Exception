import { closeDb } from "../src/db";
import { deliverPushBatch } from "../src/server/push";
import { runPushWorker } from "../src/server/push-worker-loop";
import { logServerError } from "../src/server/logger";

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
console.log(JSON.stringify({ event: "push.worker.started", intervalMs: 5000 }));
void runPushWorker(() => deliverPushBatch(25), stop.signal, (counters) => {
  if (counters.attempted) console.log(JSON.stringify({ event: "push.worker.batch", ...counters }));
}).catch((error) => {
  logServerError("notification.push.worker_failed", error, { area: "notifications" });
  process.exitCode = 1;
}).finally(async () => { await closeDb(); console.log(JSON.stringify({ event: "push.worker.stopped" })); });
