import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, configurationVersions, notificationPreferences, notifications, orderCases, pushOutbox, pushSubscriptions, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as responsibilityRoute } from "../src/app/api/cases/[id]/responsibility/route";
import { POST as discoveredLocationRoute } from "../src/app/api/cases/[id]/lines/[lineId]/discovered-location/route";
import { GET as notificationsRoute } from "../src/app/api/notifications/route";
import { POST as completeCheckRoute } from "../src/app/api/checks/[id]/complete/route";
import { GET as getConfigurationRoute, PATCH as patchConfigurationRoute } from "../src/app/api/admin/configuration/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const notificationRowSchema = z.array(z.object({
  id: z.string(), type: z.string(), caseId: z.string().nullable(),
  shortPickLineId: z.string().nullable(), payload: z.record(z.string(), z.unknown()), dedupeKey: z.string().optional().nullable(),
}));
const configurationResponseSchema = z.object({ version: z.number().int().positive() });
const configurationRowSchema = z.object({ values: z.record(z.string(), z.unknown()).nullable() });

describeDatabase("Workflow informational staging and external-resolution alerts", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  const subscriptionIds: string[] = [];
  let orderCounter = 0;
  let pickerId = "";
  let pickerCookie = "";
  let checkerId = "";
  let checkerCookie = "";
  let resolverId = "";
  let leaderCookie = "";
  let finderId = "";
  let finderCookie = "";
  let unrelatedPickerId = "";
  let initialConfigurationValues: Record<string, unknown> | null = null;

  async function makeUser(role: Role, name: string, permissions?: string[]) {
    const [user] = await getDb().insert(users).values({ identifier: `wfinfo-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: permissions ?? defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function sessionCookie(userId: string) {
    return (await createSession(userId)).cookie.split(";")[0]!;
  }

  async function setConfig(values: Record<string, unknown>) {
    const current = configurationResponseSchema.parse(await (await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, leaderCookie))).json());
    const response = await patchConfigurationRoute(request("/api/admin/configuration", "PATCH", { expectedVersion: current.version, values }, leaderCookie));
    expect(response.status).toBe(200);
  }

  async function makeCase(tag: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `5${Date.now()}${String(orderCounter++).padStart(3, "0")}${tag}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: `01.wi.${tag}`, sku: `SKU-WI-${tag}`, quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const created = (await response.json()).case as { id: string; lines: Array<{ id: string }> };
    caseIds.push(created.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, created.lines[0]!.id));
    return { caseId: created.id, lineId: created.lines[0]!.id, taskId: task!.id };
  }

  async function listNotifications(cookie: string, caseId: string) {
    const response = await notificationsRoute(request("/api/notifications", "GET", undefined, cookie));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { notifications: unknown };
    const visible = notificationRowSchema.parse(body.notifications).filter((row) => row.caseId === caseId);
    const persisted = visible.length ? await getDb().select().from(notifications).where(inArray(notifications.id, visible.map((row) => row.id))) : [];
    return visible.map((row) => ({ ...row, dedupeKey: persisted.find((item) => item.id === row.id)?.dedupeKey }));
  }

  async function eventsFor(caseId: string, type: string) {
    return getDb().select().from(caseEvents).where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.eventType, type)));
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const [initial] = await getDb().select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    initialConfigurationValues = initial ? configurationRowSchema.parse({ values: initial.values }).values : null;
    const picker = await makeUser("PICKER", "picker");
    const checker = await makeUser("TROUBLESHOOTER", "checker");
    const resolver = await makeUser("TROUBLESHOOTER", "resolver");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const finder = await makeUser("TEAM_LEADER", "finder");
    const unrelatedPicker = await makeUser("PICKER", "unrelated");
    pickerId = picker.id; checkerId = checker.id; resolverId = resolver.id;
    finderId = finder.id; unrelatedPickerId = unrelatedPicker.id;
    pickerCookie = await sessionCookie(picker.id);
    checkerCookie = await sessionCookie(checker.id);
    leaderCookie = await sessionCookie(leader.id);
    finderCookie = await sessionCookie(finder.id);
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false, CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true });
  });

  afterAll(async () => {
    const db = getDb();
    if (subscriptionIds.length) {
      await db.delete(pushOutbox).where(inArray(pushOutbox.subscriptionId, subscriptionIds));
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, subscriptionIds));
    }
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
        await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
          { expectedVersion: current.version, values: initialConfigurationValues }, leaderCookie));
      }
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

  it("stages once for a previous checker plus explicit resolver, excluding the actor and unrelated picker", async () => {
    const item = await makeCase("101");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await responsibilityRoute(request(`/api/cases/${item.caseId}/responsibility`, "POST", { userId: resolverId }, leaderCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    const [stored] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    const checkerNotes = await listNotifications(await sessionCookie(checkerId), item.caseId);
    const resolverNotes = await listNotifications(await sessionCookie(resolverId), item.caseId);
    const stagedChecker = checkerNotes.filter((row) => row.type === "ORDER_STAGED");
    const stagedResolver = resolverNotes.filter((row) => row.type === "ORDER_STAGED");
    expect(stagedChecker).toHaveLength(1);
    expect(stagedResolver).toHaveLength(1);
    expect(stagedChecker[0]!.payload).toMatchObject({ orderNumber: stored!.orderNumber, casePhase: "STAGED", physicalLocation: stored!.physicalLocation });
    expect(stagedChecker[0]!.dedupeKey).toBe(`ORDER_STAGED:${item.caseId}:${stored!.version}:${checkerId}`);
    const actorNotes = await listNotifications(pickerCookie, item.caseId);
    expect(actorNotes.filter((row) => row.type === "ORDER_STAGED")).toHaveLength(0);
    const unrelatedNotes = await listNotifications(await sessionCookie(unrelatedPickerId), item.caseId);
    expect(unrelatedNotes.filter((row) => row.type === "ORDER_STAGED")).toHaveLength(0);
    const disabled = await getDb().update(users).set({ status: "DISABLED" }).where(eq(users.id, checkerId)).returning({ id: users.id });
    expect(disabled).toHaveLength(1);
    await getDb().update(users).set({ status: "ACTIVE" }).where(eq(users.id, checkerId));
  });

  it("keeps the unchanged retrieval owner staged notice but skips a same-action changed owner", async () => {
    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: true });
    const unchangedItem = await makeCase("102");
    expect((await responsibilityRoute(request(`/api/cases/${unchangedItem.caseId}/responsibility`, "POST", { userId: checkerId }, leaderCookie), { params: Promise.resolve({ id: unchangedItem.caseId }) })).status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${unchangedItem.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: unchangedItem.taskId }) })).status).toBe(200);
    const completed = await completeCheckRoute(request(`/api/checks/${unchangedItem.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.wi.2" }, checkerCookie),
      { params: Promise.resolve({ id: unchangedItem.taskId }) });
    expect(completed.status).toBe(200);
    expect((await stageRoute(request(`/api/cases/${unchangedItem.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: unchangedItem.caseId }) })).status).toBe(200);
    const [unchangedLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, unchangedItem.lineId));
    expect(unchangedLine!.retrievalResponsibleUserId).toBe(checkerId);
    const resolverUnchanged = await listNotifications(await sessionCookie(checkerId), unchangedItem.caseId);
    expect(resolverUnchanged.filter((row) => row.type === "ORDER_STAGED")).toHaveLength(1);

    await setConfig({ CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false });
    const changedItem = await makeCase("103");
    expect((await claimRoute(request(`/api/checks/${changedItem.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: changedItem.taskId }) })).status).toBe(200);
    const changedCompleted = await completeCheckRoute(request(`/api/checks/${changedItem.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "09.WI.3" }, checkerCookie),
      { params: Promise.resolve({ id: changedItem.taskId }) });
    expect(changedCompleted.status).toBe(200);
    const [beforeStage] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, changedItem.lineId));
    expect(beforeStage!.retrievalResponsibleUserId).toBe(pickerId);
    expect((await stageRoute(request(`/api/cases/${changedItem.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: changedItem.caseId }) })).status).toBe(200);
    const [changedLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, changedItem.lineId));
    expect(changedLine!.retrievalResponsibleUserId).toBe(checkerId);
    const checkerChanged = await listNotifications(await sessionCookie(checkerId), changedItem.caseId);
    expect(checkerChanged.filter((row) => row.type === "ORDER_STAGED")).toHaveLength(0);
    const changedAssignment = checkerChanged.find((row) => row.type === "RESPONSIBILITY_RETRIEVAL_ASSIGNED");
    expect(changedAssignment).toBeTruthy();
    expect(changedAssignment!.payload).toMatchObject({ casePhase: "STAGED", physicalLocation: "SHORT PICK / HOLD" });
  });
  it("informs the externally reconciled active checker in-app plus queued push, ignoring prefs", async () => {
    const item = await makeCase("104");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const savedEnv = { publicKey: process.env.PUSH_PUBLIC_KEY, privateKey: process.env.PUSH_PRIVATE_KEY, subject: process.env.PUSH_SUBJECT };
    process.env.PUSH_PUBLIC_KEY = "BPUSHKEY-TEST-PLACEHOLDER-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PUSH_PRIVATE_KEY = "PRIVATE-TEST-PLACEHOLDER-AAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PUSH_SUBJECT = "mailto:test@example.invalid";
    try {
      const devices = await getDb().insert(pushSubscriptions).values([
        { userId: checkerId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-checker`, p256dh: "A".repeat(87), auth: "B".repeat(22) },
      ]).returning({ id: pushSubscriptions.id });
      subscriptionIds.push(...devices.map((device) => device.id));
      await getDb().insert(notificationPreferences).values({ userId: checkerId, key: "NEW_LOCATION", enabled: false });
      const reported = await discoveredLocationRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/discovered-location`,
        "POST", { location: "09.WI.4", note: "dock carton" }, finderCookie),
        { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
      expect(reported.status).toBe(201);
      const checkerNotes = await listNotifications(await sessionCookie(checkerId), item.caseId);
      const info = checkerNotes.find((row) => row.type === "CHECK_RESOLVED_EXTERNALLY");
      expect(info).toBeTruthy();
      expect(info!.payload).toMatchObject({ taskId: item.taskId, code: "FOUND", location: "09.WI.4", finderUserId: finderId });
      expect(info!.dedupeKey).toBe(`CHECK_RESOLVED_EXTERNALLY:${item.taskId}:${checkerId}`);
      const queued = await getDb().select().from(pushOutbox).where(eq(pushOutbox.notificationId, info!.id));
      expect(queued.length).toBeGreaterThan(0);
      const externalEvents = await eventsFor(item.caseId, "CHECK_COMPLETED");
      expect(externalEvents.filter((event) => {
        const details = event.details as Record<string, unknown>;
        return details.taskId === item.taskId && details.source === "EXTERNAL_DISCOVERY";
      })).toHaveLength(1);
      const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.actorUserId, finderId), eq(auditLog.action, "DISCOVERED_LOCATION_REPORTED")));
      expect(audits.some((row) => {
        const details = row.details as Record<string, unknown>;
        return details.taskId === item.taskId && details.source === "EXTERNAL_DISCOVERY" && details.previousCheckerUserId === checkerId;
      })).toBe(true);
      const repeated = await discoveredLocationRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/discovered-location`,
        "POST", { location: "09.WI.5" }, leaderCookie),
        { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
      expect(repeated.status).toBe(201);
      const afterRepeat = await listNotifications(await sessionCookie(checkerId), item.caseId);
      expect(afterRepeat.filter((row) => row.type === "CHECK_RESOLVED_EXTERNALLY")).toHaveLength(1);
      const afterEvents = await eventsFor(item.caseId, "CHECK_COMPLETED");
      expect(afterEvents.filter((event) => {
        const details = event.details as Record<string, unknown>;
        return details.source === "EXTERNAL_DISCOVERY";
      })).toHaveLength(1);
    } finally {
      for (const [key, value] of Object.entries({ PUSH_PUBLIC_KEY: savedEnv.publicKey, PUSH_PRIVATE_KEY: savedEnv.privateKey, PUSH_SUBJECT: savedEnv.subject })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("skips external notices for same-actor, unassigned, and historical-only checks", async () => {
    const sameActor = await makeCase("105");
    expect((await claimRoute(request(`/api/checks/${sameActor.taskId}/claim`, "POST", undefined, finderCookie), { params: Promise.resolve({ id: sameActor.taskId }) })).status).toBe(200);
    expect((await discoveredLocationRoute(request(`/api/cases/${sameActor.caseId}/lines/${sameActor.lineId}/discovered-location`,
      "POST", { location: "09.WI.6" }, finderCookie), { params: Promise.resolve({ id: sameActor.caseId, lineId: sameActor.lineId }) })).status).toBe(201);
    expect((await listNotifications(await sessionCookie(finderId), sameActor.caseId)).filter((row) => row.type === "CHECK_RESOLVED_EXTERNALLY")).toHaveLength(0);

    const unassigned = await makeCase("106");
    expect((await discoveredLocationRoute(request(`/api/cases/${unassigned.caseId}/lines/${unassigned.lineId}/discovered-location`,
      "POST", { location: "09.WI.7" }, finderCookie), { params: Promise.resolve({ id: unassigned.caseId, lineId: unassigned.lineId }) })).status).toBe(201);
    expect((await eventsFor(unassigned.caseId, "CHECK_COMPLETED")).filter((event) => {
      const details = event.details as Record<string, unknown>;
      return details.source === "EXTERNAL_DISCOVERY";
    })).toHaveLength(1);
    expect((await listNotifications(await sessionCookie(checkerId), unassigned.caseId)).filter((row) => row.type === "CHECK_RESOLVED_EXTERNALLY")).toHaveLength(0);

    const historical = await makeCase("107");
    expect((await claimRoute(request(`/api/checks/${historical.taskId}/claim`, "POST", undefined, checkerCookie), { params: Promise.resolve({ id: historical.taskId }) })).status).toBe(200);
    const historicalCompleted = await completeCheckRoute(request(`/api/checks/${historical.taskId}/complete`, "POST", { code: "OTHER" }, checkerCookie),
      { params: Promise.resolve({ id: historical.taskId }) });
    expect(historicalCompleted.status).toBe(200);
    expect((await discoveredLocationRoute(request(`/api/cases/${historical.caseId}/lines/${historical.lineId}/discovered-location`,
      "POST", { location: "09.WI.8" }, finderCookie), { params: Promise.resolve({ id: historical.caseId, lineId: historical.lineId }) })).status).toBe(201);
    expect((await listNotifications(await sessionCookie(checkerId), historical.caseId)).filter((row) => row.type === "CHECK_RESOLVED_EXTERNALLY")).toHaveLength(0);
    const [historicalLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, historical.lineId));
    expect(["FOUND", "OPEN"]).toContain(historicalLine!.state);
  });
});
