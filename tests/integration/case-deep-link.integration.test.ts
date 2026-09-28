import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { closeDb, getDb } from "../../src/db";
import { auditLog, caseEvents, checkTasks, notificationPreferences, notifications, orderCases, sessions, shortPickLines, users } from "../../src/db/schema";
import { defaultPermissions, type Role } from "../../src/domain/permissions";
import { createSession } from "../../src/server/auth";
import { hashPin } from "../../src/server/security";
import { GET as getCase } from "../../src/app/api/cases/[id]/route";
import { POST as createCaseRoute } from "../../src/app/api/cases/route";
import { POST as addLine } from "../../src/app/api/cases/[id]/lines/route";
import { POST as closeCaseRoute } from "../../src/app/api/cases/[id]/close/route";
import { POST as postMessage } from "../../src/app/api/cases/[id]/messages/route";
import { GET as listNotifications } from "../../src/app/api/notifications/route";
import { POST as markRead } from "../../src/app/api/notifications/[id]/read/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const firstLine = { location: "11.DL.1", sku: "DEEP-LINK", quantity: 1 };

const CaseShape = z.object({ case: z.object({ id: z.string(), phase: z.string(),
  lines: z.array(z.object({ id: z.string() })).optional(),
  messages: z.array(z.object({ id: z.string() })).optional() }) });
const ErrorShape = z.object({ code: z.string().optional(), error: z.string().optional() });
const NotificationsShape = z.object({ notifications: z.array(z.object({ id: z.string(),
  caseId: z.string().nullable(), shortPickLineId: z.string().nullable(), readAt: z.string().nullable() })) });

function sessionCookie(raw: string): string {
  const first = raw.split(";")[0];
  if (!first) throw new Error("missing session cookie");
  return first;
}

describeDatabase("Integration slice: case deep link (open, closed, denied, reload)", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const runOrder = Date.now().toString().slice(-8);
  const userIds: string[] = [];
  const caseIds: string[] = [];
  let pickerCookie = "";
  let strangerCookie = "";
  let leaderCookie = "";
  let gatedLeaderCookie = "";
  let openCaseId = "";
  let closedCaseId = "";

  async function makeUser(role: Role, suffix: string, permissions = defaultPermissions(role)) {
    const rows = await getDb().insert(users).values({ identifier: `deeplink-${runId}-${suffix}`, displayName: `Deep ${suffix}`,
      pinHash: await hashPin("123456"), role, permissions }).returning();
    const user = rows[0];
    if (!user) throw new Error("user insert failed");
    userIds.push(user.id);
    return user;
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const stranger = await makeUser("PICKER", "stranger");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const gatedLeader = await makeUser("TEAM_LEADER", "gated", defaultPermissions("TEAM_LEADER").filter((permission) => permission !== "VIEW_CASE_MESSAGES"));
    pickerCookie = sessionCookie((await createSession(picker.id)).cookie);
    strangerCookie = sessionCookie((await createSession(stranger.id)).cookie);
    leaderCookie = sessionCookie((await createSession(leader.id)).cookie);
    gatedLeaderCookie = sessionCookie((await createSession(gatedLeader.id)).cookie);

    const openResponse = await createCaseRoute(request("/api/cases", "POST", { orderNumber: `1${runOrder}`, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    expect(openResponse.status).toBe(201);
    openCaseId = CaseShape.parse(await openResponse.json()).case.id;
    caseIds.push(openCaseId);

    const closedResponse = await createCaseRoute(request("/api/cases", "POST", { orderNumber: `2${runOrder}`, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    expect(closedResponse.status).toBe(201);
    closedCaseId = CaseShape.parse(await closedResponse.json()).case.id;
    caseIds.push(closedCaseId);
    const secondLine = await addLine(request(`/api/cases/${closedCaseId}/lines`, "POST", { location: "11.DL.2", sku: "DEEP-LINK-2", quantity: 2 }, pickerCookie), { params: Promise.resolve({ id: closedCaseId }) });
    expect(secondLine.status).toBe(201);
    const closed = await closeCaseRoute(request(`/api/cases/${closedCaseId}/close`, "POST", { administrativeResolutionReason: "deep link fixture closure" }, leaderCookie), { params: Promise.resolve({ id: closedCaseId }) });
    expect(closed.status).toBe(200);
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      const lineRows = await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      if (lineRows.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineRows.map((row) => row.id)));
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
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

  it("opens the exact open case for the owner, a manager, and on reload with the same access check", async () => {
    for (const cookie of [pickerCookie, leaderCookie]) {
      const response = await getCase(request(`/api/cases/${openCaseId}`, "GET", undefined, cookie), { params: Promise.resolve({ id: openCaseId }) });
      expect(response.status).toBe(200);
      expect(CaseShape.parse(await response.json()).case).toMatchObject({ id: openCaseId, phase: "PICKING" });
    }
    const reload = await getCase(request(`/api/cases/${openCaseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: openCaseId }) });
    expect(reload.status).toBe(200);
    expect(CaseShape.parse(await reload.json()).case).toMatchObject({ id: openCaseId, phase: "PICKING" });
  });

  it("denies an unrelated picker with a clear error, including on reload", async () => {
    const denied = await getCase(request(`/api/cases/${openCaseId}`, "GET", undefined, strangerCookie), { params: Promise.resolve({ id: openCaseId }) });
    expect(denied.status).toBe(403);
    expect(ErrorShape.parse(await denied.json()).code).toBe("CASE_ACCESS_DENIED");
    const reloadDenied = await getCase(request(`/api/cases/${openCaseId}`, "GET", undefined, strangerCookie), { params: Promise.resolve({ id: openCaseId }) });
    expect(reloadDenied.status).toBe(403);
  });

  it("returns a missing case as not found", async () => {
    const missingId = randomUUID();
    const response = await getCase(request(`/api/cases/${missingId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: missingId }) });
    expect(response.status).toBe(404);
  });

  it("resolves a closed case read-only with ALL lines for the owner and a manager", async () => {
    const storedLines = await getDb().select().from(shortPickLines).where(eq(shortPickLines.caseId, closedCaseId));
    expect(storedLines).toHaveLength(2);
    for (const cookie of [pickerCookie, leaderCookie]) {
      const response = await getCase(request(`/api/cases/${closedCaseId}`, "GET", undefined, cookie), { params: Promise.resolve({ id: closedCaseId }) });
      expect(response.status).toBe(200);
      const body = CaseShape.parse(await response.json()).case;
      expect(body.phase).toBe("CLOSED");
      expect(body.lines).toHaveLength(storedLines.length);
    }
    const denied = await getCase(request(`/api/cases/${closedCaseId}`, "GET", undefined, strangerCookie), { params: Promise.resolve({ id: closedCaseId }) });
    expect(denied.status).toBe(403);
  });

  it("gates message content on VIEW_CASE_MESSAGES while keeping the closed case readable", async () => {
    const open = await getCase(request(`/api/cases/${closedCaseId}`, "GET", undefined, gatedLeaderCookie), { params: Promise.resolve({ id: closedCaseId }) });
    expect(open.status).toBe(200);
    expect(CaseShape.parse(await open.json()).case).toMatchObject({ id: closedCaseId, messages: [] });
  });

  it("rejects new messages on the closed case", async () => {
    const response = await postMessage(request(`/api/cases/${closedCaseId}/messages`, "POST", { message: "late note" }, leaderCookie), { params: Promise.resolve({ id: closedCaseId }) });
    expect(response.status).toBe(409);
    expect(ErrorShape.parse(await response.json()).code).toBe("CASE_MESSAGE_CLOSED");
  });

  it("marks the notification read, then resolves the exact case with its line target", async () => {
    const list = await listNotifications(request("/api/notifications", "GET", undefined, leaderCookie));
    expect(list.status).toBe(200);
    const target = NotificationsShape.parse(await list.json()).notifications.find((row) => row.caseId === openCaseId);
    if (!target) throw new Error("expected a notification for the open case");
    expect(target.caseId).toBe(openCaseId);
    expect(typeof target.shortPickLineId).toBe("string");
    const caseId = target.caseId;
    const lineId = target.shortPickLineId;
    if (!caseId || !lineId) throw new Error("expected case and line targets on the notification");
    const read = await markRead(request(`/api/notifications/${target.id}/read`, "POST", undefined, leaderCookie), { params: Promise.resolve({ id: target.id }) });
    expect(read.status).toBe(200);
    const reread = await markRead(request(`/api/notifications/${target.id}/read`, "POST", undefined, leaderCookie), { params: Promise.resolve({ id: target.id }) });
    expect(reread.status).toBe(200);
    const resolved = await getCase(request(`/api/cases/${caseId}`, "GET", undefined, leaderCookie), { params: Promise.resolve({ id: caseId }) });
    expect(resolved.status).toBe(200);
    const body = CaseShape.parse(await resolved.json()).case;
    expect((body.lines ?? []).map((line) => line.id)).toContain(lineId);
  });
});
