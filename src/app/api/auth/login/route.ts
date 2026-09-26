import { eq } from "drizzle-orm";
import { verify } from "@node-rs/argon2";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { parseJson, jsonError, handleRouteError } from "@/server/http";
import { digestToken, createToken, persistentSessionCookie } from "@/server/security";

const schema = z.object({ identifier: z.string().trim().min(1).max(100), pin: z.string().regex(/^\d{6,}$/, "PIN must contain at least 6 digits") });
const maxFailures = Math.max(1, Number.parseInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? "5", 10) || 5);
const lockMinutes = Math.max(1, Number.parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? "15", 10) || 15);

export async function POST(request: Request) {
  try {
    const { identifier, pin } = await parseJson(request, schema);
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(users).where(eq(users.identifier, identifier.toLowerCase())).for("update").limit(1);
      if (!candidate || candidate.status !== "ACTIVE") return { kind: "invalid" as const };
      const now = new Date();
      if (candidate.lockedUntil && candidate.lockedUntil > now) return { kind: "locked" as const };

      // Verify while holding the per-user row lock so a burst cannot race past the failure cap.
      const valid = await verify(candidate.pinHash, pin).catch(() => false);
      if (!valid) {
        const attempts = candidate.lockedUntil && candidate.lockedUntil <= now ? 1 : candidate.failedLoginAttempts + 1;
        await tx.update(users).set({ failedLoginAttempts: attempts, lockedUntil: attempts >= maxFailures ? new Date(Date.now() + lockMinutes * 60_000) : null }).where(eq(users.id, candidate.id));
        return { kind: "invalid" as const };
      }

      const token = createToken();
      await tx.update(users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, candidate.id));
      await tx.insert(sessions).values({ userId: candidate.id, tokenHash: digestToken(token) });
      await tx.insert(auditLog).values({ actorUserId: candidate.id, targetUserId: candidate.id, action: "LOGIN", details: {} });
      return { kind: "success" as const, user: candidate, token };
    });
    if (result.kind === "locked") return jsonError("Account temporarily locked", 423);
    if (result.kind !== "success") return jsonError("Invalid identifier or PIN", 401);
    const user = result.user;
    return Response.json({ user: { id: user.id, displayName: user.displayName, loginIdentifier: user.identifier, role: user.role, preferredLanguage: user.preferredLanguage, permissions: user.permissions } }, {
      headers: { "Set-Cookie": persistentSessionCookie(result.token) },
    });
  } catch (error) { return handleRouteError(error); }
}
