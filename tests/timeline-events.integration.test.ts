/**
 * Timeline readCase shaping: CHECK_COMPLETED events carry the resolution code
 * plus discovered/original location context already on the event.
 * Disposable DB only (`*_test`); skipped without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type ShapedEvent = {
  id: string;
  eventType: string;
  completionCode: string | null;
  taskId: string | null;
  discoveredLocation: string | null;
  originalLocation: string | null;
};

describeDatabase("timeline CHECK_COMPLETED shaping against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerCookie = "";
  let checkerCookie = "";
  let leaderCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({
      identifier: `timeline-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role),
    }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(orderSuffix: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `8${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.aa.1", sku: "sku-a", quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const record = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    return { caseId: record.id, lineId: record.lines[0]!.id, taskId: task!.id };
  }

  beforeAll(async () => {
    await getDb().select().from(checkTasks).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const checker = await makeUser("TROUBLESHOOTER", "checker");
    const leader = await makeUser("TEAM_LEADER", "leader");
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    checkerCookie = (await createSession(checker.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    void leaderCookie;
  });

  afterAll(async () => {
    if (caseIds.length) {
      const db = getDb();
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      const lineIds = (await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds))).map((row) => row.id);
      if (lineIds.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      const db = getDb();
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("shapes FOUND_AT_ORIGINAL with original location and FOUND with discovered location", async () => {
    const original = await makeCase("71");
    expect((await claimRoute(request(`/api/checks/${original.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: original.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${original.taskId}/complete`, "POST", { code: "FOUND_AT_ORIGINAL" }, checkerCookie), { params: Promise.resolve({ id: original.taskId }) })).status).toBe(200);

    const second = await makeCase("72");
    expect((await claimRoute(request(`/api/checks/${second.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: second.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${second.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "02.bb.9" }, checkerCookie), { params: Promise.resolve({ id: second.taskId }) })).status).toBe(200);

    const firstDetail = await (await caseDetailRoute(request(`/api/cases/${original.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: original.caseId }) })).json();
    const firstCompleted = (firstDetail.case.events as ShapedEvent[]).filter((event) => event.eventType === "CHECK_COMPLETED");
    expect(firstCompleted).toHaveLength(1);
    expect(firstCompleted[0]).toMatchObject({ completionCode: "FOUND_AT_ORIGINAL", taskId: original.taskId, originalLocation: "01.AA.1" });

    const secondDetail = await (await caseDetailRoute(request(`/api/cases/${second.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: second.caseId }) })).json();
    const secondCompleted = (secondDetail.case.events as ShapedEvent[]).filter((event) => event.eventType === "CHECK_COMPLETED");
    expect(secondCompleted).toHaveLength(1);
    expect(secondCompleted[0]).toMatchObject({ completionCode: "FOUND", taskId: second.taskId, discoveredLocation: "02.BB.9" });
    expect(secondCompleted[0]!.completionCode).not.toBe(firstCompleted[0]!.completionCode);
  });

  it("leaves non-completion events with null shaped fields", async () => {
    const item = await makeCase("73");
    const detail = await (await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).json();
    const created = (detail.case.events as ShapedEvent[]).filter((event) => event.eventType === "CASE_CREATED");
    expect(created.length).toBeGreaterThan(0);
    for (const event of created) {
      expect(event.completionCode).toBeNull();
      expect(event.discoveredLocation).toBeNull();
      expect(event.originalLocation).toBeNull();
    }
  });
});
