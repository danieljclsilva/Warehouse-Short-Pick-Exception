import { closeDb } from "../src/db";
import { emitUnresolvedMonitoringNotifications } from "../src/server/notifications";
import { logServerError } from "../src/server/logger";

async function main() {
  try {
    const created = await emitUnresolvedMonitoringNotifications();
    console.log(`Created ${created} unresolved case notifications.`);
  } catch (error) {
    logServerError("notification.monitoring.emit_failed", error, { area: "notifications" });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
