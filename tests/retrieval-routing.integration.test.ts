import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, configurationVersions, notifications, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { PATCH as assignCheckRoute } from "../src/app/api/checks/[id]/assign/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { PATCH as phaseRoute } from "../src/app/api/cases/[id]/phase/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { POST as discoveredLocationRoute } from "../src/app/api/cases/[id]/lines/[lineId]/discovered-location/route";
import { PATCH as retrievalAssignmentRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieval-assignment/route";
import { GET as getConfigurationRoute, PATCH as patchConfigurationRoute } from "../src/app/api/admin/configuration/route";
import { GET as notificationsRoute } from "../src/app/api/notifications/route";
import { rerouteCaseRetrievals } from "../src/server/retrieval-routing";

const createdCaseSchema = z.object({ case: z.object({ id: z.uuid(), lines: z.array(z.object({ id: z.uuid() })).min(1) }) });
const discoveredLocationResponseSchema = z.object({ location: z.object({ retrievalResponsibleUserId: z.uuid().nullable() }) });
const notificationsResponseSchema = z.object({ notifications: z.array(z.object({ type: z.string(), caseId: z.uuid().nullable(), shortPickLineId: z.uuid().nullable() })) });
const configurationResponseSchema = z.object({ version: z.number().int().positive() });
const configurationRowSchema = z.object({ values: z.record(z.string(), z.unknown()).nullable() });
const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Retrieval routing convergence (F3/F4/F9) against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerId = "";
  let checkerId = "";
  let resolverId = "";
  let noRetrievalId = "";
  let pickerCookie = "";
  let checkerCookie = "";
  let leaderCookie = "";
  let leaderId = "";
  let initialConfigurationValues: Record<string, unknown> | null = null;
  let orderCounter = 0;

  async function makeUser(role: Role, name: string, permissions?: string[]) {
    const [user] = await getDb().insert(users).values({ identifier: `retrieval-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: permissions ?? defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(tag: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `8${Date.now()}${String(++orderCounter).padStart(3, "0")}${tag}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: `01.rt.${tag}`, sku: `sku-rt-${tag}`, quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const record = createdCaseSchema.parse(await response.json()).case;
    caseIds.push(record.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    return { caseId: record.id, lineId: record.lines[0]!.id, taskId: task!.id };
  }

  async function claimAndComplete(item: { taskId: string }, body: Record<string, unknown>, cookie = checkerCookie) {
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, cookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const completed = await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", body, cookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(completed.status).toBe(200);
  }

  async function lineFor(lineId: string) {
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, lineId));
    return line!;
  }

  async function setConfig(values: Record<string, unknown>) {
    const current = configurationResponseSchema.parse(await (await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, leaderCookie))).json());
    const response = await patchConfigurationRoute(request("/api/admin/configuration", "PATCH", { expectedVersion: current.version, values }, leaderCookie));
    expect(response.status).toBe(200);
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const [initial] = await getDb().select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    initialConfigurationValues = initial ? configurationRowSchema.parse({ values: initial.values }).values : null;
    const picker = await makeUser("PICKER", "picker");
    const checker = await makeUser("TROUBLESHOOTER", "checker");
    const resolver = await makeUser("TROUBLESHOOTER", "resolver");
    await makeUser("TROUBLESHOOTER", "no-retrieval", defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "CONFIRM_RETRIEVAL"));
    const leader = await makeUser("TEAM_LEADER", "leader");
    pickerId = picker.id; checkerId = checker.id; resolverId = resolver.id; leaderId = leader.id;
    const [noRetrieval] = await getDb().select().from(users).where(eq(users.identifier, `retrieval-${suffix}-no-retrieval`)).limit(1);
    noRetrievalId = noRetrieval!.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    checkerCookie = (await createSession(checker.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
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
    if (initialConfigurationValues) {
      const [current] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
      if (current && JSON.stringify(current.values) !== JSON.stringify(initialConfigurationValues)) {
        const response = await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
          { expectedVersion: current.version, values: initialConfigurationValues }, leaderCookie));
        expect(response.status).toBe(200);
      }
    }
    if (userIds.length) {
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("converges found-then-stage and stage-then-found for FOUND and FOUND_AT_ORIGINAL", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    for (const code of ["FOUND", "FOUND_AT_ORIGINAL"] as const) {
      const foundFirst = await makeCase(code === "FOUND" ? "21" : "22");
      expect((await responsibilityRoute(request(`/api/cases/${foundFirst.caseId}/responsibility`, "POST", { userId: resolverId }, leaderCookie),
        { params: Promise.resolve({ id: foundFirst.caseId }) })).status).toBe(200);
      await claimAndComplete(foundFirst, code === "FOUND" ? { code, discoveredLocation: "09.rr.1" } : { code });
      expect((await lineFor(foundFirst.lineId)).retrievalResponsibleUserId).toBe(pickerId);
      expect((await stageRoute(request(`/api/cases/${foundFirst.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
        { params: Promise.resolve({ id: foundFirst.caseId }) })).status).toBe(200);
      expect((await lineFor(foundFirst.lineId)).retrievalResponsibleUserId).toBe(resolverId);

      const stagedFirst = await makeCase(code === "FOUND" ? "23" : "24");
      expect((await responsibilityRoute(request(`/api/cases/${stagedFirst.caseId}/responsibility`, "POST", { userId: resolverId }, leaderCookie),
        { params: Promise.resolve({ id: stagedFirst.caseId }) })).status).toBe(200);
      expect((await stageRoute(request(`/api/cases/${stagedFirst.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
        { params: Promise.resolve({ id: stagedFirst.caseId }) })).status).toBe(200);
      await claimAndComplete(stagedFirst, code === "FOUND" ? { code, discoveredLocation: "09.rr.2" } : { code });
      expect((await lineFor(stagedFirst.lineId)).retrievalResponsibleUserId).toBe(resolverId);
    }
  });

  it("returns to picking on the eligible picker and sends the mandatory alert", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const item = await makeCase("31");
    expect((await responsibilityRoute(request(`/api/cases/${item.caseId}/responsibility`, "POST", { userId: resolverId }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    await claimAndComplete(item, { code: "FOUND", discoveredLocation: "09.rr.3" });
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(resolverId);
    const returned = await phaseRoute(request(`/api/cases/${item.caseId}/phase`, "PATCH", { phase: "PICKING" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) });
    expect(returned.status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    const pickerAlerts = await notificationsRoute(request("/api/notifications", "GET", undefined, pickerCookie));
    expect(pickerAlerts.status).toBe(200);
    expect(notificationsResponseSchema.parse(await pickerAlerts.json()).notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED", caseId: item.caseId, shortPickLineId: item.lineId }),
    ]));
  });

  it("never selects a checker without CONFIRM_RETRIEVAL and preserves the explicit picker override", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: true, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const noGrant = await makeUser("TROUBLESHOOTER", "claimer-no-grant",
      defaultPermissions("TROUBLESHOOTER").filter((permission) => permission !== "CONFIRM_RETRIEVAL"));
    const noGrantCookie = (await createSession(noGrant.id)).cookie.split(";")[0]!;
    const disabled = await makeCase("41");
    expect((await claimRoute(request(`/api/checks/${disabled.taskId}/claim`, "POST", undefined, noGrantCookie), { params: Promise.resolve({ id: disabled.taskId }) })).status).toBe(200);
    // Checker config enabled, but the checker lacks CONFIRM_RETRIEVAL: falls back to the picker.
    expect((await completeRoute(request(`/api/checks/${disabled.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.rr.4" }, noGrantCookie),
      { params: Promise.resolve({ id: disabled.taskId }) })).status).toBe(200);
    expect((await lineFor(disabled.lineId)).retrievalResponsibleUserId).toBe(pickerId);

    const overridden = await makeCase("42");
    expect((await assignCheckRoute(request(`/api/checks/${overridden.taskId}/assign`, "PATCH", { userId: checkerId, pickerRetrieval: true }, leaderCookie),
      { params: Promise.resolve({ id: overridden.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${overridden.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.rr.5" }, checkerCookie),
      { params: Promise.resolve({ id: overridden.taskId }) })).status).toBe(200);
    expect((await lineFor(overridden.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    expect((await stageRoute(request(`/api/cases/${overridden.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: overridden.caseId }) })).status).toBe(200);
    expect((await lineFor(overridden.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    const stagedReturn = await phaseRoute(request(`/api/cases/${overridden.caseId}/phase`, "PATCH", { phase: "PICKING" }, leaderCookie),
      { params: Promise.resolve({ id: overridden.caseId }) });
    expect(stagedReturn.status).toBe(200);
    expect((await lineFor(overridden.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    expect(noRetrievalId).toBeTruthy();
    expect(leaderId).toBeTruthy();
  });

  it("routes external discovery to the reconciled checker, matching staged completion", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const viaDiscovery = await makeCase("51");
    expect((await responsibilityRoute(request(`/api/cases/${viaDiscovery.caseId}/responsibility`, "POST", { userId: noRetrievalId }, leaderCookie),
      { params: Promise.resolve({ id: viaDiscovery.caseId }) })).status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${viaDiscovery.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: viaDiscovery.taskId }) })).status).toBe(200);
    expect((await stageRoute(request(`/api/cases/${viaDiscovery.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: viaDiscovery.caseId }) })).status).toBe(200);
    const reported = await discoveredLocationRoute(request(`/api/cases/${viaDiscovery.caseId}/lines/${viaDiscovery.lineId}/discovered-location`,
      "POST", { location: "09.rr.6", note: "converged" }, leaderCookie),
      { params: Promise.resolve({ id: viaDiscovery.caseId, lineId: viaDiscovery.lineId }) });
    expect(reported.status).toBe(201);
    expect(discoveredLocationResponseSchema.parse(await reported.json()).location.retrievalResponsibleUserId).toBe(checkerId);

    const viaCompletion = await makeCase("52");
    expect((await claimRoute(request(`/api/checks/${viaCompletion.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: viaCompletion.taskId }) })).status).toBe(200);
    expect((await stageRoute(request(`/api/cases/${viaCompletion.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: viaCompletion.caseId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${viaCompletion.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.rr.6" }, checkerCookie),
      { params: Promise.resolve({ id: viaCompletion.taskId }) })).status).toBe(200);
    expect((await lineFor(viaCompletion.lineId)).retrievalResponsibleUserId).toBe(checkerId);
  });

  it("scopes the picker override to the origin task even past 100 unrelated events", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: true, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const item = await makeCase("61");
    expect((await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerId, pickerRetrieval: true }, leaderCookie),
      { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    // Flood this case/line with >100 newer events on other task IDs; the SQL
    // taskId predicate must ignore them instead of the old LIMIT-100 window.
    await getDb().insert(caseEvents).values(Array.from({ length: 120 }, (_, index) => ({
      caseId: item.caseId, shortPickLineId: item.lineId, actorUserId: leaderId, eventType: "CHECK_ASSIGNED",
      details: { taskId: randomUUID(), assignedToUserId: checkerId, pickerRetrieval: false, flood: index },
    })));
    // Assigned tasks complete directly (no claim); override survives the flood.
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.rr.7" }, checkerCookie),
      { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    // A newer matching override without pickerRetrieval resets the choice to
    // the eligible checker; an older true must not leak through.
    const reset = await makeCase("62");
    expect((await assignCheckRoute(request(`/api/checks/${reset.taskId}/assign`, "PATCH", { userId: checkerId, pickerRetrieval: true }, leaderCookie),
      { params: Promise.resolve({ id: reset.taskId }) })).status).toBe(200);
    expect((await assignCheckRoute(request(`/api/checks/${reset.taskId}/assign`, "PATCH", { userId: checkerId }, leaderCookie),
      { params: Promise.resolve({ id: reset.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${reset.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.rr.8" }, checkerCookie),
      { params: Promise.resolve({ id: reset.taskId }) })).status).toBe(200);
    expect((await lineFor(reset.lineId)).retrievalResponsibleUserId).toBe(checkerId);
  });

  it("keeps the persisted external finder across staging with config on or off", async () => {
    // Two orders, case picker preserved (no responsibility transfer): staged
    // checker enabled picks the eligible finder; disabled must not silently
    // promote an ineligible finder or transfer the picker.
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const eligibleCase = await makeCase("71");
    const finderCookie = (await createSession(checkerId)).cookie.split(";")[0]!;
    const eligibleReport = await discoveredLocationRoute(request(`/api/cases/${eligibleCase.caseId}/lines/${eligibleCase.lineId}/discovered-location`,
      "POST", { location: "09.rr.9", note: "external eligible" }, finderCookie),
      { params: Promise.resolve({ id: eligibleCase.caseId, lineId: eligibleCase.lineId }) });
    expect(eligibleReport.status).toBe(201);
    // PICKING follows the picker rule even for external discovery; the finder
    // fallback decides at STAGED.
    expect(discoveredLocationResponseSchema.parse(await eligibleReport.json()).location.retrievalResponsibleUserId).toBe(pickerId);
    expect((await stageRoute(request(`/api/cases/${eligibleCase.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: eligibleCase.caseId }) })).status).toBe(200);
    expect((await lineFor(eligibleCase.lineId)).retrievalResponsibleUserId).toBe(checkerId);
    expect((await lineFor(eligibleCase.lineId)).discoveredByUserId).toBe(checkerId);

    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: false });
    const ineligibleCase = await makeCase("72");
    const ineligibleCookie = (await createSession(noRetrievalId)).cookie.split(";")[0]!;
    const ineligibleReport = await discoveredLocationRoute(request(`/api/cases/${ineligibleCase.caseId}/lines/${ineligibleCase.lineId}/discovered-location`,
      "POST", { location: "09.rr.A", note: "external ineligible" }, ineligibleCookie),
      { params: Promise.resolve({ id: ineligibleCase.caseId, lineId: ineligibleCase.lineId }) });
    expect(ineligibleReport.status).toBe(201);
    expect(discoveredLocationResponseSchema.parse(await ineligibleReport.json()).location.retrievalResponsibleUserId).toBe(pickerId);
    expect((await stageRoute(request(`/api/cases/${ineligibleCase.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: ineligibleCase.caseId }) })).status).toBe(200);
    // Staging must not promote the ineligible persisted finder, and must not
    // transfer the case picker as a staged owner.
    expect((await lineFor(ineligibleCase.lineId)).retrievalResponsibleUserId).toBeNull();
  });

  it("preserves an eligible manual staged assignment on rederive, never in picking or terminal", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const item = await makeCase("81");
    await claimAndComplete(item, { code: "FOUND", discoveredLocation: "09.rr.B" });
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    const otherChecker = await makeUser("TROUBLESHOOTER", "manual-other");
    expect((await retrievalAssignmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieval-assignment`,
      "PATCH", { userId: otherChecker.id }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(otherChecker.id);
    const [record] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    // Idempotent staged rederive keeps the still-eligible manual owner even
    // though the computed owner (eligible checker) differs.
    await getDb().transaction((tx) => rerouteCaseRetrievals(tx, {
      caseRecord: record!, actorUserId: leaderId, reason: "OVERRIDE_REDERIVE", preserveEligibleManualOwner: true,
    }));
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(otherChecker.id);
    // preserve=false rederives to the eligible checker.
    await getDb().transaction((tx) => rerouteCaseRetrievals(tx, {
      caseRecord: record!, actorUserId: leaderId, reason: "OVERRIDE_REDERIVE", preserveEligibleManualOwner: false,
    }));
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(checkerId);
    // PICKING never preserves a manual owner: return-to-picking follows the picker rule.
    expect((await phaseRoute(request(`/api/cases/${item.caseId}/phase`, "PATCH", { phase: "PICKING" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
    // Terminal lines are never touched by rederives.
    await getDb().update(shortPickLines).set({ state: "RESOLVED" }).where(and(eq(shortPickLines.id, item.lineId), eq(shortPickLines.caseId, item.caseId)));
    await getDb().transaction((tx) => rerouteCaseRetrievals(tx, {
      caseRecord: { ...record!, phase: "STAGED" }, actorUserId: leaderId, reason: "OVERRIDE_REDERIVE", preserveEligibleManualOwner: false,
    }));
    expect((await lineFor(item.lineId)).retrievalResponsibleUserId).toBe(pickerId);
  });

  it("carries case phase and location context on staged retrieval-owner alerts", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
    const item = await makeCase("91");
    expect((await responsibilityRoute(request(`/api/cases/${item.caseId}/responsibility`, "POST", { userId: resolverId }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    await claimAndComplete(item, { code: "FOUND", discoveredLocation: "09.rr.C" });
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    const [staged] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    const [alert] = await getDb().select().from(notifications).where(and(
      eq(notifications.recipientUserId, resolverId), eq(notifications.type, "RESPONSIBILITY_RETRIEVAL_ASSIGNED"),
      eq(notifications.caseId, item.caseId), eq(notifications.shortPickLineId, item.lineId),
    )).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(1);
    expect(alert?.payload).toMatchObject({ orderNumber: staged!.orderNumber, casePhase: "STAGED",
      discoveredLocation: "09.RR.C", originalLocation: expect.any(String), location: "09.RR.C", physicalLocation: staged!.physicalLocation });
  });
});
