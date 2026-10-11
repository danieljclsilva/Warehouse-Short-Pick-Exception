import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, caseMessages, checkTasks, notifications, orderCases, pushOutbox, pushSubscriptions, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { PATCH as assignRoute } from "../src/app/api/checks/[id]/assign/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";
import { POST as messageRoute } from "../src/app/api/cases/[id]/messages/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { POST as replenishmentRoute } from "../src/app/api/cases/[id]/lines/[lineId]/replenishment/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";
import { POST as closeRoute } from "../src/app/api/cases/[id]/close/route";
import { GET as pickerCasesRoute } from "../src/app/api/picker/cases/route";
import { GET as notificationsRoute } from "../src/app/api/notifications/route";
import { GET as retrievalsRoute } from "../src/app/api/retrievals/route";
import { z } from "zod";

const createdCaseBody = z.object({ case: z.object({ id: z.uuid(), orderNumber: z.string(), lines: z.array(z.object({ id: z.uuid() }).passthrough()) }) });
const mineCasesBody = z.object({ cases: z.array(z.object({ id: z.uuid(), orderNumber: z.string() }).passthrough()) });
const inboxBody = z.object({ notifications: z.array(z.object({ caseId: z.uuid().nullable(), type: z.string(), readAt: z.string().nullable() }).passthrough()) });
const caseDetailBody = z.object({ case: z.object({ id: z.uuid(), phase: z.string(), pickingUserId: z.string(), messages: z.array(z.unknown()) }).passthrough() });
const replenishedBody = z.object({ replenishment: z.object({ retrievalResponsibleUserId: z.string() }).passthrough() });
const retrievalQueueBody = z.object({ retrievals: z.array(z.object({ lineId: z.uuid() }).passthrough()) });

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Troubleshooter parity workflow against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  let orderSeq = 0;
  let pickerId = "";
  let pickerCookie = "";
  let troubleshooterId = "";
  let troubleshooterCookie = "";
  let managerId = "";
  let managerCookie = "";
  const originalPush = { publicKey: process.env.PUSH_PUBLIC_KEY, privateKey: process.env.PUSH_PRIVATE_KEY, subject: process.env.PUSH_SUBJECT };

  async function makeUser(role: Role, name: string, permissions?: string[]) {
    const [user] = await getDb().insert(users).values({ identifier: `tsw-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: permissions ?? defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  function makeOrderNumber() {
    orderSeq += 1;
    return `8${Date.now().toString().slice(-8)}${String(orderSeq).padStart(2, "0")}`;
  }

  async function makePickerCase(cookie: string, orderNumber: string, location = "11.tsw.1") {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber, confirmedHistoricalCaseIds: [],
      firstLine: { location, sku: "sku-tsw", quantity: 1 },
    }, cookie));
    expect(response.status).toBe(201);
    const body = createdCaseBody.parse(await response.json());
    caseIds.push(body.case.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, body.case.lines[0]!.id));
    return { caseId: body.case.id, lineId: body.case.lines[0]!.id, taskId: task!.id, orderNumber: body.case.orderNumber };
  }

  const pushKeys = webpush.generateVAPIDKeys();

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const troubleshooter = await makeUser("TROUBLESHOOTER", "troubleshooter");
    const manager = await makeUser("MANAGER", "manager");
    pickerId = picker.id; troubleshooterId = troubleshooter.id; managerId = manager.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    troubleshooterCookie = (await createSession(troubleshooter.id)).cookie.split(";")[0]!;
    managerCookie = (await createSession(manager.id)).cookie.split(";")[0]!;
    process.env.PUSH_PUBLIC_KEY = pushKeys.publicKey;
    process.env.PUSH_PRIVATE_KEY = pushKeys.privateKey;
    process.env.PUSH_SUBJECT = "mailto:test@example.invalid";
    const [device] = await getDb().insert(pushSubscriptions).values({
      userId: troubleshooterId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-tsw`,
      p256dh: "A".repeat(87), auth: "B".repeat(22),
    }).returning({ id: pushSubscriptions.id });
    deviceIds.push(device!.id);
  });

  afterAll(async () => {
    const db = getDb();
    if (deviceIds.length) {
      await db.delete(pushOutbox).where(inArray(pushOutbox.subscriptionId, deviceIds));
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, deviceIds));
    }
    if (caseIds.length) {
      const lineIds = (await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds))).map((row) => row.id);
      if (lineIds.length) {
        await db.delete(notifications).where(inArray(notifications.shortPickLineId, lineIds));
        await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
      }
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      await db.delete(caseMessages).where(inArray(caseMessages.caseId, caseIds));
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    for (const [key, value] of Object.entries({ PUSH_PUBLIC_KEY: originalPush.publicKey, PUSH_PRIVATE_KEY: originalPush.privateKey, PUSH_SUBJECT: originalPush.subject })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await closeDb();
  });

  it("opens a completed-replenishment assignment without message access, but requires own-case access", async () => {
    const assigned = await makePickerCase(pickerCookie, makeOrderNumber(), "16.tsw.1");
    expect((await stageRoute(request(`/api/cases/${assigned.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: assigned.caseId }) })).status).toBe(200);
    expect((await replenishmentRoute(request(`/api/cases/${assigned.caseId}/lines/${assigned.lineId}/replenishment`, "POST", { state: "COMPLETED", retrieverUserId: troubleshooterId }, managerCookie), { params: Promise.resolve({ id: assigned.caseId, lineId: assigned.lineId }) })).status).toBe(201);
    try {
      await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "VIEW_CASE_MESSAGES") }).where(eq(users.id, troubleshooterId));
      const detail = await caseDetailRoute(request(`/api/cases/${assigned.caseId}`, "GET", undefined, troubleshooterCookie), { params: Promise.resolve({ id: assigned.caseId }) });
      expect(detail.status).toBe(200);
      const body = caseDetailBody.parse(await detail.json());
      expect(body.case.pickingUserId).toBe(pickerId);
      expect(body.case.messages).toEqual([]);
      await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "VIEW_OWN_CASES") }).where(eq(users.id, troubleshooterId));
      expect((await caseDetailRoute(request(`/api/cases/${assigned.caseId}`, "GET", undefined, troubleshooterCookie), { params: Promise.resolve({ id: assigned.caseId }) })).status).toBe(403);
    } finally {
      await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER") }).where(eq(users.id, troubleshooterId));
    }
  });

  it("covers the default troubleshooter parity flow", async () => {
    // Default grant proof: superset of picker plus replenishment/location, without admin/global visibility.
    const troubleshooter = defaultPermissions("TROUBLESHOOTER");
    expect(troubleshooter).toEqual(expect.arrayContaining(defaultPermissions("PICKER")));
    expect(troubleshooter).toEqual(expect.arrayContaining(["REPORT_NEW_LOCATION", "RECORD_REPLENISHMENT"]));
    expect(troubleshooter).not.toContain("VIEW_USERS");
    expect(troubleshooter).not.toContain("VIEW_ALL_OPEN_CASES");

    // Own report + add line on the still-PICKING case.
    const own = await makePickerCase(troubleshooterCookie, makeOrderNumber());
    const ownLine = await addLineRoute(request(`/api/cases/${own.caseId}/lines`, "POST",
      { location: "11.tsw.2", sku: "sku-tsw-own-2", quantity: 1 }, troubleshooterCookie),
      { params: Promise.resolve({ id: own.caseId }) });
    expect(ownLine.status).toBe(201);
    const [ownCase] = await getDb().select().from(orderCases).where(eq(orderCases.id, own.caseId));
    expect(ownCase!.pickingUserId).toBe(troubleshooterId);

    // Manager assigns a STAGED case originally reported by another picker.
    const assigned = await makePickerCase(pickerCookie, makeOrderNumber(), "12.tsw.1");
    expect((await stageRoute(request(`/api/cases/${assigned.caseId}/stage`, "POST",
      { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: assigned.caseId }) })).status).toBe(200);
    const assignment = await responsibilityRoute(request(`/api/cases/${assigned.caseId}/responsibility`, "POST",
      { userId: troubleshooterId }, managerCookie), { params: Promise.resolve({ id: assigned.caseId }) });
    expect(assignment.status).toBe(200);

    // Unrelated unassigned case from a different picker.
    const outsider = await makeUser("PICKER", "outsider");
    const outsiderCookie = (await createSession(outsider.id)).cookie.split(";")[0]!;
    const unrelated = await makePickerCase(outsiderCookie, makeOrderNumber(), "13.tsw.1");

    // Mine lists the assigned case once; the unrelated case is absent.
    const mine = await pickerCasesRoute(request("/api/picker/cases?page=1&pageSize=100", "GET", undefined, troubleshooterCookie));
    expect(mine.status).toBe(200);
    const mineBody = mineCasesBody.parse(await mine.json());
    const assignedEntries = mineBody.cases.filter((entry) => entry.id === assigned.caseId);
    expect(assignedEntries).toHaveLength(1);
    expect(mineBody.cases.some((entry) => entry.id === unrelated.caseId)).toBe(false);

    // Assignment notification is mandatory in-app unread; push outbox queued on the synthetic device.
    const inboxResponse = await notificationsRoute(request("/api/notifications?page=1&pageSize=50", "GET", undefined, troubleshooterCookie));
    expect(inboxResponse.status).toBe(200);
    const inbox = inboxBody.parse(await inboxResponse.json());
    const assignedNotice = inbox.notifications.find((note) => note.caseId === assigned.caseId && note.type === "RESPONSIBILITY_CASE_ASSIGNED");
    expect(assignedNotice).toBeDefined();
    expect(assignedNotice!.readAt).toBeNull();
    const [noticeRow] = await getDb().select().from(notifications)
      .where(and(eq(notifications.recipientUserId, troubleshooterId), eq(notifications.caseId, assigned.caseId)));
    const queued = await getDb().select().from(pushOutbox).where(eq(pushOutbox.notificationId, noticeRow!.id));
    expect(queued.length).toBeGreaterThan(0);

    // Default RECORD_REPLENISHMENT COMPLETE on the assigned STAGED line establishes the retrieval obligation.
    const replenished = await replenishmentRoute(request(`/api/cases/${assigned.caseId}/lines/${assigned.lineId}/replenishment`, "POST",
      { state: "COMPLETED", note: "Carton arrived" }, troubleshooterCookie),
      { params: Promise.resolve({ id: assigned.caseId, lineId: assigned.lineId }) });
    expect(replenished.status).toBe(201);
    const completed = replenishedBody.parse(await replenished.json());
    expect(completed.replenishment.retrievalResponsibleUserId).toBe(troubleshooterId);
    const queue = await retrievalsRoute(request("/api/retrievals?page=1&pageSize=50", "GET", undefined, troubleshooterCookie));
    expect(queue.status).toBe(200);
    expect(retrievalQueueBody.parse(await queue.json()).retrievals.some((entry) => entry.lineId === assigned.lineId)).toBe(true);

    // Failed then successful physical retrieval.
    expect((await retrieveRoute(request(`/api/cases/${assigned.caseId}/lines/${assigned.lineId}/retrieve`, "POST",
      { result: "FAILED" }, troubleshooterCookie), { params: Promise.resolve({ id: assigned.caseId, lineId: assigned.lineId }) })).status).toBe(200);
    expect((await retrieveRoute(request(`/api/cases/${assigned.caseId}/lines/${assigned.lineId}/retrieve`, "POST",
      { result: "RETRIEVED" }, troubleshooterCookie), { params: Promise.resolve({ id: assigned.caseId, lineId: assigned.lineId }) })).status).toBe(200);
    const [resolvedLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, assigned.lineId));
    expect(resolvedLine!.state).toBe("RESOLVED");

    // Resolver's rejected add-line form stays server-rejected on another picker's case (PICKING).
    const pickingOther = await makePickerCase(pickerCookie, makeOrderNumber(), "14.tsw.1");
    const rejected = await addLineRoute(request(`/api/cases/${pickingOther.caseId}/lines`, "POST",
      { location: "14.tsw.2", sku: "sku-tsw-rejected", quantity: 1 }, troubleshooterCookie),
      { params: Promise.resolve({ id: pickingOther.caseId }) });
    expect(rejected.status).toBe(403);
    // Assigned STAGED read without VIEW_CASE_MESSAGES: seeded manager message stays redacted, picker identity intact.
    expect((await messageRoute(request(`/api/cases/${assigned.caseId}/messages`, "POST",
      { message: "manager note for redaction proof" }, managerCookie), { params: Promise.resolve({ id: assigned.caseId }) })).status).toBe(201);
    await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "VIEW_CASE_MESSAGES") }).where(eq(users.id, troubleshooterId));
    const redactedCookie = (await createSession(troubleshooterId)).cookie.split(";")[0]!;
    try {
      const detail = await caseDetailRoute(request(`/api/cases/${assigned.caseId}`, "GET", undefined, redactedCookie),
        { params: Promise.resolve({ id: assigned.caseId }) });
      expect(detail.status).toBe(200);
      const detailBody = caseDetailBody.parse(await detail.json());
      expect(detailBody.case.messages).toEqual([]);
      expect(detailBody.case.pickingUserId).toBe(pickerId);
      expect(detailBody.case.phase).toBe("STAGED");
    } finally {
      await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER") }).where(eq(users.id, troubleshooterId));
    }


    // Terminal case closes through the authorized resolver; original picker identity is preserved.
    const closed = await closeRoute(request(`/api/cases/${assigned.caseId}/close`, "POST", {}, troubleshooterCookie),
      { params: Promise.resolve({ id: assigned.caseId }) });
    expect(closed.status).toBe(200);
    const [terminal] = await getDb().select().from(orderCases).where(eq(orderCases.id, assigned.caseId));
    expect(terminal).toMatchObject({ phase: "CLOSED", pickingUserId: pickerId });

    // Separate manager-assigned FOUND_AT_ORIGINAL complete (no claim) keeps source and history.
    const originalCase = await makePickerCase(pickerCookie, makeOrderNumber(), "15.tsw.1");
    expect((await assignRoute(request(`/api/checks/${originalCase.taskId}/assign`, "PATCH",
      { userId: troubleshooterId }, managerCookie), { params: Promise.resolve({ id: originalCase.taskId }) })).status).toBe(200);
    const assignedInboxResponse = await notificationsRoute(request("/api/notifications?page=1&pageSize=50", "GET", undefined, troubleshooterCookie));
    expect(assignedInboxResponse.status).toBe(200);
    const assignedInbox = inboxBody.parse(await assignedInboxResponse.json());
    const checkNotice = assignedInbox.notifications.find((note) => note.caseId === originalCase.caseId && note.type === "RESPONSIBILITY_CHECK_ASSIGNED");
    expect(checkNotice).toBeDefined();
    expect(checkNotice!.readAt).toBeNull();
    const [checkNoticeRow] = await getDb().select().from(notifications)
      .where(and(eq(notifications.recipientUserId, troubleshooterId), eq(notifications.caseId, originalCase.caseId), eq(notifications.type, "RESPONSIBILITY_CHECK_ASSIGNED")));
    const checkQueued = await getDb().select().from(pushOutbox).where(eq(pushOutbox.notificationId, checkNoticeRow!.id));
    expect(checkQueued.length).toBeGreaterThan(0);
    expect((await completeRoute(request(`/api/checks/${originalCase.taskId}/complete`, "POST",
      { code: "FOUND_AT_ORIGINAL" }, troubleshooterCookie), { params: Promise.resolve({ id: originalCase.taskId }) })).status).toBe(200);
    const history = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, originalCase.caseId));
    expect(history.map((event) => event.eventType)).toEqual(expect.arrayContaining(["CHECK_COMPLETED", "FOUND_AT_ORIGINAL_VERIFIED"]));
    const [originalLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, originalCase.lineId));
    expect(originalLine!.reportedByUserId).toBe(pickerId);

    // Revoked RECORD_REPLENISHMENT is rejected; VIEW_USERS/VIEW_ALL_OPEN_CASES stay absent.
    await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "RECORD_REPLENISHMENT") }).where(eq(users.id, troubleshooterId));
    const revokedCookie = (await createSession(troubleshooterId)).cookie.split(";")[0]!;
    try {
      const denied = await replenishmentRoute(request(`/api/cases/${originalCase.caseId}/lines/${originalCase.lineId}/replenishment`, "POST",
        { state: "WAITING", note: "revoked" }, revokedCookie),
        { params: Promise.resolve({ id: originalCase.caseId, lineId: originalCase.lineId }) });
      expect(denied.status).toBe(403);
    } finally {
      await getDb().update(users).set({ permissions: defaultPermissions("TROUBLESHOOTER") }).where(eq(users.id, troubleshooterId));
    }
    const [restored] = await getDb().select().from(users).where(eq(users.id, troubleshooterId));
    expect(restored!.permissions).not.toContain("VIEW_USERS");
    expect(restored!.permissions).not.toContain("VIEW_ALL_OPEN_CASES");
    void managerId;
  });
});
