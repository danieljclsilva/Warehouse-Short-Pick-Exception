import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { hashPin } from "@/server/security";

/** Resets an existing active administrator's PIN and revokes every active session atomically. */
export async function recoverAdminPin(identifier: string, pin: string): Promise<boolean> {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  if (!normalizedIdentifier) throw new Error("An administrator identifier is required");
  if (!/^\d{6,}$/.test(pin)) throw new Error("PIN must contain at least 6 digits");

  const pinHash = await hashPin(pin);
  return getDb().transaction(async (tx) => {
    const [admin] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.identifier, normalizedIdentifier), eq(users.role, "ADMIN"), eq(users.status, "ACTIVE")))
      .for("update").limit(1);
    if (!admin) return false;
    const now = new Date();
    await tx.update(users).set({ pinHash, failedLoginAttempts: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, admin.id));
    await tx.update(sessions).set({ revokedAt: now, revokedReason: "admin_pin_recovery" })
      .where(and(eq(sessions.userId, admin.id), isNull(sessions.revokedAt)));
    await tx.insert(auditLog).values({ actorUserId: null, targetUserId: admin.id, action: "ADMIN_PIN_RECOVERED", details: { recoveryMethod: "privileged_cli" } });
    return true;
  });
}
