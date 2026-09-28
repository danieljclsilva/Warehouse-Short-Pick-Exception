import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, caseMessages, checkTasks, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as manualRoute } from "../src/app/api/cases/manual/route";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as messageRoute } from "../src/app/api/cases/[id]/messages/route";
import { POST as closeRoute } from "../src/app/api/cases/[id]/close/route";
import { POST as reopenRoute } from "../src/app/api/cases/[id]/reopen/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";
import { GET as dashboardRoute } from "../src/app/api/operations/dashboard/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Phase 4 operations against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let assistantCookie = "";
  let pickerCookie = "";
  let resolverCookie = "";
  let leaderCookie = "";
  let resolverId = "";
  let pickerId = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `ops-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  beforeAll(async () => {
    await getDb().select().from(caseMessages).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const resolver = await makeUser("TROUBLESHOOTER", "resolver");
    const assistant = await makeUser("ASSISTANT", "assistant");
    const leader = await makeUser("TEAM_LEADER", "leader");
    pickerId = picker.id; resolverId = resolver.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    resolverCookie = (await createSession(resolver.id)).cookie.split(";")[0]!;
    assistantCookie = (await createSession(assistant.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
  });

  afterAll(async () => {
    if (caseIds.length) {
      const db = getDb();
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      await db.delete(caseMessages).where(inArray(caseMessages.caseId, caseIds));
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

  it("creates a staged manual case and keeps operational notes immutable", async () => {
    const response = await manualRoute(request("/api/cases/manual", "POST", { orderNumber: `8${Date.now()}1`, originalPickerUserId: pickerId,
      firstLine: { location: "hold.1", sku: "item-1", quantity: 2 } }, assistantCookie));
    expect(response.status).toBe(201);
    const record = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const [stored] = await getDb().select().from(orderCases).where(eq(orderCases.id, record.id));
    expect(stored).toMatchObject({ phase: "STAGED", physicalState: "SHORT_PICK_HOLD", source: "ASSISTANT_MANUAL", pickingUserId: pickerId });
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    expect(task.status).toBe("AVAILABLE");
    const denied = await messageRoute(request(`/api/cases/${record.id}/messages`, "POST", { message: "Picker note" }, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(denied.status).toBe(403);
    const note = await messageRoute(request(`/api/cases/${record.id}/messages`, "POST", { message: "Carton beside hold.", lineId: record.lines[0]!.id }, assistantCookie), { params: Promise.resolve({ id: record.id }) });
    expect(note.status).toBe(201);
    const [saved] = await getDb().select().from(caseMessages).where(eq(caseMessages.caseId, record.id));
    expect(saved).toMatchObject({ message: "Carton beside hold.", shortPickLineId: record.lines[0]!.id });
    const pickerDetail = await caseDetailRoute(request(`/api/cases/${record.id}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(pickerDetail.status).toBe(200);
    // Pickers read messages on accessible cases; posting stays restricted to responsible participants.
    expect((await pickerDetail.json()).case.messages).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Carton beside hold." })]));
    const assistantDetail = await caseDetailRoute(request(`/api/cases/${record.id}`, "GET", undefined, assistantCookie), { params: Promise.resolve({ id: record.id }) });
    expect((await assistantDetail.json()).case.messages).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Carton beside hold." })]));
    const dashboard = await dashboardRoute(request("/api/operations/dashboard", "GET", undefined, assistantCookie));
    expect(dashboard.status).toBe(200);
    expect(((await dashboard.json()).cases as Array<{ id: string }>).some((item) => item.id === record.id)).toBe(true);
  });

  it("allows a picker to close a case after retrieval resolves every line", async () => {
    const orderNumber = "8" + Date.now() + "3";
    const created = await createCaseRoute(request("/api/cases", "POST", { orderNumber, confirmedHistoricalCaseIds: [],
      firstLine: { location: "pick.3", sku: "item-3", quantity: 1 } }, pickerCookie));
    expect(created.status).toBe(201);
    const record = (await created.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const lineId = record.lines[0]!.id;
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, lineId));
    expect((await claimRoute(request("/api/checks/" + task!.id + "/claim", "POST", undefined, resolverCookie), { params: Promise.resolve({ id: task!.id }) })).status).toBe(200);
    expect((await completeRoute(request("/api/checks/" + task!.id + "/complete", "POST", { code: "FOUND", discoveredLocation: "hold.3" }, resolverCookie), { params: Promise.resolve({ id: task!.id }) })).status).toBe(200);
    expect((await retrieveRoute(request("/api/cases/" + record.id + "/lines/" + lineId + "/retrieve", "POST", { result: "RETRIEVED" }, pickerCookie), { params: Promise.resolve({ id: record.id, lineId }) })).status).toBe(200);
    expect((await closeRoute(request("/api/cases/" + record.id + "/close", "POST", {}, pickerCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(200);
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, record.id));
    expect(closed).toMatchObject({ phase: "CLOSED", resolvedByUserId: pickerId });
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, record.id));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "CASE_CLOSED", actorUserId: pickerId })]));
  });

  it("requires terminal lines for ordinary closure, preserves history, and reopens explicitly", async () => {
    const orderNumber = `8${Date.now()}2`;
    const created = await manualRoute(request("/api/cases/manual", "POST", { orderNumber, firstLine: { location: "hold.2", sku: "item-2", quantity: 1 } }, assistantCookie));
    expect(created.status).toBe(201);
    const record = (await created.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const closePath = `/api/cases/${record.id}/close`;
    expect((await closeRoute(request(closePath, "POST", {}, assistantCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(409);
    expect((await closeRoute(request(closePath, "POST", { administrativeResolutionReason: "Physical order removed after warehouse review" }, pickerCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(403);
    expect((await responsibilityRoute(request(`/api/cases/${record.id}/responsibility`, "POST", { userId: resolverId }, assistantCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(200);
    expect((await closeRoute(request(closePath, "POST", { administrativeResolutionReason: "Physical order removed after warehouse review" }, assistantCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(200);
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, record.id));
    expect(closed).toMatchObject({ phase: "CLOSED", currentCaseResponsibleUserId: closed.resolvedByUserId });
    const dashboard = await dashboardRoute(request("/api/operations/dashboard", "GET", undefined, assistantCookie));
    const summaries = (await dashboard.json()).recentClosedCases as Array<Record<string, unknown>>;
    expect(summaries.find((item) => item.id === record.id)).toMatchObject({
      id: record.id, orderNumber, phase: "CLOSED", createdAt: expect.any(String), resolvedAt: expect.any(String),
      pickerName: null, responsibleName: "assistant",
    });
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, record.lines[0]!.id));
    expect(line).toMatchObject({ state: "CANCELLED", resolutionCode: "ADMINISTRATIVE" });
    const reopenPath = `/api/cases/${record.id}/reopen`;
    expect((await reopenRoute(request(reopenPath, "POST", { phase: "STAGED", responsibleUserId: resolverId, lineIds: [line.id] }, pickerCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(403);
    expect((await reopenRoute(request(reopenPath, "POST", { phase: "STAGED", responsibleUserId: resolverId, lineIds: [line.id] }, leaderCookie), { params: Promise.resolve({ id: record.id }) })).status).toBe(200);
    const [reopened] = await getDb().select().from(orderCases).where(eq(orderCases.id, record.id));
    expect(reopened).toMatchObject({ phase: "STAGED", currentCaseResponsibleUserId: resolverId, resolvedAt: null });
    const events = (await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, record.id))).map((event) => event.eventType);
    expect(events).toEqual(expect.arrayContaining(["CASE_CLOSED", "CASE_REOPENED", "RESPONSIBILITY_CHANGED"]));
    expect((await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, line.id))).map((task) => task.status)).toEqual(expect.arrayContaining(["COMPLETED", "AVAILABLE"]));
  });
});
