import { count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { auditLog, users } from "../src/db/schema";
import { defaultPermissions } from "../src/domain/permissions";
import { hashPin } from "../src/server/security";

async function main() {
  const displayName = process.env.ADMIN_DISPLAY_NAME?.trim();
  const pin = process.env.ADMIN_PIN;
  const identifier = process.env.ADMIN_IDENTIFIER?.trim().toLowerCase() || `spx-admin-${randomUUID().slice(0, 8)}`;
  if (!displayName) throw new Error("Set ADMIN_DISPLAY_NAME before bootstrapping the first administrator.");
  if (!pin || !/^\d{6,}$/.test(pin)) throw new Error("Set ADMIN_PIN to a numeric PIN with at least 6 digits.");

  const db = getDb();
  const pinHash = await hashPin(pin);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(734820102)`);
    const [{ value: userCount }] = await tx.select({ value: count() }).from(users);
    if (userCount !== 0) throw new Error("Bootstrap is allowed only before any user exists.");
    const [user] = await tx.insert(users).values({ identifier, displayName, pinHash, role: "ADMIN", permissions: defaultPermissions("ADMIN") }).returning({ id: users.id });
    if (!user) throw new Error("Administrator insert failed.");
    await tx.insert(auditLog).values({ actorUserId: user.id, targetUserId: user.id, action: "BOOTSTRAP_ADMIN_CREATED", details: {} });
  });
  console.log(`Administrator created. Login identifier: ${identifier}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Administrator bootstrap failed");
  process.exitCode = 1;
});
