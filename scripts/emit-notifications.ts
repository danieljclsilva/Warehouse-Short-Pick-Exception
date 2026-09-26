import { closeDb } from "../src/db";
import { emitUnresolvedMonitoringNotifications } from "../src/server/notifications";

async function main() {
  try {
    const created = await emitUnresolvedMonitoringNotifications();
    console.log(`Created ${created} unresolved case notifications.`);
  } finally {
    await closeDb();
  }
}

void main();
