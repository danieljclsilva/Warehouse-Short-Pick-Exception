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
