import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { appSettings, auditLog, caseEvents, caseMessages, checkTasks, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { PATCH as assignRoute } from "../src/app/api/checks/[id]/assign/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { POST as retrieveRoute } from "../src/app/api/cases/[id]/lines/[lineId]/retrieve/route";
import { POST as requestCheckRoute } from "../src/app/api/cases/[id]/lines/[lineId]/checks/route";
import { PUT as setCapacityRoute } from "../src/app/api/admin/check-capacity/route";
import { GET as listChecksRoute } from "../src/app/api/checks/route";
import { GET as caseDetailRoute } from "../src/app/api/cases/[id]/route";
import { POST as messageRoute } from "../src/app/api/cases/[id]/messages/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Phase 3 checking, responsibility and staging against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerId = "";
  let checkerOneId = "";
  let checkerTwoId = "";
  let pickerCookie = "";
  let checkerOneCookie = "";
  let checkerTwoCookie = "";
  let leaderCookie = "";
  let assistantCookie = "";

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `check-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(orderSuffix: string) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `9${Date.now()}${orderSuffix}`, confirmedHistoricalCaseIds: [],
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
    await getDb().delete(appSettings).where(eq(appSettings.key, "MAX_SIMULTANEOUS_CHECKS_PER_CASE"));
    const picker = await makeUser("PICKER", "picker");
    const checkerOne = await makeUser("TROUBLESHOOTER", "checker-one");
    const checkerTwo = await makeUser("TROUBLESHOOTER", "checker-two");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const assistant = await makeUser("ASSISTANT", "assistant");
    pickerId = picker.id;
    checkerOneId = checkerOne.id;
    checkerTwoId = checkerTwo.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    checkerOneCookie = (await createSession(checkerOne.id)).cookie.split(";")[0]!;
    checkerTwoCookie = (await createSession(checkerTwo.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    assistantCookie = (await createSession(assistant.id)).cookie.split(";")[0]!;
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
    await getDb().delete(appSettings).where(eq(appSettings.key, "MAX_SIMULTANEOUS_CHECKS_PER_CASE"));
    await closeDb();
  });

  it("allows exactly one worker to claim the same task", async () => {
    const item = await makeCase("1");
    const attempts = await Promise.all([checkerOneCookie, checkerTwoCookie].map((cookie) => claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, cookie), { params: Promise.resolve({ id: item.taskId }) })));
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.id, item.taskId));
    expect(task.status).toBe("CLAIMED");
    expect([checkerOneId, checkerTwoId]).toContain(task.claimedByUserId);
  });

  it("shows a case to its assigned checker without exposing unrelated cases", async () => {
    const item = await makeCase("8");
    const path = `/api/cases/${item.caseId}`;
    expect((await caseDetailRoute(request(path, "GET", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const detail = await caseDetailRoute(request(path, "GET", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(detail.status).toBe(200);
    expect((await detail.json()).case.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.taskId })]));
    expect((await caseDetailRoute(request(path, "GET", undefined, checkerTwoCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
    expect((await messageRoute(request(path + "/messages", "POST", { message: "Checking this line." }, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(201);
    expect((await completeRoute(request("/api/checks/" + item.taskId + "/complete", "POST", { code: "NOT_FOUND" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await caseDetailRoute(request(path, "GET", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
    expect((await messageRoute(request(path + "/messages", "POST", { message: "No longer assigned." }, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
  });

  it("enforces per-case check capacity across distinct lines and allows an authorized configuration change", async () => {
    const item = await makeCase("2");
    const added = await addLineRoute(request(`/api/cases/${item.caseId}/lines`, "POST", { location: "02.bb.2", sku: "sku-b", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(added.status).toBe(201);
    const secondLine = (await added.json()).line as { id: string };
    const [secondTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, secondLine.id));
    const attempts = await Promise.all([
      claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) }),
      claimRoute(request(`/api/checks/${secondTask!.id}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: secondTask!.id }) }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    const denied = await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: 2 }, checkerOneCookie));
    expect(denied.status).toBe(403);
    const changed = await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: 2 }, leaderCookie));
    expect(changed.status).toBe(200);
    const [firstState] = await getDb().select().from(checkTasks).where(eq(checkTasks.id, item.taskId));
    const pendingTask = firstState.status === "AVAILABLE" ? item.taskId : secondTask!.id;
    const pendingCookie = pendingTask === item.taskId ? checkerOneCookie : checkerTwoCookie;
    expect((await claimRoute(request(`/api/checks/${pendingTask}/claim`, "POST", undefined, pendingCookie), { params: Promise.resolve({ id: pendingTask }) })).status).toBe(200);
    expect((await getDb().select().from(shortPickLines).where(eq(shortPickLines.caseId, item.caseId))).map((line) => line.state)).toEqual(["CHECKING", "CHECKING"]);
    const third = await addLineRoute(request(`/api/cases/${item.caseId}/lines`, "POST", { location: "03.cc.3", sku: "sku-c", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) });
    expect(third.status).toBe(201);
    const thirdLine = (await third.json()).line as { id: string };
    const [thirdTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, thirdLine.id));
    expect((await claimRoute(request(`/api/checks/${thirdTask!.id}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: thirdTask!.id }) })).status).toBe(409);
    expect((await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: null }, leaderCookie))).status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${thirdTask!.id}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: thirdTask!.id }) })).status).toBe(200);
  });

  it("keeps assigned checks unclaimable and records failed completion for a later retry", async () => {
    const item = await makeCase("3");
    const assigned = await assignRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerOneId }, leaderCookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(assigned.status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(409);
    const completed = await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "NOT_FOUND" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(completed.status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line.state).toBe("OPEN");
    const retry = await requestCheckRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/checks`, "POST", undefined, leaderCookie), { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(retry.status).toBe(201);
    const active = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, item.lineId));
    expect(active.map((task) => task.status)).toEqual(expect.arrayContaining(["COMPLETED", "AVAILABLE"]));
  });

  it("lets an Assistant view the assignable queue and reassign without transferring case ownership", async () => {
    const item = await makeCase("6");
    const queue = await listChecksRoute(request("/api/checks?scope=available", "GET", undefined, assistantCookie));
    expect(queue.status).toBe(200);
    expect(((await queue.json()).checks as Array<{ id: string }>).some((check) => check.id === item.taskId)).toBe(true);
    expect((await assignRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerOneId }, assistantCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await assignRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerTwoId }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(403);
    expect((await assignRoute(request(`/api/checks/${item.taskId}/assign`, "PATCH", { userId: checkerTwoId }, assistantCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const [record] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(record.pickingUserId).toBe(pickerId);
    expect(line.currentResponsibleUserId).toBe(checkerTwoId);
  });

  it("requires explicit physical staging confirmation", async () => {
    const item = await makeCase("7");
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", {}, pickerCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(400);
    expect((await stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, checkerOneCookie), { params: Promise.resolve({ id: item.caseId }) })).status).toBe(403);
    const [record] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    expect(record.phase).toBe("PICKING");
  });

  it("routes a found location to the active picker and requires separate retrieval", async () => {
    const item = await makeCase("4");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const found = await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: " 05.cc.2 " }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(found.status).toBe(200);
    const [pending] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(pending).toMatchObject({ state: "FOUND", discoveredLocation: "05.CC.2", retrievalState: "PENDING", retrievalResponsibleUserId: pickerId });
    const wrongWorker = await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" }, checkerOneCookie), { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(wrongWorker.status).toBe(403);
    const pickerRetrieval = await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" }, pickerCookie), { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) });
    expect(pickerRetrieval.status).toBe(200);
    const [resolved] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(resolved).toMatchObject({ state: "RESOLVED", retrievalState: "RETRIEVED", retrievedByUserId: pickerId });
    const events = (await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId))).map((event) => event.eventType);
    expect(events).toEqual(expect.arrayContaining(["CHECK_CLAIMED", "CHECK_COMPLETED", "NEW_LOCATION_REPORTED", "RETRIEVAL_ASSIGNED", "RETRIEVAL_CONFIRMED"]));
  });

  it("serializes staging with discovery and routes staged retrieval to the checker", async () => {
    const item = await makeCase("5");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const [found, staged] = await Promise.all([
      completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "BTS-02" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) }),
      stageRoute(request(`/api/cases/${item.caseId}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: item.caseId }) }),
    ]);
    expect(found.status).toBe(200);
    expect(staged.status).toBe(200);
    const [record] = await getDb().select().from(orderCases).where(eq(orderCases.id, item.caseId));
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(record).toMatchObject({ phase: "STAGED", physicalState: "SHORT_PICK_HOLD" });
    expect(line).toMatchObject({ state: "FOUND", retrievalState: "PENDING", retrievalResponsibleUserId: checkerOneId });
    expect((await retrieveRoute(request(`/api/cases/${item.caseId}/lines/${item.lineId}/retrieve`, "POST", { result: "RETRIEVED" }, checkerOneCookie), { params: Promise.resolve({ id: item.caseId, lineId: item.lineId }) })).status).toBe(200);
  });
});
