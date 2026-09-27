import { closeDb } from "../src/db";
import { deliverPushBatch } from "../src/server/push";
import { logServerError } from "../src/server/logger";

async function main() {
  try {
    const result = await deliverPushBatch(25);
    console.log(JSON.stringify(result));
  } catch (error) {
    logServerError("notification.push.batch_failed", error, { area: "notifications" });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
