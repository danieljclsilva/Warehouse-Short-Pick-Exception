import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { verifyCredential } from "@/server/auth";
import { parseJson, jsonError, handleRouteError } from "@/server/http";
import { digestToken, createToken, persistentSessionCookie } from "@/server/security";
import { canManageConfigurationForUser, getCurrentConfiguration } from "@/server/configuration";
import { logServerEvent } from "@/server/logger";

const schema = z.object({ identifier: z.string().trim().min(1).max(100), pin: z.string().min(1).max(200) });
export async function POST(request: Request) {
  try {
    const { identifier, pin } = await parseJson(request, schema);
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const configuration = await getCurrentConfiguration(tx);
      const maxFailures = configuration.values.LOGIN_MAX_FAILED_ATTEMPTS;
      const lockMinutes = configuration.values.LOGIN_LOCKOUT_MINUTES;
      const [candidate] = await tx.select().from(users).where(eq(users.identifier, identifier.toLowerCase())).for("update").limit(1);
      if (!candidate || candidate.status !== "ACTIVE") return { kind: "invalid" as const, lockoutTriggered: false, lockoutMinutes: lockMinutes };
      const now = new Date();
      if (candidate.lockedUntil && candidate.lockedUntil > now) return { kind: "locked" as const, userId: candidate.id };

      // Verify while holding the per-user row lock so a burst cannot race past the failure cap.
      const valid = await verifyCredential(candidate, pin);
      if (!valid) {
        const attempts = candidate.lockedUntil && candidate.lockedUntil <= now ? 1 : candidate.failedLoginAttempts + 1;
        await tx.update(users).set({ failedLoginAttempts: attempts, lockedUntil: attempts >= maxFailures ? new Date(Date.now() + lockMinutes * 60_000) : null }).where(eq(users.id, candidate.id));
        return { kind: "invalid" as const, lockoutTriggered: attempts >= maxFailures, userId: candidate.id, lockoutMinutes: lockMinutes };
      }

      const token = createToken();
      await tx.update(users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, candidate.id));
      await tx.insert(sessions).values({ userId: candidate.id, tokenHash: digestToken(token) });
      await tx.insert(auditLog).values({ actorUserId: candidate.id, targetUserId: candidate.id, action: "LOGIN", details: {} });
      return { kind: "success" as const, user: candidate, token, canManageConfiguration: canManageConfigurationForUser(candidate, configuration.values) };
    });
    if (result.kind === "locked") {
      logServerEvent("warn", "auth.login.locked", { area: "auth", reason: "temporary_lockout", userId: result.userId });
      return jsonError("Account temporarily locked", 423);
    }
    if (result.kind !== "success") {
      logServerEvent("warn", "auth.login.failed", { area: "auth", reason: "invalid_credentials", ...(result.userId ? { userId: result.userId } : {}) });
      if (result.lockoutTriggered) logServerEvent("warn", "auth.login.lockout_triggered", { area: "auth", reason: "failed_attempt_limit", userId: result.userId, lockoutMinutes: result.lockoutMinutes });
      return jsonError("Invalid identifier or PIN/password", 401);
    }
    const user = result.user;
    return Response.json({ user: { id: user.id, displayName: user.displayName, loginIdentifier: user.identifier, role: user.role, preferredLanguage: user.preferredLanguage, permissions: user.permissions, canManageConfiguration: result.canManageConfiguration } }, {
      headers: { "Set-Cookie": persistentSessionCookie(result.token) },
    });
  } catch (error) { return handleRouteError(error); }
}
