import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, notificationPreferences, notifications, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
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
