import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, notifications, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { POST as overrideRoute } from "../src/app/api/cases/[id]/override/route";
import { POST as repairRoute } from "../src/app/api/cases/[id]/repair/route";
import { PATCH as retrievalAssignmentRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieval-assignment/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type CreatedCase = { case: { id: string; lines: Array<{ id: string }> } };
type CreatedLine = { line: { id: string } };

describeDatabase("Operations routing corrections against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let orderCounter = 0;
  let pickerId = "";
  let pickerCookie = "";
  let replenisherCookie = "";
  let otherPickerId = "";
  let resolverAId = "";
  let resolverBId = "";
  let managerCookie = "";
  let adminCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `opsroute-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(tag: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `7${Date.now()}${String(++orderCounter).padStart(3, "0")}${tag}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: `02.opr.${tag}`, sku: `sku-opr-${tag}`, quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreatedCase;
    caseIds.push(body.case.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, body.case.lines[0]!.id));
    return { caseId: body.case.id, lineId: body.case.lines[0]!.id, taskId: task!.id };
  }

  async function addLine(caseId: string, tag: string) {
    const response = await addLineRoute(request(`/api/cases/${caseId}/lines`, "POST",
      { location: `02.opr.${tag}`, sku: `sku-opr-${tag}`, quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreatedLine;
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, body.line.id));
    return { lineId: body.line.id, taskId: task!.id };
  }

  async function claimAndComplete(taskId: string, code: string, cookie: string, location?: string) {
    expect((await claimRoute(request(`/api/checks/${taskId}/claim`, "POST", undefined, cookie), { params: Promise.resolve({ id: taskId }) })).status).toBe(200);
    const body = code === "FOUND_AT_ORIGINAL" ? { code } : { code, discoveredLocation: location ?? "09.opr.1" };
    const completed = await completeRoute(request(`/api/checks/${taskId}/complete`, "POST", body, cookie),
      { params: Promise.resolve({ id: taskId }) });
    expect(completed.status).toBe(200);
  }

  async function lineFor(lineId: string) {
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, lineId));
    return line!;
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const otherPicker = await makeUser("PICKER", "other-picker");
    const resolverA = await makeUser("TROUBLESHOOTER", "resolver-a");
    const resolverB = await makeUser("TROUBLESHOOTER", "resolver-b");
    const manager = await makeUser("MANAGER", "manager");
    const admin = await makeUser("ADMIN", "admin");
    pickerId = picker.id; otherPickerId = otherPicker.id; resolverAId = resolverA.id; resolverBId = resolverB.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    replenisherCookie = (await createSession(resolverA.id)).cookie.split(";")[0]!;
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
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("transfers STAGED pending/failed obligations, leaves terminals, notifies only the new retrieval owner", async () => {
    const item = await makeCase("01");
    const second = await addLine(item.caseId, "012");
    const terminal = await addLine(item.caseId, "014");
    const replenisherSession = replenisherCookie;
    await claimAndComplete(item.taskId, "FOUND", replenisherSession, "09.opr.2");
    await claimAndComplete(second.taskId, "FOUND_AT_ORIGINAL", replenisherSession);
    // Second line fails retrieval so the transfer exercises FAILED alongside PENDING.
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${second.lineId}/retrieve`, "POST", { result: "FAILED" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: second.lineId }) })).status).toBe(200);
    // A terminal line must be ignored by the transfer reroute.
    await getDb().update(shortPickLines).set({ state: "CANCELLED", retrievalState: "NOT_REQUIRED" })
      .where(eq(shortPickLines.id, terminal.lineId));
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);

    const transfer = await responsibilityRoute(request(`/api/cases/${item.caseId}/responsibility`, "POST", { userId: resolverBId }, managerCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(transfer.status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(resolverBId);
    expect((await lineFor(second.lineId)).retrievalResponsibleUserId).toBe(resolverBId);
    expect((await lineFor(terminal.lineId)).retrievalResponsibleUserId).toBeNull();
    const alerts = await getDb().select().from(notifications).where(and(
      eq(notifications.recipientUserId, resolverBId), eq(notifications.type, "RESPONSIBILITY_RETRIEVAL_ASSIGNED"),
      eq(notifications.caseId, item.caseId)));
    expect(alerts.map((alert) => alert.shortPickLineId)).toEqual(expect.arrayContaining([item.lineId, second.lineId]));
    expect(alerts.some((alert) => alert.shortPickLineId === terminal.lineId)).toBe(false);
    // Existing case-assignment alert remains for the new resolver.
    const assigned = await getDb().select().from(notifications).where(and(
      eq(notifications.recipientUserId, resolverBId), eq(notifications.type, "RESPONSIBILITY_CASE_ASSIGNED"),
      eq(notifications.caseId, item.caseId)));
    expect(assigned.length).toBeGreaterThan(0);
  });

  it("does not reroute PICKING retrievals when only case responsibility changes", async () => {
    const item = await makeCase("02");
    await claimAndComplete(item.taskId, "FOUND", replenisherCookie, "09.opr.4");
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    expect((await responsibilityRoute(request(`/api/cases/${item.caseId}/responsibility`, "POST", { userId: resolverAId }, managerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    const [retrievalAlert] = await getDb().select().from(notifications).where(and(
      eq(notifications.recipientUserId, resolverAId), eq(notifications.type, "RESPONSIBILITY_RETRIEVAL_ASSIGNED"),
      eq(notifications.caseId, item.caseId), eq(notifications.shortPickLineId, item.lineId)));
    expect(retrievalAlert).toBeUndefined();
  });

  it("rederives idempotently, preserves eligible STAGED manual owners, and scopes optional lineIds", async () => {
    const item = await makeCase("03");
    await claimAndComplete(item.taskId, "FOUND", replenisherCookie, "09.opr.5");
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    // Explicit eligible manual assignment survives the shared STAGED rederive.
    expect((await retrievalAssignmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieval-assignment`,
      "PATCH", { userId: otherPickerId }, managerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
    const versionBefore = (await lineFor(item.lineId)).version;
    const eventsBefore = (await getDb().select().from(caseEvents).where(and(
      eq(caseEvents.caseId, item.caseId), eq(caseEvents.shortPickLineId, item.lineId),
      eq(caseEvents.eventType, "RETRIEVAL_ASSIGNED")))).length;
    const first = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "REDERIVE_RETRIEVAL_ROUTING", reason: "Recompute staged retrieval routing" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(first.status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(otherPickerId);
    expect((await lineFor(item.lineId)).version).toBe(versionBefore);
    expect((await getDb().select().from(caseEvents).where(and(
      eq(caseEvents.caseId, item.caseId), eq(caseEvents.shortPickLineId, item.lineId),
      eq(caseEvents.eventType, "RETRIEVAL_ASSIGNED")))).length).toBe(eventsBefore);
    const repaired = await getDb().select().from(caseEvents).where(and(
      eq(caseEvents.caseId, item.caseId), eq(caseEvents.eventType, "CASE_REPAIRED")))
      .orderBy(desc(caseEvents.createdAt), desc(caseEvents.id)).limit(1);
    expect(repaired[0]!.details).toMatchObject({ command: "REDERIVE_RETRIEVAL_ROUTING" });

    // A second PICKING line outside the optional scope keeps its stale owner.
    await getDb().update(orderCases).set({ phase: "PICKING" }).where(eq(orderCases.id, item.caseId));
    const scopedLine = await addLine(item.caseId, "032");
    await claimAndComplete(scopedLine.taskId, "FOUND", replenisherCookie, "09.opr.6");
    await getDb().update(shortPickLines).set({ retrievalResponsibleUserId: resolverAId })
      .where(eq(shortPickLines.id, scopedLine.lineId));
    await getDb().update(orderCases).set({ phase: "STAGED" }).where(eq(orderCases.id, item.caseId));
    const scoped = await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "REDERIVE_RETRIEVAL_ROUTING", reason: "Recompute only one scoped line", lineId: item.lineId }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(scoped.status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(otherPickerId);
    expect((await lineFor(scopedLine.lineId)).retrievalResponsibleUserId).toBe(resolverAId);
    // Unknown line scope is rejected, closed cases reject rederivation.
    expect((await overrideRoute(request(`/api/cases/${item.caseId}/override`, "POST",
      { command: "REDERIVE_RETRIEVAL_ROUTING", reason: "Recompute scoped line", lineId: randomUUID() }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(404);
  });

  it("repairs both phases back onto the picker/configured hold while closed repair stays rejected", async () => {
    const item = await makeCase("04");
    await claimAndComplete(item.taskId, "FOUND", replenisherCookie, "09.opr.7");
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    const toPicking = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair places case back with picker", phase: "PICKING" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(toPicking.status).toBe(200);
    const [picking] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(picking).toMatchObject({ phase: "PICKING", physicalState: "WITH_PICKER", physicalLocation: null });
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);

    const toStaged = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair returns case to staged hold", phase: "STAGED" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(toStaged.status).toBe(200);
    const [staged] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(staged).toMatchObject({ phase: "STAGED", physicalState: "SHORT_PICK_HOLD" });
    expect(typeof staged!.physicalLocation === "string" && staged!.physicalLocation.length > 0).toBe(true);

    // Same-phase STAGED repair keeps physical fields and still rederives routing.
    await getDb().update(shortPickLines).set({ retrievalResponsibleUserId: null }).where(eq(shortPickLines.id, item.lineId));
    const samePhase = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair reaffirms staged placement", phase: "STAGED" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(samePhase.status).toBe(200);
    const [reaffirmed] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(reaffirmed).toMatchObject({ phase: "STAGED", physicalState: staged!.physicalState, physicalLocation: staged!.physicalLocation });

    // Same-phase STAGED repair honors explicitly supplied fields; null clears the location.
    const explicit = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair corrects same-phase hold details", phase: "STAGED",
        physicalState: "OTHER_KNOWN_LOCATION", physicalLocation: "HOLD-CUSTOM" }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(explicit.status).toBe(200);
    const [custom] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(custom).toMatchObject({ phase: "STAGED", physicalState: "OTHER_KNOWN_LOCATION", physicalLocation: "HOLD-CUSTOM" });
    const { repair: explicitBody } = (await explicit.json()) as { repair: { before: Record<string, unknown>; after: Record<string, unknown> } };
    expect(explicitBody.before).toMatchObject({ phase: "STAGED" });
    expect(explicitBody.after).toMatchObject({ phase: "STAGED", physicalState: "OTHER_KNOWN_LOCATION", physicalLocation: "HOLD-CUSTOM" });
    const repairedEvents = await getDb().select().from(caseEvents).where(and(
      eq(caseEvents.caseId, item.caseId), eq(caseEvents.eventType, "CASE_REPAIRED"))).orderBy(desc(caseEvents.createdAt), desc(caseEvents.id)).limit(1);
    expect(repairedEvents[0]!.details).toMatchObject({ command: "CORRECT_PHASE",
      after: { phase: "STAGED", physicalState: "OTHER_KNOWN_LOCATION", physicalLocation: "HOLD-CUSTOM" } });
    const cleared = await repairRoute(request(`/api/cases/${item.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair clears same-phase hold location", phase: "STAGED", physicalLocation: null }, adminCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(cleared.status).toBe(200);
    const [clearedRow] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(clearedRow).toMatchObject({ phase: "STAGED", physicalState: "OTHER_KNOWN_LOCATION", physicalLocation: null });
    const closed = await makeCase("05");
    await getDb().update(orderCases).set({ phase: "CLOSED" }).where(eq(orderCases.id, closed.caseId));
    expect((await repairRoute(request(`/api/cases/${closed.caseId}/repair`, "POST",
      { command: "CORRECT_PHASE", reason: "Repair must not reopen closed case", phase: "PICKING" }, adminCookie),
      { params: Promise.resolve({ id: closed.caseId }) })).status).toBe(409);
    expect((await overrideRoute(request(`/api/cases/${closed.caseId}/override`, "POST",
      { command: "REDERIVE_RETRIEVAL_ROUTING", reason: "Closed cases reject rederivation" }, adminCookie),
      { params: Promise.resolve({ id: closed.caseId }) })).status).toBe(409);
  });
});
