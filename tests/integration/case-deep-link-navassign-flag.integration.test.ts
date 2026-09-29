import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../../src/db";
import { auditLog, caseEvents, checkTasks, notifications, orderCases, sessions, shortPickLines, users } from "../../src/db/schema";
import { defaultPermissions, type Role } from "../../src/domain/permissions";
import { createSession } from "../../src/server/auth";
import { hashPin } from "../../src/server/security";
import { POST as createCaseRoute } from "../../src/app/api/cases/route";
import { PATCH as assignRoute } from "../../src/app/api/checks/[id]/assign/route";
import { POST as completeRoute } from "../../src/app/api/checks/[id]/complete/route";
import { GET as caseDetailRoute } from "../../src/app/api/cases/[id]/route";
import { GET as notificationsRoute } from "../../src/app/api/notifications/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("NavAssign: assign-time picker retrieval flag (additive, no schema change)", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const runOrder = Date.now().toString().slice(-8);
  const userIds: string[] = [];
  const caseIds: string[] = [];
  let leaderCookie = "";
  let pickerCookie = "";
  let checkerId = "";
  let checkerCookie = "";
  let taskForTrue = "";
  let lineForTrue = "";
  let caseForTrue = "";
  let taskForFalse = "";

  async function makeUser(role: Role, suffix: string) {
    const rows = await getDb().insert(users).values({ identifier: `navassign-${runId}-${suffix}`, displayName: `NavAssign ${suffix}`,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    const user = rows[0];
    if (!user) throw new Error("user insert failed");
    userIds.push(user.id);
    return user;
  }

  async function makeCase(orderSuffix: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `4${runOrder}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "11.NA.1", sku: "NAVASSIGN", quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const record = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    return { caseId: record.id, lineId: record.lines[0]!.id, taskId: task!.id };
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const leader = await makeUser("TEAM_LEADER", "leader");
    const picker = await makeUser("PICKER", "picker");
    const checker = await makeUser("TROUBLESHOOTER", "checker");
    checkerId = checker.id;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    checkerCookie = (await createSession(checker.id)).cookie.split(";")[0]!;
    const first = await makeCase("1");
    caseForTrue = first.caseId;
    lineForTrue = first.lineId;
    taskForTrue = first.taskId;
    taskForFalse = (await makeCase("2")).taskId;
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      const lineRows = await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      if (lineRows.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineRows.map((row) => row.id)));
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("assign with pickerRetrieval=true records the choice on event details + payload and surfaces it on the read shape", async () => {
    const response = await assignRoute(request(`/api/checks/${taskForTrue}/assign`, "PATCH", { userId: checkerId, pickerRetrieval: true }, leaderCookie), { params: Promise.resolve({ id: taskForTrue }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ check: { pickerRetrieval: true, assignedToUserId: checkerId } });
    const events = await getDb().select().from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseForTrue), eq(caseEvents.shortPickLineId, lineForTrue)))
      .orderBy(desc(caseEvents.createdAt));
    const assignment = events.find((event) => event.eventType === "CHECK_ASSIGNED");
    expect((assignment?.details as Record<string, unknown>).pickerRetrieval).toBe(true);
    const list = await notificationsRoute(request("/api/notifications", "GET", undefined, checkerCookie));
    expect(list.status).toBe(200);
    const assignmentNotification = ((await list.json()).notifications as Array<{ type: string; caseId: string; payload: Record<string, unknown> }>)
      .find((row) => row.type === "RESPONSIBILITY_CHECK_ASSIGNED" && row.caseId === caseForTrue);
    expect(assignmentNotification?.payload.pickerRetrieval).toBe(true);
    const detail = await caseDetailRoute(request(`/api/cases/${caseForTrue}`, "GET", undefined, leaderCookie), { params: Promise.resolve({ id: caseForTrue }) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()).case as { lines: Array<{ id: string; pickerRetrieval?: boolean }> };
    expect(body.lines.find((line) => line.id === lineForTrue)?.pickerRetrieval).toBe(true);
  });

  it("completing a picker-retrieval check routes retrieval ownership to the case picker", async () => {
    const completed = await completeRoute(request(`/api/checks/${taskForTrue}/complete`, "POST", { code: "FOUND", discoveredLocation: "11.NA.9" }, checkerCookie), { params: Promise.resolve({ id: taskForTrue }) });
    expect(completed.status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, lineForTrue));
    expect(line.state).toBe("FOUND");
    const [picker] = await getDb().select({ id: users.id }).from(users).where(eq(users.identifier, `navassign-${runId}-picker`));
    expect(line.retrievalResponsibleUserId).toBe(picker!.id);
    const [flagged] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, lineForTrue));
    expect(flagged.retrievalState).toBe("PENDING");
  });

  it("assign without the flag preserves current behavior (pickerRetrieval=false, no Ready marker)", async () => {
    const response = await assignRoute(request(`/api/checks/${taskForFalse}/assign`, "PATCH", { userId: checkerId }, leaderCookie), { params: Promise.resolve({ id: taskForFalse }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ check: { pickerRetrieval: false, assignedToUserId: checkerId } });
  });
});
