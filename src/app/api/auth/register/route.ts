import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, invites, sessions, users } from "@/db/schema";
import { ROLES } from "@/domain/permissions";
import { hashPin } from "@/server/security";
import { createToken, digestToken, persistentSessionCookie } from "@/server/security";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

const schema = z.object({
  inviteToken: z.string().min(20).max(200),
  displayName: z.string().trim().min(1).max(100),
  pin: z.string().regex(/^\d{6,}$/, "PIN must contain at least 6 digits"),
  preferredLanguage: z.enum(["en", "nl", "pl", "es"]).default("en"),
});

export async function POST(request: Request) {
  try {
    const input = await parseJson(request, schema);
    const identifier = `spx-${createToken(8).toLowerCase()}`;
    const sessionToken = createToken();
    const db = getDb();
    const registration = await db.transaction(async (tx) => {
      const [invite] = await tx.select().from(invites).where(eq(invites.tokenHash, digestToken(input.inviteToken))).for("update").limit(1);
      const now = new Date();
      if (!invite || invite.revokedAt || invite.expiresAt <= now || invite.registrationsUsed >= invite.maxRegistrations) return null;
      if (!(ROLES as readonly string[]).includes(invite.defaultRole) || invite.defaultRole === "ADMIN") return null;
      const pinHash = await hashPin(input.pin);
      const permissions = invite.defaultPermissions;
      const [user] = await tx.insert(users).values({
        identifier, displayName: input.displayName, pinHash, role: invite.defaultRole,
        permissions, preferredLanguage: input.preferredLanguage,
      }).returning();
      if (!user) return null;
      await tx.update(invites).set({ registrationsUsed: sql`${invites.registrationsUsed} + 1` }).where(eq(invites.id, invite.id));
      await tx.insert(sessions).values({ userId: user.id, tokenHash: digestToken(sessionToken) });
      await tx.insert(auditLog).values({ actorUserId: user.id, targetUserId: user.id, action: "USER_REGISTERED", details: { inviteId: invite.id } });
      return user;
    });
    if (!registration) return jsonError("Invitation is invalid, expired, revoked, or exhausted", 400);
    const user = { id: registration.id, displayName: registration.displayName, loginIdentifier: registration.identifier, role: registration.role, preferredLanguage: registration.preferredLanguage, permissions: registration.permissions };
    return Response.json({ user, loginIdentifier: registration.identifier }, { status: 201, headers: { "Set-Cookie": persistentSessionCookie(sessionToken) } });
  } catch (error) { return handleRouteError(error); }
}
