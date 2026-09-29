import { closeDb } from "../src/db";
import { emitUnresolvedMonitoringNotifications } from "../src/server/notifications";
import { logServerError, logServerEvent } from "../src/server/logger";

async function main() {
  try {
    // Success summary (cases scanned, eligible, created) is logged inside the
    // emitter; the stdout line stays for cron-runner human tailing.
    const created = await emitUnresolvedMonitoringNotifications();
    logServerEvent("info", "notification.monitoring.emit_succeeded", { area: "notifications", created });
    console.log(`Created ${created} unresolved case notifications.`);
  } catch (error) {
    logServerError("notification.monitoring.emit_failed", error, { area: "notifications" });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
