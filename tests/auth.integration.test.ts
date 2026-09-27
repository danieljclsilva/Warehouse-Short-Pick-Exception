import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, invites, sessions, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { authenticate, changeOwnCredential, createSession } from "../src/server/auth";
import { digestToken, hashPin } from "../src/server/security";
import { recoverAdminPin } from "../src/server/admin-recovery";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as register } from "../src/app/api/auth/register/route";
import { GET as listInvites, POST as createInvite } from "../src/app/api/admin/invites/route";
import { DELETE as revokeInvite } from "../src/app/api/admin/invites/[id]/route";
import { PATCH as updateUser } from "../src/app/api/admin/users/[id]/route";
import { GET as health } from "../src/app/health/route";
import { GET as sessionRoute } from "../src/app/api/auth/session/route";
import { PATCH as updateProfile } from "../src/app/api/profile/route";
import { getCurrentConfiguration } from "../src/server/configuration";

const enabled = Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Phase 1 authentication and administration against PostgreSQL", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const userIds: string[] = [];
  const inviteIds: string[] = [];

  async function makeUser(role: Role, suffix: string) {
    const [user] = await getDb().insert(users).values({
      identifier: `test-${runId}-${suffix}`,
      displayName: `Test ${suffix}`,
      pinHash: await hashPin("123456"),
      role,
      permissions: defaultPermissions(role),
    }).returning();
    userIds.push(user.id);
    return user;
  }

  async function authenticatedInvite(actor: { id: string }, role: Role, maxRegistrations = 1) {
    const session = await createSession(actor.id);
    const res = await createInvite(request("/api/admin/invites", "POST", { defaultRole: role, maxRegistrations }, session.cookie.split(";")[0]));
    const data = await res.json();
    if (res.status === 201) inviteIds.push(data.invite.id as string);
    return { res, data };
  }

  beforeAll(async () => {
    // Confirm test setup has already applied the tracked migration.
    await getDb().select().from(users).limit(1);
  });

  afterAll(async () => {
    if (userIds.length) {
      const db = getDb();
      await db.delete(invites).where(inArray(invites.createdBy, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(auditLog).where(and(inArray(auditLog.actorUserId, userIds), inArray(auditLog.targetUserId, userIds)));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.targetUserId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (inviteIds.length) await getDb().delete(invites).where(inArray(invites.id, inviteIds));
    await closeDb();
  });

  it("serializes concurrent failed PIN attempts at the configured lockout cap", async () => {
    const user = await makeUser("PICKER", "lockout");
    const maxFailures = Math.max(1, Number.parseInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? "5", 10) || 5);
    const burst = await Promise.all(Array.from({ length: maxFailures + 3 }, () => login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "999999" }))));
    expect(burst.some((response) => response.status === 423)).toBe(true);
    const [attemptState] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(attemptState.failedLoginAttempts).toBe(maxFailures);
    const locked = await login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "123456" }));
    expect(locked.status).toBe(423);
  });

  it("rejects expired, revoked, and exhausted invitations", async () => {
    const admin = await makeUser("ADMIN", "invite-admin");
    const expired = await authenticatedInvite(admin, "PICKER");
    expect(expired.res.status).toBe(201);
    await expect(getDb().update(invites).set({ registrationsUsed: 2 }).where(eq(invites.id, expired.data.invite.id))).rejects.toThrow();
    await getDb().update(invites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invites.id, expired.data.invite.id));
    expect((await register(request("/api/auth/register", "POST", { inviteToken: expired.data.invite.token, displayName: "Expired", pin: "123456" }))).status).toBe(400);

    const revoked = await authenticatedInvite(admin, "PICKER");
    expect(revoked.res.status).toBe(201);
    expect((await revokeInvite(request(`/api/admin/invites/${revoked.data.invite.id}`, "DELETE", undefined, (await createSession(admin.id)).cookie.split(";")[0]), { params: Promise.resolve({ id: revoked.data.invite.id }) })).status).toBe(200);
    const revokeAudit = await getDb().select().from(auditLog).where(eq(auditLog.action, "INVITE_REVOKED"));
    expect(revokeAudit.some((entry) => entry.details.inviteId === revoked.data.invite.id)).toBe(true);
    expect((await register(request("/api/auth/register", "POST", { inviteToken: revoked.data.invite.token, displayName: "Revoked", pin: "123456" }))).status).toBe(400);

    const exhausted = await authenticatedInvite(admin, "PICKER");
    expect(exhausted.res.status).toBe(201);
    await getDb().update(invites).set({ registrationsUsed: 1 }).where(eq(invites.id, exhausted.data.invite.id));
    expect((await register(request("/api/auth/register", "POST", { inviteToken: exhausted.data.invite.token, displayName: "Exhausted", pin: "123456" }))).status).toBe(400);
  });

  it("uses the eight-hour default expiry when omitted and preserves an explicit 1000-registration limit", async () => {
    const admin = await makeUser("ADMIN", "invite-defaults");
    const cookie = (await createSession(admin.id)).cookie.split(";")[0];
    const startedAt = Date.now();
    const response = await createInvite(request("/api/admin/invites", "POST", { defaultRole: "PICKER", maxRegistrations: 1000 }, cookie));
    expect(response.status).toBe(201);
    const data = await response.json() as { invite: { id: string; expiresAt: string; maxRegistrations: number } };
    inviteIds.push(data.invite.id);
    const expiresInMs = new Date(data.invite.expiresAt).getTime() - startedAt;
    expect(expiresInMs).toBeGreaterThan(7.99 * 3_600_000);
    expect(expiresInMs).toBeLessThan(8.01 * 3_600_000);
    expect(data.invite.maxRegistrations).toBe(1000);
  });

  it("enforces role hierarchy and revokes disabled users' sessions", async () => {
    const leader = await makeUser("TEAM_LEADER", "leader");
    const admin = await makeUser("ADMIN", "protected-admin");
    const picker = await makeUser("PICKER", "disable-target");
    const leaderSession = await createSession(leader.id);
    const forbidden = await updateUser(request(`/api/admin/users/${admin.id}`, "PATCH", { action: "status", status: "DISABLED" }, leaderSession.cookie.split(";")[0]), { params: Promise.resolve({ id: admin.id }) });
    expect(forbidden.status).toBe(403);

    const pickerSession = await createSession(picker.id);
    const disabled = await updateUser(request(`/api/admin/users/${picker.id}`, "PATCH", { action: "status", status: "DISABLED" }, leaderSession.cookie.split(";")[0]), { params: Promise.resolve({ id: picker.id }) });
    expect(disabled.status).toBe(200);
    expect(await authenticate(request("/api/auth/session", "GET", undefined, pickerSession.cookie.split(";")[0]))).toBeNull();
  });

  it("requires archive permission to reactivate an archived user and blocks admin-plane grants", async () => {
    const assistant = await makeUser("ASSISTANT", "assistant-policy");
    const picker = await makeUser("PICKER", "archived-picker");
    await getDb().update(users).set({ status: "ARCHIVED", archivedAt: new Date() }).where(eq(users.id, picker.id));
    const assistantCookie = (await createSession(assistant.id)).cookie.split(";")[0];
    const forbidden = await updateUser(request(`/api/admin/users/${picker.id}`, "PATCH", { action: "status", status: "ACTIVE" }, assistantCookie), { params: Promise.resolve({ id: picker.id }) });
    expect(forbidden.status).toBe(403);

    const invalidGrant = await updateUser(request(`/api/admin/users/${picker.id}`, "PATCH", { action: "permissions", permissions: ["CREATE_INVITES"] }, assistantCookie), { params: Promise.resolve({ id: picker.id }) });
    expect(invalidGrant.status).toBe(400);
    const invalidInvite = await createInvite(request("/api/admin/invites", "POST", { defaultRole: "PICKER", defaultPermissions: ["VIEW_USERS"] }, assistantCookie));
    expect(invalidInvite.status).toBe(400);

    const leader = await makeUser("TEAM_LEADER", "archive-leader");
    const leaderCookie = (await createSession(leader.id)).cookie.split(";")[0];
    const reactivated = await updateUser(request(`/api/admin/users/${picker.id}`, "PATCH", { action: "status", status: "ACTIVE" }, leaderCookie), { params: Promise.resolve({ id: picker.id }) });
    expect(reactivated.status).toBe(200);
  });

  it("keeps assistants from listing or revoking team-leader invitations", async () => {
    const admin = await makeUser("ADMIN", "invite-scope-admin");
    const assistant = await makeUser("ASSISTANT", "invite-scope-assistant");
    const teamLeaderInvite = await authenticatedInvite(admin, "TEAM_LEADER");
    expect(teamLeaderInvite.res.status).toBe(201);

    const assistantCookie = (await createSession(assistant.id)).cookie.split(";")[0];
    const list = await listInvites(request("/api/admin/invites", "GET", undefined, assistantCookie));
    const visible = await list.json();
    expect(visible.invites.some((entry: { id: string }) => entry.id === teamLeaderInvite.data.invite.id)).toBe(false);

    const response = await revokeInvite(request(`/api/admin/invites/${teamLeaderInvite.data.invite.id}`, "DELETE", undefined, assistantCookie), { params: Promise.resolve({ id: teamLeaderInvite.data.invite.id }) });
    expect(response.status).toBe(403);
    const [stillActive] = await getDb().select().from(invites).where(eq(invites.id, teamLeaderInvite.data.invite.id));
    expect(stillActive.revokedAt).toBeNull();
  });

  it("refreshes persistent cookies, serves /health, and recovers an admin PIN with session revocation", async () => {
    const admin = await makeUser("ADMIN", "recovery-admin");
    const session = await createSession(admin.id);
    const cookie = session.cookie.split(";")[0];
    const sessionResponse = await sessionRoute(request("/api/auth/session", "GET", undefined, cookie));
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("set-cookie")).toContain("Max-Age=");
    expect(sessionResponse.headers.get("set-cookie")).toContain("Expires=");
    expect((await health()).status).toBe(200);

    expect(await recoverAdminPin(admin.identifier, "987654")).toBe(true);
    const recoveryEvents = await getDb().select().from(auditLog).where(eq(auditLog.action, "ADMIN_PIN_RECOVERED"));
    expect(recoveryEvents.some((event) => event.targetUserId === admin.id && event.actorUserId === null)).toBe(true);
    expect(await authenticate(request("/api/auth/session", "GET", undefined, cookie))).toBeNull();
    expect((await login(request("/api/auth/login", "POST", { identifier: admin.identifier, pin: "123456" }))).status).toBe(401);
    expect((await login(request("/api/auth/login", "POST", { identifier: admin.identifier, pin: "987654" }))).status).toBe(200);
  });

  it("switches credentials atomically, revokes other sessions, audits password reset, and recovers password accounts", async () => {
    const user = await makeUser("PICKER", "credential-switch");
    const currentSession = await createSession(user.id);
    const otherSession = await createSession(user.id);
    const currentCookie = currentSession.cookie.split(";")[0];
    const otherCookie = otherSession.cookie.split(";")[0];

    const [beforeLongPinAttempt] = await getDb().select().from(users).where(eq(users.id, user.id));
    const tooLongPin = await updateProfile(request("/api/profile", "PATCH", {
      credential: "PIN", current: "123456", pin: "7".repeat(201),
    }, currentCookie));
    expect(tooLongPin.status).toBe(400);
    const [afterLongPinAttempt] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(afterLongPinAttempt.pinHash).toBe(beforeLongPinAttempt.pinHash);
    expect(afterLongPinAttempt.passwordHash).toBeNull();

    const switchedToPassword = await updateProfile(request("/api/profile", "PATCH", {
      credential: "PASSWORD", current: "123456", password: "correct horse battery",
    }, currentCookie));
    expect(switchedToPassword.status).toBe(200);
    expect(await authenticate(request("/api/auth/session", "GET", undefined, currentCookie))).not.toBeNull();
    expect(await authenticate(request("/api/auth/session", "GET", undefined, otherCookie))).toBeNull();
    expect((await login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "123456" }))).status).toBe(401);
    expect((await login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "correct horse battery" }))).status).toBe(200);

    const switchedToPin = await updateProfile(request("/api/profile", "PATCH", {
      credential: "PIN", current: "correct horse battery", pin: "654321",
    }, currentCookie));
    expect(switchedToPin.status).toBe(200);
    const [afterSwitch] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(afterSwitch.passwordHash).toBeNull();
    expect((await login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "654321" }))).status).toBe(200);
    const staleSession = await createSession(user.id);
    const [staleDbSession] = await getDb().select().from(sessions).where(eq(sessions.tokenHash, digestToken(staleSession.token)));
    await getDb().update(sessions).set({ revokedAt: new Date(), revokedReason: "test_revoked" }).where(eq(sessions.id, staleDbSession.id));
    expect(await changeOwnCredential(user.id, staleDbSession.id, "654321", "PASSWORD", "stale-session password")).toBe("SESSION_REVOKED");
    const [afterStaleChange] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(afterStaleChange.pinHash).toBe(afterSwitch.pinHash);
    expect(afterStaleChange.passwordHash).toBeNull();

    const admin = await makeUser("ADMIN", "credential-reset-admin");
    const target = await makeUser("PICKER", "credential-reset-target");
    const adminCookie = (await createSession(admin.id)).cookie.split(";")[0];
    const targetSession = await createSession(target.id);
    const targetCookie = targetSession.cookie.split(";")[0];
    const reset = await updateUser(request(`/api/admin/users/${target.id}`, "PATCH", {
      action: "resetPassword", password: "new target password",
    }, adminCookie), { params: Promise.resolve({ id: target.id }) });
    expect(reset.status).toBe(200);
    expect(await authenticate(request("/api/auth/session", "GET", undefined, targetCookie))).toBeNull();
    const [revokedTargetSession] = await getDb().select().from(sessions)
      .where(eq(sessions.tokenHash, digestToken(targetSession.token)));
    expect(revokedTargetSession.revokedReason).toBe("password_reset");
    expect((await login(request("/api/auth/login", "POST", { identifier: target.identifier, pin: "new target password" }))).status).toBe(200);
    const resetAudits = await getDb().select().from(auditLog).where(eq(auditLog.action, "PASSWORD_RESET"));
    expect(resetAudits.some((entry) => entry.targetUserId === target.id && entry.actorUserId === admin.id)).toBe(true);
    expect((await getDb().select().from(auditLog).where(eq(auditLog.action, "PIN_RESET")))
      .some((entry) => entry.targetUserId === target.id)).toBe(false);

    const adminPassword = await updateProfile(request("/api/profile", "PATCH", {
      credential: "PASSWORD", current: "123456", password: "admin password account",
    }, adminCookie));
    expect(adminPassword.status).toBe(200);
    expect(await recoverAdminPin(admin.identifier, "246810")).toBe(true);
    const [recoveredAdmin] = await getDb().select().from(users).where(eq(users.id, admin.id));
    expect(recoveredAdmin.pinHash).not.toBeNull();
    expect(recoveredAdmin.passwordHash).toBeNull();
    expect((await login(request("/api/auth/login", "POST", { identifier: admin.identifier, pin: "admin password account" }))).status).toBe(401);
    expect((await login(request("/api/auth/login", "POST", { identifier: admin.identifier, pin: "246810" }))).status).toBe(200);
  });

  it("locks self-service credential changes after the configured number of wrong current secrets", async () => {
    const user = await makeUser("PICKER", "credential-lockout");
    const session = await createSession(user.id);
    const cookie = session.cookie.split(";")[0];
    const { values } = await getCurrentConfiguration();
    const maxFailures = values.LOGIN_MAX_FAILED_ATTEMPTS;

    for (let attempt = 1; attempt <= maxFailures; attempt += 1) {
      const response = await updateProfile(request("/api/profile", "PATCH", {
        credential: "PASSWORD", current: "wrong-current-secret", password: "new account password",
      }, cookie));
      expect(response.status).toBe(attempt === maxFailures ? 423 : 401);
    }

    const [lockedUser] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(lockedUser.failedLoginAttempts).toBe(maxFailures);
    expect(lockedUser.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect((await updateProfile(request("/api/profile", "PATCH", {
      credential: "PASSWORD", current: "123456", password: "new account password",
    }, cookie))).status).toBe(423);
    expect((await login(request("/api/auth/login", "POST", { identifier: user.identifier, pin: "123456" }))).status).toBe(423);
  });
});
