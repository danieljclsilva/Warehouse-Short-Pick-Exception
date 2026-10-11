import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, configurationVersions, notificationPreferences, notifications, orderCases, pushOutbox, pushSubscriptions, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { PATCH as assignCheckRoute } from "../src/app/api/checks/[id]/assign/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as completeCheckRoute } from "../src/app/api/checks/[id]/complete/route";
import { GET as notificationsRoute } from "../src/app/api/notifications/route";
import { POST as readAllRoute } from "../src/app/api/notifications/read-all/route";
import { POST as readRoute } from "../src/app/api/notifications/[id]/read/route";
import { GET as preferencesRoute, PATCH as updatePreferencesRoute } from "../src/app/api/notifications/preferences/route";
import { emitEligibleRecipients, emitUnresolvedMonitoringNotifications, insertNotification, unresolvedEmitWorkItems } from "../src/server/notifications";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Phase 5 notification routing and isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerCookie = "";
  let checkerId = "";
  let checkerTwoId = "";
  let checkerTwoCookie = "";
  let leaderCookie = "";
  let secondLeaderCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `notify-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  beforeAll(async () => {
    await getDb().select().from(notifications).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const checker = await makeUser("TROUBLESHOOTER", "checker");
    const checkerTwo = await makeUser("TROUBLESHOOTER", "checker-two");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const secondLeader = await makeUser("TEAM_LEADER", "second-leader");
    checkerId = checker.id; checkerTwoId = checkerTwo.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    secondLeaderCookie = (await createSession(secondLeader.id)).cookie.split(";")[0]!;
    checkerTwoCookie = (await createSession(checkerTwo.id)).cookie.split(";")[0]!;
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      const lineIds = (await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds))).map((row) => row.id);
      if (lineIds.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  async function createCase(orderSuffix: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `7${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.notify.1", sku: "sku-notify", quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const created = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(created.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, created.lines[0]!.id));
    return { ...created, taskId: task!.id };
  }

  it("routes new short picks, applies optional preferences, and isolates recipients", async () => {
    const first = await createCase("1");
    const leaderNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, leaderCookie));
    expect(leaderNotifications.status).toBe(200);
    expect((await leaderNotifications.json()).notifications).toEqual(expect.arrayContaining([expect.objectContaining({ type: "NEW_SHORT_PICK", caseId: first.id })]));

    const changed = await updatePreferencesRoute(request("/api/notifications/preferences", "PATCH", { preferences: { NEW_SHORT_PICK: false } }, secondLeaderCookie));
    expect(changed.status).toBe(200);
    expect((await preferencesRoute(request("/api/notifications/preferences", "GET", undefined, secondLeaderCookie))).status).toBe(200);

    const second = await createCase("2");
    const secondLeaderNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, secondLeaderCookie));
    expect((await secondLeaderNotifications.json()).notifications).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "NEW_SHORT_PICK", caseId: second.id })]));
    const pickerNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, pickerCookie));
    expect((await pickerNotifications.json()).notifications).not.toEqual(expect.arrayContaining([expect.objectContaining({ caseId: second.id })]));
  });

  it("persists required assignment alerts and makes read idempotent", async () => {
    const item = await createCase("3");
    const assigned = await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerId }, leaderCookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(assigned.status).toBe(200);
    const checkerCookie = (await createSession(checkerId)).cookie.split(";")[0]!;
    const checkerNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, checkerCookie));
    const assignment = (await checkerNotifications.json()).notifications.find((row: { type: string; caseId: string }) => row.type === "RESPONSIBILITY_CHECK_ASSIGNED" && row.caseId === item.id);
    expect(assignment).toEqual(expect.objectContaining({ type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId: item.id, shortPickLineId: item.lines[0]!.id }));
    if (!assignment) throw new Error("Expected assignment notification");
    const readPath = `/api/notifications/${assignment.id}/read`;
    expect((await readRoute(request(readPath, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: assignment.id }) })).status).toBe(200);
    expect((await readRoute(request(readPath, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: assignment.id }) })).status).toBe(200);
    const unread = await notificationsRoute(request("/api/notifications", "GET", undefined, checkerCookie));
    expect((await unread.json()).notifications.find((row: { id: string }) => row.id === assignment.id).readAt).not.toBeNull();
    expect((await notificationsRoute(request("/api/notifications", "GET", undefined, leaderCookie))).status).toBe(200);
  });

  it("notifies an assigned picker in-app and queues each enabled device regardless of monitoring preferences", async () => {
    const item = await createCase("91");
    const picker = await makeUser("PICKER", "assigned-picker");
    const cookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    const originalEnv = {
      publicKey: process.env.PUSH_PUBLIC_KEY,
      privateKey: process.env.PUSH_PRIVATE_KEY,
      subject: process.env.PUSH_SUBJECT,
    };
    const vapid = webpush.generateVAPIDKeys();
    process.env.PUSH_PUBLIC_KEY = vapid.publicKey;
    process.env.PUSH_PRIVATE_KEY = vapid.privateKey;
    process.env.PUSH_SUBJECT = "mailto:test@example.invalid";
    const db = getDb();
    const devices = await db.insert(pushSubscriptions).values([
      { userId: picker.id, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-picker-phone`, p256dh: "A".repeat(87), auth: "B".repeat(22) },
      { userId: picker.id, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-picker-tablet`, p256dh: "C".repeat(87), auth: "D".repeat(22) },
      { userId: picker.id, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-picker-disabled`, p256dh: "E".repeat(87), auth: "F".repeat(22), disabledAt: new Date() },
    ]).returning();
    try {
      await db.insert(notificationPreferences).values({ userId: picker.id, key: "CHECK_CLAIMED", enabled: false });
      const assigned = await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: picker.id }, leaderCookie), { params: Promise.resolve({ id: item.taskId }) });
      expect(assigned.status).toBe(200);
      const response = await notificationsRoute(request("/api/notifications", "GET", undefined, cookie));
      const body = await response.json();
      const assignment = body.notifications.find((row: { type: string; caseId: string }) => row.type === "RESPONSIBILITY_CHECK_ASSIGNED" && row.caseId === item.id);
      expect(assignment).toMatchObject({ caseId: item.id, shortPickLineId: item.lines[0]!.id, readAt: null, payload: { taskId: item.taskId } });
      expect(body.unreadCount).toBe(1);
      const queued = await db.select().from(pushOutbox).where(eq(pushOutbox.notificationId, assignment.id));
      expect(queued).toHaveLength(2);
      expect(queued.map((row) => row.subscriptionId).sort()).toEqual(devices.slice(0, 2).map((device) => device.id).sort());
      expect(queued.every((row) => row.status === "QUEUED")).toBe(true);

      // A picker with no subscribed device must still get the required in-app alert.
      const unsubscribed = await makeUser("PICKER", "unsubscribed-picker");
      const reassigned = await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: unsubscribed.id }, leaderCookie), { params: Promise.resolve({ id: item.taskId }) });
      expect(reassigned.status).toBe(200);
      const [reassignment] = await db.select().from(notifications).where(eq(notifications.recipientUserId, unsubscribed.id));
      expect(reassignment).toMatchObject({ type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId: item.id, payload: { reassigned: true } });
      expect(await db.select().from(pushOutbox).where(eq(pushOutbox.notificationId, reassignment!.id))).toHaveLength(0);
    } finally {
      await db.delete(pushOutbox).where(inArray(pushOutbox.subscriptionId, devices.map((device) => device.id)));
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, picker.id));
      for (const [key, value] of Object.entries({ PUSH_PUBLIC_KEY: originalEnv.publicKey, PUSH_PRIVATE_KEY: originalEnv.privateKey, PUSH_SUBJECT: originalEnv.subject })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("routes a staged new location to the active case resolver before the checker", async () => {
    const item = await createCase("4");
    expect((await responsibilityRoute(request(`/api/cases/${item.id}/responsibility`, "POST", { userId: checkerId }, leaderCookie), { params: Promise.resolve({ id: item.id }) })).status).toBe(200);
    expect((await stageRoute(request(`/api/cases/${item.id}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: item.id }) })).status).toBe(200);
    expect((await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerTwoId }, leaderCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeCheckRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "BTS-NOTIFY" }, checkerTwoCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const resolverCookie = (await createSession(checkerId)).cookie.split(";")[0]!;
    const resolverNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, resolverCookie));
    expect((await resolverNotifications.json()).notifications).toEqual(expect.arrayContaining([expect.objectContaining({ type: "RESPONSIBILITY_NEW_LOCATION", caseId: item.id, shortPickLineId: item.lines[0]!.id })]));
    const checkerNotifications = await notificationsRoute(request("/api/notifications", "GET", undefined, checkerTwoCookie));
    expect((await checkerNotifications.json()).notifications).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "RESPONSIBILITY_NEW_LOCATION", caseId: item.id, shortPickLineId: item.lines[0]!.id })]));
  });
});

describeDatabase("Wave 1 mark-all-read and >100-row recipient isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  let readerCookie = "";
  let readerId = "";
  let otherCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `notify-wave1-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  function seedUnread(recipientUserId: string, count: number, readCount = 0) {
    return getDb().insert(notifications).values(Array.from({ length: count }, (_, index) => ({
      recipientUserId, type: "NEW_SHORT_PICK" as const, caseId: null, shortPickLineId: null,
      payload: { orderNumber: `wave1-${suffix}-${index}` }, dedupeKey: `wave1-${suffix}-${recipientUserId}-${index}`,
      readAt: index < readCount ? new Date("2026-09-01T00:00:00Z") : null,
    })));
  }

  async function unreadCount(cookie: string) {
    const response = await notificationsRoute(request("/api/notifications", "GET", undefined, cookie));
    expect(response.status).toBe(200);
    return (await response.json()).unreadCount as number;
  }

  beforeAll(async () => {
    const reader = await makeUser("TEAM_LEADER", "reader");
    const other = await makeUser("TEAM_LEADER", "other");
    readerId = reader.id;
    readerCookie = (await createSession(reader.id)).cookie.split(";")[0]!;
    otherCookie = (await createSession(other.id)).cookie.split(";")[0]!;
  });

  afterAll(async () => {
    const db = getDb();
    if (userIds.length) {
      await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("requires authentication", async () => {
    expect((await readAllRoute(new Request("http://localhost/api/notifications/read-all", { method: "POST" }))).status).toBe(401);
  });

  it("marks every unread row past the 100-row list limit and stays idempotent", async () => {
    await seedUnread(readerId, 120, 3);
    expect(await unreadCount(readerCookie)).toBe(117);
    const first = await readAllRoute(request("/api/notifications/read-all", "POST", undefined, readerCookie));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ updated: 117, unreadCount: 0 });
    const second = await readAllRoute(request("/api/notifications/read-all", "POST", undefined, readerCookie));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ updated: 0, unreadCount: 0 });
  });

  it("leaves another recipient untouched and keeps one-at-a-time read", async () => {
    const other = (await getDb().select({ id: users.id }).from(users).where(eq(users.identifier, `notify-wave1-${suffix}-other`)))[0]!;
    await seedUnread(other.id, 4);
    const readerResult = await readAllRoute(request("/api/notifications/read-all", "POST", undefined, readerCookie));
    expect(await readerResult.json()).toEqual({ updated: 0, unreadCount: 0 });
    expect(await unreadCount(otherCookie)).toBe(4);
    const list = (await (await notificationsRoute(request("/api/notifications", "GET", undefined, otherCookie))).json()).notifications as Array<{ id: string; shortPickLineId: string | null; caseId: string | null }>;
    expect(list[0]).toMatchObject({ caseId: null, shortPickLineId: null });
    expect((await readRoute(request(`/api/notifications/${list[0]!.id}/read`, "POST", undefined, otherCookie), { params: Promise.resolve({ id: list[0]!.id }) })).status).toBe(200);
    expect(await unreadCount(otherCookie)).toBe(3);
  });
});

describeDatabase("Emitter bounded tick: many-user/many-case load, dedupe, early exit, chunk atomicity", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const userIds: string[] = [];
  const managerIds: string[] = [];
  const caseIds: string[] = [];
  // 15-digit numeric order numbers: unique per seed even within one millisecond,
  // random start so a crashed run's leftovers cannot collide on retry.
  let orderCounter = Math.floor(Math.random() * 1_000_000);

  async function makeManager(name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `emit-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role: "TEAM_LEADER", permissions: defaultPermissions("TEAM_LEADER") }).returning();
    userIds.push(user!.id);
    managerIds.push(user!.id);
    return user!;
  }

  async function seedOpenCases(count: number, reporterId: string, configId: string, ageMinutes: number) {
    const agedAt = new Date(Date.now() - ageMinutes * 60_000);
    const caseRows = Array.from({ length: count }, () => ({
      orderNumber: `9${String(Date.now()).slice(-8)}${String(orderCounter++ % 1_000_000).padStart(6, "0")}`,
      phase: "PICKING" as const, physicalState: "WITH_PICKER" as const, source: "PICKER_REPORT" as const,
      createdByUserId: reporterId, pickingUserId: reporterId, configurationVersionId: configId,
      createdAt: agedAt, updatedAt: agedAt,
    }));
    const inserted: string[] = [];
    for (let offset = 0; offset < caseRows.length; offset += 100) {
      const batch = await getDb().insert(orderCases).values(caseRows.slice(offset, offset + 100)).returning({ id: orderCases.id });
      inserted.push(...batch.map((row) => row.id));
    }
    // Locations/SKUs must already be normalized: direct inserts bypass route normalization.
    const lineRows = inserted.map((caseId) => ({ caseId, originalLocation: `EMIT${suffix}`, sku: "SKU-EMIT", missingQuantity: 1, reportedByUserId: reporterId }));
    for (let offset = 0; offset < lineRows.length; offset += 100) {
      await getDb().insert(shortPickLines).values(lineRows.slice(offset, offset + 100));
    }
    caseIds.push(...inserted);
    return inserted;
  }

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      const lineIds = (await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds))).map((row) => row.id);
      if (lineIds.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("filters eligibility without a database: empty, unauthorized, disabled, custom threshold", () => {
    expect(emitEligibleRecipients([], [])).toEqual([]);
    const candidates = [
      { id: "u1", permissions: ["VIEW_ALL_OPEN_CASES"] },
      { id: "u2", permissions: ["VIEW_OWN_CASES"] },
    ];
    expect(emitEligibleRecipients(candidates, [])).toEqual([{ id: "u1", thresholdMinutes: 10 }]);
    expect(emitEligibleRecipients(candidates,
      [{ userId: "u1", key: "UNRESOLVED_OVER_THRESHOLD", enabled: false, thresholdMinutes: null }])).toEqual([]);
    expect(emitEligibleRecipients(candidates,
      [{ userId: "u1", key: "UNRESOLVED_OVER_THRESHOLD", enabled: true, thresholdMinutes: 45 }]))
      .toEqual([{ id: "u1", thresholdMinutes: 45 }]);
  });

  it("builds tick work only for unresolved cases", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const cases = [
      { id: "a", orderNumber: "1", createdAt: new Date("2026-09-29T11:00:00Z") },
      { id: "b", orderNumber: "2", createdAt: new Date("2026-09-29T11:50:00Z") },
    ];
    expect(unresolvedEmitWorkItems(cases, new Set(["a"]), now)).toEqual([{ id: "a", orderNumber: "1", ageMinutes: 60 }]);
    expect(unresolvedEmitWorkItems(cases, [], now)).toEqual([]);
  });

  it("completes a 30-manager x 50-case tick and dedupes the second tick to zero", async () => {
    const [config] = await getDb().select().from(configurationVersions).orderBy(configurationVersions.version).limit(1);
    expect(config).toBeDefined();
    const managers = await Promise.all(Array.from({ length: 30 }, (_, index) => makeManager(`mgr-${index}`)));
    const seeded = await seedOpenCases(50, managers[0]!.id, config!.id, 60);
    expect(seeded).toHaveLength(50);
    const first = await emitUnresolvedMonitoringNotifications();
    expect(first).toBe(30 * 50);
    const stored = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(inArray(notifications.caseId, seeded));
    expect(stored[0]?.count).toBe(30 * 50);
    // Steady-state tick: every pair now conflicts on (recipientUserId, dedupeKey)
    // and the unique index turns the whole tick into quiet no-ops.
    const second = await emitUnresolvedMonitoringNotifications();
    expect(second).toBe(0);
    const storedAfter = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(inArray(notifications.caseId, seeded));
    expect(storedAfter[0]?.count).toBe(30 * 50);
  }, 60_000);

  it("keeps prior chunks committed when a later chunk fails (per-chunk atomicity)", async () => {
    const [config] = await getDb().select().from(configurationVersions).orderBy(configurationVersions.version).limit(1);
    expect(config).toBeDefined();
    // Isolate: silence every previously seeded manager so the tick below only
    // creates rows for the survivor's 3 fresh cases.
    if (managerIds.length) {
      await getDb().insert(notificationPreferences).values(managerIds.map((id) => ({
        userId: id, key: "UNRESOLVED_OVER_THRESHOLD" as const, enabled: false }))).onConflictDoNothing();
    }
    const [survivor] = await getDb().insert(users).values({ identifier: `emit-${suffix}-survivor`, displayName: "survivor",
      pinHash: await hashPin("123456"), role: "TEAM_LEADER", permissions: defaultPermissions("TEAM_LEADER") }).returning();
    userIds.push(survivor!.id);
    const seeded = await seedOpenCases(3, survivor!.id, config!.id, 60);
    const before = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(inArray(notifications.caseId, seeded));
    expect(before[0]?.count).toBe(0);
    // The survivor has no dedupe rows yet, so the tick creates one row per
    // open case old enough to qualify — 53 independent single-case
    // transactions (3 fresh + 50 load-test leftovers), each committing alone.
    expect(await emitUnresolvedMonitoringNotifications(1)).toBeGreaterThanOrEqual(3);
    await expect(getDb().transaction(async (tx) => {
      await insertNotification(tx, { recipientUserId: survivor!.id, type: "UNRESOLVED_OVER_THRESHOLD",
        caseId: seeded[0]!, dedupeKey: `atomic-${suffix}` });
      throw new Error("simulated chunk failure");
    })).rejects.toThrow("simulated chunk failure");
    expect(await getDb().select().from(notifications).where(eq(notifications.dedupeKey, `atomic-${suffix}`))).toEqual([]);
    const survived = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(inArray(notifications.caseId, seeded));
    expect(survived[0]?.count).toBe(3);
  }, 60_000);

  it("emits an INFO tick summary with cases scanned, eligible, and created", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let summary: Record<string, unknown> | undefined;
    try {
      await emitUnresolvedMonitoringNotifications();
      summary = info.mock.calls.map(([line]) => {
        try { return JSON.parse(String(line)); } catch { return null; }
      }).find((record) => record?.event === "notification.monitoring.emit_completed");
    } finally {
      info.mockRestore();
    }
    expect(summary).toMatchObject({ level: "info", area: "notifications" });
    expect(typeof summary!.casesScanned).toBe("number");
    expect(typeof summary!.eligibleRecipients).toBe("number");
    expect(summary!.created).toBe(0);
  });

  it("exits early with zero when no recipient is eligible (empty-eligible path)", async () => {
    const actives = await getDb().select({ id: users.id }).from(users).where(eq(users.status, "ACTIVE"));
    for (let offset = 0; offset < actives.length; offset += 100) {
      await getDb().insert(notificationPreferences).values(actives.slice(offset, offset + 100).map((row) => ({
        userId: row.id, key: "UNRESOLVED_OVER_THRESHOLD" as const, enabled: false }))).onConflictDoNothing();
    }
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let created = -1;
    let summary: Record<string, unknown> | undefined;
    try {
      created = await emitUnresolvedMonitoringNotifications();
      summary = info.mock.calls.map(([line]) => {
        try { return JSON.parse(String(line)); } catch { return null; }
      }).find((record) => record?.event === "notification.monitoring.emit_completed");
    } finally {
      info.mockRestore();
    }
    expect(created).toBe(0);
    expect(summary).toMatchObject({ level: "info", eligibleRecipients: 0, created: 0 });
  });
});
