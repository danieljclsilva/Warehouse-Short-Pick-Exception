import { closeDb } from "../src/db";
import { deliverPushBatch } from "../src/server/push";
import { zodIssuePaths } from "../src/server/configuration";
import { logServerError } from "../src/server/logger";

async function main() {
  try {
    const result = await deliverPushBatch(25);
    console.log(JSON.stringify(result));
  } catch (error) {
    logServerError("notification.push.batch_failed", error, {
      area: "notifications",
      // Non-secret Zod issue paths only (key names, never messages/values).
      // safeContext drops the key when undefined (non-Zod errors).
      issueCode: zodIssuePaths(error).slice(0, 5).join(",") || undefined,
    });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
