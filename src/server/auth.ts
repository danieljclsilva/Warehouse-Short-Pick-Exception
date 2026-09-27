import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import type { Permission, Role } from "@/domain/permissions";
import { digestToken, hashCredential, persistentSessionCookie, readCookie, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "./security";

export type AuthUser = {
  id: string;
  displayName: string;
  loginIdentifier: string;
  role: Role;
  preferredLanguage: string;
  permissions: string[];
};

export type AuthContext = { user: AuthUser; sessionId: string };

function publicUser(row: typeof users.$inferSelect): AuthUser {
  return { id: row.id, displayName: row.displayName, loginIdentifier: row.identifier, role: row.role, preferredLanguage: row.preferredLanguage, permissions: row.permissions };
}

export function toPublicUser(row: typeof users.$inferSelect): AuthUser { return publicUser(row); }

export async function authenticate(request: Request): Promise<AuthContext | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const db = getDb();
  const rows = await db.select({ session: sessions, user: users }).from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, digestToken(token)), isNull(sessions.revokedAt), eq(users.status, "ACTIVE")))
    .limit(1);
  const row = rows[0];
  return row ? { user: publicUser(row.user), sessionId: row.session.id } : null;
}

export async function createSession(userId: string): Promise<{ token: string; cookie: string }> {
  const { createToken } = await import("./security");
  const token = createToken();
  await getDb().insert(sessions).values({ userId, tokenHash: digestToken(token) });
  return { token, cookie: persistentSessionCookie(token) };
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${SESSION_COOKIE_OPTIONS} Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function refreshSessionCookie(token: string): string {
  return persistentSessionCookie(token);
}

export async function revokeSession(sessionId: string, reason: string) {
  await getDb().update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeUserSessions(userId: string, reason: string) {
  await getDb().update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function recordAudit(actorUserId: string | null, action: string, targetUserId: string | null = null, details: Record<string, unknown> = {}) {
  await getDb().insert(auditLog).values({ actorUserId, targetUserId, action, details });
}

export type CredentialType = "PIN" | "PASSWORD";

export function credentialTypeOf(row: { pinHash: string | null; passwordHash: string | null }): CredentialType {
  return row.passwordHash ? "PASSWORD" : "PIN";
}

export async function verifyCredential(row: { pinHash: string | null; passwordHash: string | null }, secret: string): Promise<boolean> {
  const { verify } = await import("@node-rs/argon2");
  const hash = row.passwordHash ?? row.pinHash;
  if (!hash) return false;
  return verify(hash, secret).catch(() => false);
}

async function setCredential(userId: string, type: CredentialType, secret: string, actorUserId: string | null, action: string, revokeReason: string, keepSessionId?: string) {
  const hash = await hashCredential(secret);
  await getDb().transaction(async (tx) => {
    await tx.update(users).set(type === "PIN" ? { pinHash: hash, passwordHash: null, updatedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null } : { pinHash: null, passwordHash: hash, updatedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));
    if (keepSessionId) await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: revokeReason }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, keepSessionId)));
    else await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: revokeReason }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await tx.insert(auditLog).values({ actorUserId, targetUserId: userId, action, details: { credentialType: type } });
  });
}

export async function changePin(userId: string, pin: string, actorUserId: string | null, action = "PIN_RESET") {
  await setCredential(userId, "PIN", pin, actorUserId, action, "pin_reset");
}

export async function changePassword(userId: string, password: string, actorUserId: string | null, action = "PIN_RESET") {
  await setCredential(userId, "PASSWORD", password, actorUserId, action, "pin_reset");
}

export async function changeOwnCredential(userId: string, sessionId: string, type: CredentialType, secret: string) {
  await setCredential(userId, type, secret, userId, "CREDENTIAL_CHANGED", "credential_changed", sessionId);
}

export function hasAuthPermission(context: AuthContext, permission: Permission): boolean {
  return context.user.role === "ADMIN" || context.user.permissions.includes(permission);
}
