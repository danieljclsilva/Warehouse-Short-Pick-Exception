import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, notifications, orderCases, pushOutbox, pushSubscriptions, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { PATCH as assignCheckRoute } from "../src/app/api/checks/[id]/assign/route";
import { POST as replenishmentRoute } from "../src/app/api/cases/[id]/lines/[lineId]/replenishment/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";
import { GET as retrievalsRoute } from "../src/app/api/retrievals/route";
import { GET as listChecksRoute } from "../src/app/api/checks/route";
import { GET as directoryRoute } from "../src/app/api/users/directory/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as completeCheckRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as requestCheckRoute } from "../src/app/api/cases/[id]/lines/[lineId]/checks/route";

const createdCaseBody = z.object({ case: z.object({ id: z.uuid(), lines: z.array(z.object({ id: z.uuid() }).passthrough()) }) });
const addedLineBody = z.object({ line: z.object({ id: z.uuid() }).passthrough() });
const replenishmentBody = z.object({ replenishment: z.object({
  retrievalResponsibleUserId: z.string().nullable(), ownerName: z.string().nullable(),
  retrievalLocation: z.string().nullable(), nextAction: z.string(),
}).passthrough() });
const retrievalQueueBody = z.object({ retrievals: z.array(z.object({
  lineId: z.uuid(), replenishmentState: z.string(), lineState: z.string(),
}).passthrough()) });
const checkQueueBody = z.object({ items: z.array(z.object({ id: z.uuid() }).passthrough()) });
const directoryBody = z.object({ users: z.array(z.object({ id: z.uuid(), displayName: z.string(), role: z.string() }).passthrough()) });

type CaseEventRow = typeof caseEvents.$inferSelect;

function eventDetailField(event: CaseEventRow, field: string): unknown {
  const details = event.details;
  if (details && typeof details === "object" && !Array.isArray(details) && field in details) return details[field as keyof typeof details];
  return undefined;
}

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Replenishment obligations and retrieval against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  const subscriptionIds: string[] = [];
  let pickerId = "";
  let pickerCookie = "";
  let otherPickerId = "";
  let troubleshooterId = "";
  let troubleshooterCookie = "";
  let assistantId = "";
  let assistantCookie = "";
  let leaderId = "";
  let leaderCookie = "";

  async function makeUser(role: Role, name: string, permissions?: string[]) {
    const [user] = await getDb().insert(users).values({ identifier: `repl-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: permissions ?? defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(orderSuffix: string, cookie?: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `7${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.aa.1", sku: "sku-repl", quantity: 1 },
    }, cookie ?? pickerCookie));
    expect(response.status).toBe(201);
    const record = createdCaseBody.parse(await response.json()).case;
    caseIds.push(record.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, record.lines[0]!.id));
    return { caseId: record.id, lineId: record.lines[0]!.id, taskId: task!.id };
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const otherPicker = await makeUser("PICKER", "other-picker", [...defaultPermissions("PICKER"), "CONFIRM_RETRIEVAL"]);
    const troubleshooter = await makeUser("TROUBLESHOOTER", "troubleshooter");
    const assistant = await makeUser("ASSISTANT", "assistant");
    const leader = await makeUser("TEAM_LEADER", "leader");
    pickerId = picker.id; otherPickerId = otherPicker.id;
    troubleshooterId = troubleshooter.id; assistantId = assistant.id; leaderId = leader.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    troubleshooterCookie = (await createSession(troubleshooter.id)).cookie.split(";")[0]!;
    assistantCookie = (await createSession(assistant.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    // Fake push subscriptions only (no real send): verify normal push queueing on completion notifications.
    const devices = await getDb().insert(pushSubscriptions).values([
      { userId: pickerId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-picker`, p256dh: "A".repeat(87), auth: "B".repeat(22) },
      { userId: troubleshooterId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-troubleshooter`, p256dh: "C".repeat(87), auth: "D".repeat(22) },
    ]).returning({ id: pushSubscriptions.id });
    subscriptionIds.push(...devices.map((device) => device.id));
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
    if (userIds.length) {
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("records WAITING notes with named owner, actor, and time without transferring ownership", async () => {
    const item = await makeCase("10");
    const response = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING", note: "  Awaiting inbound carton  ", retrieverUserId: pickerId }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(response.status).toBe(201);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ replenishmentState: "WAITING", replenishmentNote: "Awaiting inbound carton",
      replenishmentActorUserId: assistantId, replenishmentRetrieverUserId: pickerId,
      state: "OPEN", retrievalState: "NOT_REQUIRED", retrievalResponsibleUserId: null });
    expect(line!.replenishmentAt).toBeInstanceOf(Date);
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.map((event) => event.eventType)).toContain("REPLENISHMENT_WAITING");
    expect(events.find((event) => event.eventType === "REPLENISHMENT_WAITING")!.details).toMatchObject({ note: "Awaiting inbound carton" });
    // WAITING with an ineligible named target is rejected.
    const second = await makeCase("101");
    const noGrant = await makeUser("PICKER", "waiting-no-grant", defaultPermissions("PICKER").filter((permission) => permission !== "CONFIRM_RETRIEVAL"));
    const denied = await replenishmentRoute(request(`/api/cases/${second.caseId}/lines/${second.lineId}/replenishment`, "POST",
      { state: "WAITING", retrieverUserId: noGrant.id }, assistantCookie),
      { params: Promise.resolve({ id: second.caseId, lineId: second.lineId }) });
    expect(denied.status).toBe(400);
  });

  it("completes NONE->COMPLETED directly with pending obligation, notification, and unchanged main state", async () => {
    const item = await makeCase("11");
    const savedEnv = { publicKey: process.env.PUSH_PUBLIC_KEY, privateKey: process.env.PUSH_PRIVATE_KEY, subject: process.env.PUSH_SUBJECT };
    process.env.PUSH_PUBLIC_KEY = "BPUSHKEY-TEST-PLACEHOLDER-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PUSH_PRIVATE_KEY = "PRIVATE-TEST-PLACEHOLDER-AAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PUSH_SUBJECT = "mailto:test@example.invalid";
    try {
      const response = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
        { state: "COMPLETED", note: "Carton arrived" }, assistantCookie),
        { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
      expect(response.status).toBe(201);
      const body = replenishmentBody.parse(await response.json()).replenishment;
      // PICKING defaults to the eligible picker.
      expect(body.retrievalResponsibleUserId).toBe(pickerId);
      expect(body.ownerName!.length).toBeGreaterThan(0);
      expect(body.retrievalLocation).toBe("01.AA.1");
      expect(body.nextAction).toBe("RETRIEVE_AT_LOCATION");
      const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
      expect(line).toMatchObject({ replenishmentState: "COMPLETED", state: "OPEN", retrievalState: "PENDING",
        retrievalResponsibleUserId: pickerId, discoveredLocation: null });
      const notes = await getDb().select().from(notifications)
        .where(and(eq(notifications.shortPickLineId, item.lineId), eq(notifications.type, "RESPONSIBILITY_RETRIEVAL_ASSIGNED")));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ recipientUserId: pickerId });
      expect(notes[0]!.payload).toMatchObject({ retrievalLocation: "01.AA.1", originalLocation: "01.AA.1" });
      const queued = await getDb().select().from(pushOutbox).where(eq(pushOutbox.notificationId, notes[0]!.id));
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.every((row) => row.status === "QUEUED")).toBe(true);
      const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
      expect(events.map((event) => event.eventType)).toContain("REPLENISHMENT_COMPLETED");
    } finally {
      for (const [key, value] of Object.entries({ PUSH_PUBLIC_KEY: savedEnv.publicKey, PUSH_PRIVATE_KEY: savedEnv.privateKey, PUSH_SUBJECT: savedEnv.subject })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("denies invalid, disabled, unpermitted, and wrong-phase completion targets", async () => {
    const item = await makeCase("12");
    // Unknown target fails.
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED", retrieverUserId: randomUUID() }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(400);
    // Disabled target fails.
    await getDb().update(users).set({ status: "DISABLED" }).where(eq(users.id, otherPickerId));
    try {
      expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
        { state: "COMPLETED", retrieverUserId: otherPickerId }, assistantCookie),
        { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(400);
    } finally {
      await getDb().update(users).set({ status: "ACTIVE" }).where(eq(users.id, otherPickerId));
    }
    // Unpermitted target (no CONFIRM_RETRIEVAL) fails.
    const noGrant = await makeUser("PICKER", "no-retrieval-grant", defaultPermissions("PICKER").filter((permission) => permission !== "CONFIRM_RETRIEVAL"));
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED", retrieverUserId: noGrant.id }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(400);
    // Wrong-phase target: eligible checker is rejected in PICKING without config enablement or an explicit choice.
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED", retrieverUserId: troubleshooterId }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(409);
    // Invalid explicit target is never silently substituted: the line stays untouched.
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line!.replenishmentState).toBe("NONE");
  });

  it("lets a granted picker record their own case but blocks an unrelated picker", async () => {
    const grantedPicker = await makeUser("PICKER", "granted-picker", [...defaultPermissions("PICKER"), "RECORD_REPLENISHMENT"]);
    const grantedCookie = (await createSession(grantedPicker.id)).cookie.split(";")[0]!;
    const own = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `7${Date.now()}13`, confirmedHistoricalCaseIds: [],
      firstLine: { location: "01.aa.9", sku: "sku-own", quantity: 1 },
    }, grantedCookie));
    expect(own.status).toBe(201);
    const record = createdCaseBody.parse(await own.json()).case;
    caseIds.push(record.id);
    expect((await replenishmentRoute(request(`/api/cases/${record.id}/lines/${record.lines[0]!.id}/replenishment`, "POST",
      { state: "COMPLETED" }, grantedCookie),
      { params: Promise.resolve({ id: record.id, lineId: record.lines[0]!.id }) })).status).toBe(201);
    // Unrelated granted picker cannot touch another picker's case.
    const outsider = await makeUser("PICKER", "outsider-picker", [...defaultPermissions("PICKER"), "RECORD_REPLENISHMENT"]);
    const outsiderCookie = (await createSession(outsider.id)).cookie.split(";")[0]!;
    const denied = await replenishmentRoute(request(`/api/cases/${record.id}/lines/${record.lines[0]!.id}/replenishment`, "POST",
      { state: "WAITING" }, outsiderCookie),
      { params: Promise.resolve({ id: record.id, lineId: record.lines[0]!.id }) });
    expect(denied.status).toBe(403);
  });

  it("writes a manual assignment marker for named STAGED completion and preserves it on rederive", async () => {
    const item = await makeCase("14");
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    // STAGED accepts any eligible worker as an explicit manual assignment.
    const completed = await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED", retrieverUserId: troubleshooterId }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(completed.status).toBe(201);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ replenishmentState: "COMPLETED", retrievalResponsibleUserId: troubleshooterId, retrievalState: "PENDING" });
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.some((event) => event.eventType === "RETRIEVAL_ASSIGNED"
      && eventDetailField(event, "source") === "MANUAL_RETRIEVAL_ASSIGNMENT")).toBe(true);
  });

  it("lists OPEN and CHECKING completed markers in the retrieval queue", async () => {
    const openItem = await makeCase("15");
    expect((await replenishmentRoute(request(`/api/cases/${openItem.caseId}/lines/${openItem.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: openItem.caseId, lineId: openItem.lineId }) })).status).toBe(201);
    const checkingItem = await makeCase("16");
    expect((await claimRoute(request(`/api/checks/${checkingItem.taskId}/claim`, "POST", undefined, troubleshooterCookie),
      { params: Promise.resolve({ id: checkingItem.taskId }) })).status).toBe(200);
    const added = await addLineRoute(request(`/api/cases/${checkingItem.caseId}/lines`, "POST",
      { location: "02.bb.9", sku: "sku-second", quantity: 1 }, pickerCookie),
      { params: Promise.resolve({ id: checkingItem.caseId }) });
    expect(added.status).toBe(201);
    // The first line is CHECKING; replenishment completion still materializes the obligation.
    expect(addedLineBody.parse(await added.json()).line.id.length).toBeGreaterThan(0);
    const [firstLine] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, checkingItem.lineId));
    expect(firstLine!.state).toBe("CHECKING");
    expect((await replenishmentRoute(request(`/api/cases/${checkingItem.caseId}/lines/${checkingItem.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: checkingItem.caseId, lineId: checkingItem.lineId }) })).status).toBe(201);
    const queue = await retrievalsRoute(request("/api/retrievals", "GET", undefined, pickerCookie));
    expect(queue.status).toBe(200);
    const body = retrievalQueueBody.parse(await queue.json());
    expect(body.retrievals.some((entry) => entry.lineId === openItem.lineId && entry.replenishmentState === "COMPLETED")).toBe(true);
    expect(body.retrievals.some((entry) => entry.lineId === checkingItem.lineId && entry.replenishmentState === "COMPLETED")).toBe(true);
  });

  it("fails, retries, and succeeds a replenished retrieval nonconclusively without closing the guard early", async () => {
    const item = await makeCase("17");
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(201);
    // FAILED keeps the main state unchanged for replenished lines and stays retryable.
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST",
      { result: "FAILED" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
    const [failed] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(failed).toMatchObject({ state: "OPEN", retrievalState: "FAILED", replenishmentState: "COMPLETED" });
    // FAILED reconciles nothing: the outstanding task stays live and no OTHER event exists.
    const [liveTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, item.lineId));
    expect(liveTask).toMatchObject({ status: "AVAILABLE", completionCode: null });
    const failedEvents = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(failedEvents.some((event) => event.eventType === "CHECK_COMPLETED")).toBe(false);
    // Retrieval queue still carries the failed obligation.
    const queue = await retrievalsRoute(request("/api/retrievals", "GET", undefined, pickerCookie));
    expect(queue.status).toBe(200);
    expect(retrievalQueueBody.parse(await queue.json()).retrievals.some((entry) => entry.lineId === item.lineId)).toBe(true);
    // Success reconciles the outstanding check task nonconclusively and resolves the line.
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST",
      { result: "RETRIEVED" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
    const [resolved] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(resolved).toMatchObject({ state: "RESOLVED", retrievalState: "RETRIEVED" });
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, item.lineId));
    expect(task).toMatchObject({ status: "COMPLETED", completionCode: "OTHER" });
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.some((event) => event.eventType === "CHECK_COMPLETED"
      && eventDetailField(event, "code") === "OTHER"
      && eventDetailField(event, "source") === "REPLENISHMENT_RETRIEVAL")).toBe(true);
    expect(events.some((event) => event.eventType === "RETRIEVAL_CONFIRMED")).toBe(true);
    // Close guard: a second confirm is rejected; completed stock-finding history is untouched.
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST",
      { result: "RETRIEVED" }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(409);
  });

  it("rejects stale check mutations while the obligation is pending and hides the line from queues", async () => {
    const item = await makeCase("18");
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(201);
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, troubleshooterCookie),
      { params: Promise.resolve({ id: item.taskId }) })).status).toBe(409);
    expect((await assignCheckRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: troubleshooterId }, leaderCookie),
      { params: Promise.resolve({ id: item.taskId }) })).status).toBe(409);
    // Claimed-task completion is blocked too, and a stale request inserts nothing.
    expect((await completeCheckRoute(request(`/api/checks/${item.taskId}/complete`, "POST",
      { code: "OTHER" }, troubleshooterCookie),
      { params: Promise.resolve({ id: item.taskId }) })).status).toBe(409);
    expect((await requestCheckRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/checks`, "POST", undefined, leaderCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(409);
    const tasksAfter = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, item.lineId));
    expect(tasksAfter).toHaveLength(1);
    const queue = await listChecksRoute(request("/api/checks?scope=available", "GET", undefined, assistantCookie));
    expect(queue.status).toBe(200);
    expect(checkQueueBody.parse(await queue.json()).items.some((entry) => entry.id === item.taskId)).toBe(false);
  });

  it("supports the directory contract: gated, eligible, paginated, and phase-filtered", async () => {
    const forbidden = await directoryRoute(request("/api/users/directory", "GET", undefined, pickerCookie));
    expect(forbidden.status).toBe(403);
    const item = await makeCase("19");
    const deniedContext = await directoryRoute(request(`/api/users/directory?caseId=${item.caseId}`, "GET", undefined, pickerCookie));
    expect(deniedContext.status).toBe(403);
    const listed = await directoryRoute(request(`/api/users/directory?caseId=${item.caseId}&lineId=${item.lineId}`, "GET", undefined, assistantCookie));
    expect(listed.status).toBe(200);
    const body = directoryBody.parse(await listed.json());
    // PICKING context lists only valid completion candidates: the eligible picker (no checker origin here).
    expect(body.users.some((entry) => entry.id === pickerId)).toBe(true);
    expect(body.users.every((entry) => entry.role !== "ADMIN" && entry.role !== "MANAGER")).toBe(true);
    expect(body.users.some((entry) => entry.id === leaderId)).toBe(false);
  });

  it("derives eligible phase owners for state-only completion without fake assignment", async () => {
    const item = await makeCase("20");
    // State-only COMPLETED derives the eligible picker in PICKING.
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(201);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line!.retrievalResponsibleUserId).toBe(pickerId);
  });

  it("reuses an existing WAITING named owner when still valid", async () => {
    const item = await makeCase("21");
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "WAITING", note: "waiting on inbound", retrieverUserId: pickerId }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(201);
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, assistantCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(201);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ replenishmentState: "COMPLETED", retrievalState: "PENDING", retrievalResponsibleUserId: pickerId });
  });

  it("fails state-only STAGED completion clearly when no eligible owner exists", async () => {
    const item = await makeCase("22");
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie),
      { params: Promise.resolve({ id: item.caseId }) })).status).toBe(200);
    // The resolver is the picker (never an implicit staged owner) and no
    // checker exists: state-only completion must fail rather than create an
    // unowned obligation.
    expect((await replenishmentRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/replenishment`, "POST",
      { state: "COMPLETED" }, leaderCookie),
      { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(409);
    const [untouched] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(untouched!.replenishmentState).toBe("NONE");
  });
});
