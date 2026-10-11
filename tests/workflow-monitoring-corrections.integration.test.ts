import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, notificationPreferences, notifications, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";
import { POST as repairRoute } from "../src/app/api/cases/[id]/repair/route";
import { PATCH as assignCheckRoute } from "../src/app/api/checks/[id]/assign/route";
import { GET as notificationsRoute } from "../src/app/api/notifications/route";
import { PATCH as updatePreferencesRoute } from "../src/app/api/notifications/preferences/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type CaseBody = { case: { id: string; lines: Array<{ id: string }> } };
type LineBody = { line: { id: string } };
type NotificationRow = { id: string; type: string; caseId: string; shortPickLineId: string | null; payload: Record<string, unknown>; readAt: string | null };
type NotificationsBody = { notifications: NotificationRow[] };
type ProjectionRow = { lineId: string; displayStatus: string; nextActionCode: string; blockingReasonCode: string | null; actionOwnerUserId: string | null; replenishment: { state: string } };
type DetailBody = { case: { lineProjections: ProjectionRow[] } };
type ErrorBody = { code: string };

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describeDatabase("Workflow monitoring corrections against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerCookie = "";
  let pickerId = "";
  let leaderCookie = "";
  let leaderId = "";
  let managerCookie = "";
  let adminCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `wfmon-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(orderSuffix: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `6${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.wfmon.1", sku: "sku-wfmon", quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const body = await jsonBody<CaseBody>(response);
    caseIds.push(body.case.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, body.case.lines[0]!.id));
    return { caseId: body.case.id, lineId: body.case.lines[0]!.id, taskId: task!.id };
  }

  async function listNotifications(cookie: string): Promise<NotificationRow[]> {
    const response = await notificationsRoute(request("/api/notifications", "GET", undefined, cookie));
    expect(response.status).toBe(200);
    return (await jsonBody<NotificationsBody>(response)).notifications;
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const manager = await makeUser("MANAGER", "manager");
    const admin = await makeUser("ADMIN", "admin");
    pickerId = picker.id; leaderId = leader.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    managerCookie = (await createSession(manager.id)).cookie.split(";")[0]!;
    adminCookie = (await createSession(admin.id)).cookie.split(";")[0]!;
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

  it("emits NEW_SHORT_PICK for every added line, respects preferences and actor exclusion", async () => {
    const item = await makeCase("10");
    // Actor never receives their own monitoring emission.
    const pickerNotes = await listNotifications(pickerCookie);
    expect(pickerNotes.find((row) => row.type === "NEW_SHORT_PICK" && row.caseId === item.caseId)).toBeUndefined();

    const added = await addLineRoute(request(`/api/cases/${item.caseId}/lines`, "POST",
      { location: "02.wfmon.2", sku: "sku-wfmon", quantity: 2 }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(added.status).toBe(201);
    const addedLine = (await jsonBody<LineBody>(added)).line;
    const leaderNotes = await listNotifications(leaderCookie);
    const emission = leaderNotes.find((row) => row.type === "NEW_SHORT_PICK" && row.caseId === item.caseId && row.shortPickLineId === addedLine.id);
    expect(emission).toMatchObject({ type: "NEW_SHORT_PICK", caseId: item.caseId, shortPickLineId: addedLine.id });
    expect(emission?.payload).toMatchObject({ lineId: addedLine.id, orderNumber: expect.any(String) });

    // Opted-out manager sees no new emission for the next added line.
    expect((await updatePreferencesRoute(request("/api/notifications/preferences", "PATCH", { preferences: { NEW_SHORT_PICK: false } }, managerCookie))).status).toBe(200);
    const managerBefore = (await listNotifications(managerCookie)).filter((row) => row.type === "NEW_SHORT_PICK" && row.caseId === item.caseId).length;
    const duplicate = await addLineRoute(request(`/api/cases/${item.caseId}/lines`, "POST",
      { location: "02.wfmon.2", sku: "sku-wfmon", quantity: 1, confirmDuplicate: true }, leaderCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(duplicate.status).toBe(201);
    const dupLine = (await jsonBody<LineBody>(duplicate)).line;
    const managerAfter = (await listNotifications(managerCookie)).filter((row) => row.type === "NEW_SHORT_PICK" && row.caseId === item.caseId).length;
    expect(managerAfter).toBe(managerBefore);
    // Actor exclusion: leader added the duplicate, so the duplicate emission skips the leader themselves.
    const leaderAfter = await listNotifications(leaderCookie);
    expect(leaderAfter.find((row) => row.type === "NEW_SHORT_PICK" && row.shortPickLineId === dupLine.id)).toBeUndefined();
  });

  it("rejects plain duplicates without emitting monitoring", async () => {
    const item = await makeCase("11");
    const rejected = await addLineRoute(request(`/api/cases/${item.caseId}/lines`, "POST",
      { location: "01.wfmon.1", sku: "sku-wfmon", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(rejected.status).toBe(409);
    expect((await jsonBody<ErrorBody>(rejected)).code).toBe("DUPLICATE_LINE");
    const leaderNotes = await listNotifications(leaderCookie);
    expect(leaderNotes.filter((row) => row.type === "NEW_SHORT_PICK" && row.caseId === item.caseId && row.shortPickLineId !== item.lineId)).toHaveLength(0);
  });

  it("projects completed-replenishment priority above claimed checks and keeps picker assignment alerts", async () => {
    const item = await makeCase("12");
    const assigned = await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: pickerId }, leaderCookie),
      { params: Promise.resolve({ id: item.taskId }) });
    expect(assigned.status).toBe(200);
    // Mandatory picker assignment regression: picker-targeted assignment still notifies in-app.
    const pickerNotes = await listNotifications(pickerCookie);
    expect(pickerNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RESPONSIBILITY_CHECK_ASSIGNED", caseId: item.caseId }),
    ]));
    // Simulate a materialized COMPLETED replenishment obligation on the OPEN line without touching main state.
    await getDb().update(shortPickLines).set({ replenishmentState: "COMPLETED", retrievalState: "PENDING", retrievalResponsibleUserId: leaderId })
      .where(eq(shortPickLines.id, item.lineId));
    const detail = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(detail.status).toBe(200);
    const projections = (await jsonBody<DetailBody>(detail)).case.lineProjections;
    const projection = projections.find((entry) => entry.lineId === item.lineId)!;
    expect(projection.displayStatus).toBe("WAITING_RETRIEVAL");
    expect(projection.nextActionCode).toBe("RETRIEVE");
    expect(projection.blockingReasonCode).toBe("AWAITING_RETRIEVAL");
    expect(projection.actionOwnerUserId).toBe(leaderId);
    expect(projection.replenishment.state).toBe("COMPLETED");
  });

  it("rejects CORRECT_PHASE close/reopen bypasses atomically and keeps explicit CLOSE_CASE working", async () => {
    const closeTarget = await makeCase("13");
    const eventsBefore = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, closeTarget.caseId));
    const bypassClose = await repairRoute(request(`/api/cases/${closeTarget.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Attempt phase-only close", phase: "CLOSED" }, adminCookie),
      { params: Promise.resolve({ id: closeTarget.caseId }) });
    expect(bypassClose.status).toBe(409);
    expect((await jsonBody<ErrorBody>(bypassClose)).code).toBe("REPAIR_INVARIANT_VIOLATION");
    const [stillOpen] = await getDb().select().from(orderCases).where(eq(orderCases.id, closeTarget.caseId));
    expect(stillOpen?.phase).not.toBe("CLOSED");
    const eventsAfterClose = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, closeTarget.caseId));
    expect(eventsAfterClose).toHaveLength(eventsBefore.length);
    const auditAfterClose = await getDb().select().from(auditLog).where(eq(auditLog.action, "CASE_REPAIRED"));
    expect(auditAfterClose.some((log) => log.details.caseId === closeTarget.caseId)).toBe(false);

    // Explicit reasoned close still passes: same open-line precondition as existing tests.
    const repaired = await repairRoute(request(`/api/cases/${closeTarget.caseId}/repair`, "POST",
      { command: "CLOSE_CASE", reason: "Admin closes stale case with open lines" }, adminCookie),
      { params: Promise.resolve({ id: closeTarget.caseId }) });
    expect(repaired.status).toBe(200);
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, closeTarget.caseId));
    expect(closed?.phase).toBe("CLOSED");

    // Phase-only reopen out of CLOSED is rejected even with live checks/open lines present.
    const reopenTarget = await makeCase("14");
    await getDb().update(orderCases).set({ phase: "CLOSED", resolvedAt: new Date() }).where(eq(orderCases.id, reopenTarget.caseId));
    const reopenEventsBefore = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, reopenTarget.caseId));
    const bypassReopen = await repairRoute(request(`/api/cases/${reopenTarget.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Attempt phase-only reopen", phase: "PICKING" }, adminCookie),
      { params: Promise.resolve({ id: reopenTarget.caseId }) });
    expect(bypassReopen.status).toBe(409);
    expect((await jsonBody<ErrorBody>(bypassReopen)).code).toBe("REPAIR_INVARIANT_VIOLATION");
    const [stillClosed] = await getDb().select().from(orderCases).where(eq(orderCases.id, reopenTarget.caseId));
    expect(stillClosed?.phase).toBe("CLOSED");
    const reopenEventsAfter = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, reopenTarget.caseId));
    expect(reopenEventsAfter).toHaveLength(reopenEventsBefore.length);
    // Restore the row so shared cleanup can delete it normally.
    await getDb().update(orderCases).set({ phase: "PICKING", resolvedAt: null }).where(eq(orderCases.id, reopenTarget.caseId));
  });
});
