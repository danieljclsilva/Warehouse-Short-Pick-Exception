import { closeDb } from "../src/db";
import { deliverPushBatch } from "../src/server/push";

async function main() {
  try {
    const result = await deliverPushBatch(25);
    console.log(JSON.stringify(result));
  } finally {
    await closeDb();
  }
}

void main();
