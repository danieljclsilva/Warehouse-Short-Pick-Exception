import { closeDb } from "../src/db";
import { recoverAdminPin } from "../src/server/admin-recovery";

const CONFIRMATION = "RESET_ADMIN_PIN_AND_REVOKE_SESSIONS";

async function main() {
  const identifier = process.env.ADMIN_RECOVERY_IDENTIFIER?.trim();
  const pin = process.env.ADMIN_RECOVERY_PIN;
  if (process.env.ADMIN_RECOVERY_CONFIRM !== CONFIRMATION) {
    throw new Error(`Set ADMIN_RECOVERY_CONFIRM=${CONFIRMATION} to authorize this privileged recovery.`);
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point to the intended database.");
  if (!identifier) throw new Error("Set ADMIN_RECOVERY_IDENTIFIER to the existing administrator's login identifier.");
  if (!pin || !/^\d{6,}$/.test(pin)) throw new Error("Set ADMIN_RECOVERY_PIN to a numeric PIN with at least 6 digits.");

  const recovered = await recoverAdminPin(identifier, pin);
  if (!recovered) throw new Error("No active administrator with that identifier was found; no changes were made.");
  console.log(`Administrator PIN recovered for ${identifier}. All existing sessions were revoked.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Administrator recovery failed");
  process.exitCode = 1;
}).finally(async () => {
  await closeDb();
});
