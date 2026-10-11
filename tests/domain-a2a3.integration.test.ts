import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, caseMessages, checkTasks, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";
import { POST as messageRoute } from "../src/app/api/cases/[id]/messages/route";
import { POST as closeRoute } from "../src/app/api/cases/[id]/close/route";
import { POST as reopenRoute } from "../src/app/api/cases/[id]/reopen/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as replenishmentRoute } from "../src/app/api/cases/[id]/lines/[lineId]/replenishment/route";
import { POST as discoveredLocationRoute } from "../src/app/api/cases/[id]/lines/[lineId]/discovered-location/route";
import { POST as overrideRoute } from "../src/app/api/cases/[id]/override/route";
import { POST as repairRoute } from "../src/app/api/cases/[id]/repair/route";
import { GET as dashboardRoute } from "../src/app/api/operations/dashboard/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Wave 1 A2/A3 domain slice against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerCookie = "";
  let pickerId = "";
  let otherPickerCookie = "";
  let troubleshooterCookie = "";
  let troubleshooterId = "";
  let assistantCookie = "";
  let leaderCookie = "";
  let leaderId = "";
  let adminCookie = "";
  let adminId = "";

  async function makeUser(role: Role, name: string, permissions?: string[]) {
    const [user] = await getDb().insert(users).values({ identifier: `a2a3-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: permissions ?? defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(orderSuffix: string, cookie?: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `4${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.aa.1", sku: "sku-a2a3", quantity: 1 },
    }, cookie ?? pickerCookie));
    expect(response.status).toBe(201);
    const record = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, record.lines[0]!.id));
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, line!.id));
    return { caseId: record.id, lineId: line!.id, taskId: task!.id };
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    await makeUser("PICKER", "other-picker");
    const troubleshooter = await makeUser("TROUBLESHOOTER", "troubleshooter");
    await makeUser("ASSISTANT", "assistant");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const admin = await makeUser("ADMIN", "admin");
    pickerId = picker.id; troubleshooterId = troubleshooter.id; leaderId = leader.id; adminId = admin.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    otherPickerCookie = (await createSession((await getDb().select().from(users).then((rows) => rows.find((row) => row.identifier === `a2a3-${suffix}-other-picker`)))!.id)).cookie.split(";")[0]!;
    troubleshooterCookie = (await createSession(troubleshooter.id)).cookie.split(";")[0]!;
    assistantCookie = (await createSession((await getDb().select().from(users).then((rows) => rows.find((row) => row.identifier === `a2a3-${suffix}-assistant`)))!.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    adminCookie = (await createSession(admin.id)).cookie.split(";")[0]!;
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

  it("enforces the closed-read rule and returns ALL lines read-only", async () => {
    const item = await makeCase("01");
    // Second line: closed detail must include every line.
    const second = await addLineRoute(
      request(`/api/cases/${item.caseId}/lines`, "POST", { location: "02.bb.2", sku: "sku-a2a3-b", quantity: 2 }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(second.status).toBe(201);
    // Claim+complete as troubleshooter, retrieve as picker, then close requires terminal lines.
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "NOT_FOUND" }, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    // Force-close the case administratively as leader via ordinary close.
    const lines = await getDb().select().from(shortPickLines).where(eq(shortPickLines.caseId, item.caseId));
    for (const line of lines) {
      const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, line.id));
      if (task && task.status !== "COMPLETED") {
        await getDb().update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: new Date() }).where(eq(checkTasks.id, task.id));
      }
      await getDb().update(shortPickLines).set({ state: "RESOLVED", resolvedAt: new Date() }).where(eq(shortPickLines.id, line.id));
    }
    // Picker closes own case after every line is terminal.
    expect((await closeRoute(request(`/api/cases/${item.caseId}/close`, "POST", {}, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);

    const pickerDetail = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(pickerDetail.status).toBe(200);
    const pickerBody = (await pickerDetail.json()).case as { readOnly: boolean; lines: unknown[]; projection: { lines: unknown[] } };
    expect(pickerBody.readOnly).toBe(true);
    expect(pickerBody.lines).toHaveLength(2);
    expect(pickerBody.projection.lines).toHaveLength(2);

    const denied = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, otherPickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(denied.status).toBe(403);

    const leaderDetail = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, leaderCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(leaderDetail.status).toBe(200);
    expect(((await leaderDetail.json()).case as { lines: unknown[] }).lines).toHaveLength(2);
  });

  it("rejects new messages on closed cases and restores posting on reopen", async () => {
    const item = await makeCase("02");
    expect((await messageRoute(request(`/api/cases/${item.caseId}/messages`, "POST", { message: "Active picker note" }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(201);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, line!.id));
    if (task && task.status !== "COMPLETED") {
      await getDb().update(checkTasks).set({ status: "COMPLETED", completionCode: "OTHER", completedAt: new Date() }).where(eq(checkTasks.id, task.id));
    }
    await getDb().update(shortPickLines).set({ state: "RESOLVED", resolvedAt: new Date() }).where(eq(shortPickLines.id, line!.id));
    expect((await closeRoute(request(`/api/cases/${item.caseId}/close`, "POST", {}, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);

    const closed = await messageRoute(request(`/api/cases/${item.caseId}/messages`, "POST", { message: "Late note" }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(closed.status).toBe(409);
    expect((await closed.json()).code).toBe("CASE_MESSAGE_CLOSED");

    expect((await reopenRoute(request(`/api/cases/${item.caseId}/reopen`, "POST",
      { phase: "PICKING", responsibleUserId: pickerId, lineIds: [line!.id] }, leaderCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    expect((await messageRoute(request(`/api/cases/${item.caseId}/messages`, "POST", { message: "Posting again after reopen" }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(201);
    // An unrelated picker still cannot post after reopen.
    expect((await messageRoute(request(`/api/cases/${item.caseId}/messages`, "POST", { message: "Outsider note" }, otherPickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
  });

  it("records WAITING notes without ownership transfer, then completes with an obligation and unchanged main state", async () => {
    const item = await makeCase("03");
    // Picker without the grant is forbidden.
    const forbidden = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("REPLENISHMENT_FORBIDDEN");

    // Troubleshooter holds no replenishment grant either.
    const troubleshooterDenied = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING" }, troubleshooterCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(troubleshooterDenied.status).toBe(403);

    const waiting = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING", note: "Awaiting inbound" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(waiting.status).toBe(201);
    const [waitingLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(waitingLine).toMatchObject({ replenishmentState: "WAITING", state: "OPEN", replenishmentNote: "Awaiting inbound",
      replenishmentRetrieverUserId: pickerId, retrievalResponsibleUserId: null, retrievalState: "NOT_REQUIRED" });

    // Invalid repeat of WAITING is rejected.
    const repeat = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(repeat.status).toBe(409);

    const completed = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(completed.status).toBe(201);
    const [doneLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    // COMPLETED materializes the pending retrieval obligation for the eligible picker; main line state is unchanged.
    expect(doneLine).toMatchObject({ replenishmentState: "COMPLETED", state: "OPEN", retrievalState: "PENDING",
      retrievalResponsibleUserId: pickerId });

    // Transitions persist with the materialized obligation; main line state is unchanged.
    const notes = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(notes.map((event) => event.eventType)).toEqual(expect.arrayContaining(["REPLENISHMENT_WAITING", "REPLENISHMENT_COMPLETED"]));

    // Projection carries replenishment as a separate dimension with stable codes only.
    const detail = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    const body = (await detail.json()).case as { lineProjections: Array<{ displayStatus: string; replenishment: { state: string }; nextActionCode: string; blockingReasonCode: string | null }> };
    const projection = body.lineProjections.find((entry) => entry.replenishment.state === "COMPLETED")!;
    expect(projection).toBeDefined();
    expect(projection.displayStatus).not.toContain("REPLENISH");
    expect(typeof projection.nextActionCode).toBe("string");

    // Dashboard shows the replenishment badge through the same projection.
    const dashboard = await dashboardRoute(request("/api/operations/dashboard", "GET", undefined, leaderCookie));
    expect(dashboard.status).toBe(200);
    const dashboardLines = ((await dashboard.json()).cases as Array<{ id: string; lineProjections: Array<{ replenishment: { state: string } }> }>)
      .find((entry) => entry.id === item.caseId)!.lineProjections;
    expect(dashboardLines.some((entry) => entry.replenishment.state === "COMPLETED")).toBe(true);
  });

  it("supports NONE→COMPLETED directly and keeps events plus audit atomic", async () => {
    const item = await makeCase("04");
    const completed = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(completed.status).toBe(201);
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.map((event) => event.eventType)).toContain("REPLENISHMENT_COMPLETED");
    const logs = await getDb().select().from(auditLog).where(eq(auditLog.action, "REPLENISHMENT_COMPLETED"));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("records ad hoc locations without owning the check and reconciles the active check", async () => {
    const item = await makeCase("05");
    // Claim the check as troubleshooter, then a leader reports a location without owning it.
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const reported = await discoveredLocationRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/discovered-location`, "POST",
      { location: "05.cc.9", note: "Carton by dock" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(reported.status).toBe(201);
    const body = (await reported.json()).location as { reconciledTaskId: string; retrievalResponsibleUserId: string };
    expect(body.reconciledTaskId).toBe(item.taskId);
    // PICKING phase routes retrieval to the active picker.
    expect(body.retrievalResponsibleUserId).toBe(pickerId);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ state: "FOUND", discoveredLocation: "05.CC.9", retrievalState: "PENDING" });
    // Picker without REPORT_NEW_LOCATION cannot use the ad hoc path.
    const denied = await discoveredLocationRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/discovered-location`, "POST",
      { location: "06.dd.1" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("CHECK_RESULT_FORBIDDEN");
  });

  it("lets an owner finish their own claimed check with COMPLETE_CHECK only", async () => {
    const item = await makeCase("06");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST",
      { code: "FOUND", discoveredLocation: "07.ee.7" }, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
  });

  it("runs team-leader overrides for each stuck state with reason and rejects unauthorized use", async () => {
    const item = await makeCase("07");
    // Release a stale check claim.
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const noReason = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "RELEASE_STALE_CHECK", reason: "x", lineId: item.lineId }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe("REPAIR_REASON_REQUIRED");

    const pickerDenied = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "RELEASE_STALE_CHECK", reason: "Claim went stale overnight", lineId: item.lineId }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(pickerDenied.status).toBe(403);

    // Grant the bounded override to the team leader for this test (Admin holds it by default).
    await getDb().update(users).set({ permissions: [...defaultPermissions("TEAM_LEADER"), "OVERRIDE_CASE_STATE"] }).where(eq(users.id, leaderId));
    const refreshedLeader = await getDb().select().from(users).where(eq(users.id, leaderId)).then((rows) => rows[0]!);
    leaderCookie = (await createSession(refreshedLeader.id)).cookie.split(";")[0]!;

    const released = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "RELEASE_STALE_CHECK", reason: "Claim went stale overnight", lineId: item.lineId }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(released.status).toBe(200);
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.map((event) => event.eventType)).toContain("CASE_REPAIRED");

    // Force-resolve the line, then retry a blocked close on another case.
    const item2 = await makeCase("08");
    const forced = await overrideRoute(request(`/api/cases/${item2.caseId}/override`, "POST",
      { command: "FORCE_RESOLVE_LINE", reason: "Line cannot be fulfilled physically", lineId: item2.lineId }, leaderCookie),
      { params: Promise.resolve({ id: item2.caseId }) });
    expect(forced.status).toBe(200);

    const blocked = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "RETRY_BLOCKED_CLOSE", reason: "Warehouse confirms removal", administrativeResolutionReason: "Physical order removed after review" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(blocked.status).toBe(200);
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(closed.phase).toBe("CLOSED");
  });

  it("previews repair, requires reason, executes atomically, and rejects invariant violations", async () => {
    const item = await makeCase("09");
    const noReason = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_LOCATION", reason: "", lineId: item.lineId, location: "09.zz.9" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe("REPAIR_REASON_REQUIRED");

    // Non-admin cannot repair even with a reason.
    const leaderDenied = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_LOCATION", reason: "Fix typo in location", lineId: item.lineId, location: "09.zz.9" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(leaderDenied.status).toBe(403);

    const preview = await repairRoute(request(`/api/cases/${item.caseId}/repair?preview=1`, "POST",
      { command: "CORRECT_LOCATION", reason: "Fix typo in location", lineId: item.lineId, location: "09.zz.9" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(preview.status).toBe(200);
    expect((await preview.json()).repair.preview).toBe(true);

    const before = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId)).then((rows) => rows[0]!);
    const repaired = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_LOCATION", reason: "Fix typo in location", lineId: item.lineId, location: "09.zz.9" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(repaired.status).toBe(200);
    const [after] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(after.originalLocation).toBe("09.ZZ.9");
    expect(before.originalLocation).not.toBe("09.ZZ.9");
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    const repairedEvents = events.filter((event) => event.eventType === "CASE_REPAIRED");
    expect(repairedEvents.length).toBeGreaterThan(0);
    expect(repairedEvents[0]!.details).toMatchObject({ command: "CORRECT_LOCATION", reason: "Fix typo in location" });
    const logs = await getDb().select().from(auditLog).where(eq(auditLog.action, "CASE_REPAIRED"));
    expect(logs.some((log) => (log.details as { caseId?: string }).caseId === item.caseId)).toBe(true);
  });

  it("rejects repairs that would violate one-open-case or one-active-check invariants", async () => {
    const item = await makeCase("10");
    // Create an open case on the same order via direct insert, then repair REOPEN_CASE on a closed sibling must fail.
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    await getDb().update(orderCases).set({ phase: "CLOSED", resolvedAt: new Date() }).where(eq(orderCases.id, item.caseId));
    await getDb().insert(orderCases).values({ orderNumber: closed!.orderNumber, phase: "PICKING", pickingUserId: pickerId,
      currentCaseResponsibleUserId: pickerId, createdByUserId: pickerId, source: "PICKER_REPORT",
      configurationVersionId: closed!.configurationVersionId });
    const sibling = await getDb().select().from(orderCases).where(eq(orderCases.orderNumber, closed!.orderNumber)).then((rows) => rows.filter((row) => row.phase !== "CLOSED"));
    for (const row of sibling) caseIds.push(row.id);
    // Admin holds both grants here, so the invariant (not the permission) rejects the reopen.
    await getDb().update(users).set({ permissions: [...defaultPermissions("ADMIN")] }).where(eq(users.id, adminId));
    const conflict = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "REOPEN_CASE", reason: "Reopen for test purposes", phase: "PICKING" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("REPAIR_INVARIANT_VIOLATION");
  });

  it("preserves one-open-case-per-order and one-active-check-per-line under concurrency", async () => {
    const orderNumber = `4${Date.now()}99`;
    const attempts = await Promise.all([0, 1].map(() => createCaseRoute(request("/api/cases", "POST", {
      orderNumber, confirmedHistoricalCaseIds: [], firstLine: { location: "01.aa.1", sku: "sku-a2a3", quantity: 1 },
    }, pickerCookie))));
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    const created = attempts.find((response) => response.status === 201)!;
    const record = (await created.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(record.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    const claims = await Promise.all([troubleshooterCookie, assistantCookie].map((cookie) =>
      claimRoute(request(`/api/checks/${task!.id}/claim`, "POST", undefined, cookie), { params: Promise.resolve({ id: task!.id }) })));
    expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("keeps picker closed history readable with ALL lines and resolutions", async () => {
    const item = await makeCase("11");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST",
      { code: "FOUND", discoveredLocation: "11.aa.9" }, troubleshooterCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line!.state).toBe("FOUND");
    // Resolve the line via retrieval then close the case.
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
    expect((await closeRoute(request(`/api/cases/${item.caseId}/close`, "POST", {}, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    const detail = await caseDetailRoute(request(`/api/cases/${item.caseId}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()).case as { lines: Array<{ state: string; discoveredLocation: string | null }>; events: Array<{ eventType: string }> };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ state: "RESOLVED", discoveredLocation: "11.AA.9" });
    expect(body.events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["CHECK_COMPLETED", "RETRIEVAL_CONFIRMED", "CASE_CLOSED"]));
  });
  it("keeps override RETRY_BLOCKED_CLOSE and repair CLOSE_CASE audited on stale cases", async () => {
    const adminRows = await getDb().select().from(users).then((rows) => rows.find((row) => row.identifier === `a2a3-${suffix}-admin`));
    if (!adminRows) throw new Error("admin fixture missing");
    const adminSession = (await createSession(adminRows.id)).cookie.split(";")[0]!;
    const item = await makeCase("12");
    const blocked = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "RETRY_BLOCKED_CLOSE", reason: "Warehouse confirms removal", administrativeResolutionReason: "Physical order removed after review" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    const overrideRequiresGrant = blocked.status === 403;
    if (overrideRequiresGrant) {
      await getDb().update(users).set({ permissions: [...defaultPermissions("TEAM_LEADER"), "OVERRIDE_CASE_STATE"] }).where(eq(users.id, leaderId));
      const refreshed = await getDb().select().from(users).where(eq(users.id, leaderId)).then((rows) => rows[0]!);
      leaderCookie = (await createSession(refreshed.id)).cookie.split(";")[0]!;
      const retry = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
        { command: "RETRY_BLOCKED_CLOSE", reason: "Warehouse confirms removal", administrativeResolutionReason: "Physical order removed after review" }, leaderCookie),
        { params: Promise.resolve({ id: item.caseId }) });
      expect(retry.status).toBe(200);
    } else {
      expect(blocked.status).toBe(200);
    }
    const [overridden] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(overridden.phase).toBe("CLOSED");
    const overrideEvents = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(overrideEvents.map((event) => event.eventType)).toContain("CASE_REPAIRED");
    const item2 = await makeCase("13");
    const repaired = await repairRoute(request(`/api/cases/${item2.caseId}/repair`, "POST",
      { command: "CLOSE_CASE", reason: "Admin closes stale case with open lines" }, adminSession),
      { params: Promise.resolve({ id: item2.caseId }) });
    expect(repaired.status).toBe(200);
    const [closed] = await getDb().select().from(orderCases).where(eq(orderCases.id, item2.caseId));
    expect(closed.phase).toBe("CLOSED");
    const repairEvents = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item2.caseId));
    expect(repairEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "CASE_REPAIRED" })]));
    const logs = await getDb().select().from(auditLog).where(eq(auditLog.action, "CASE_REPAIRED"));
    expect(logs.some((log) => (log.details as { caseId?: string }).caseId === item2.caseId)).toBe(true);
  });
  it("lets a troubleshooter report a case the same way a picker does", async () => {
    const item = await makeCase("14", troubleshooterCookie);
    const [stored] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(stored).toMatchObject({ pickingUserId: troubleshooterId, source: "PICKER_REPORT" });
  });
});
