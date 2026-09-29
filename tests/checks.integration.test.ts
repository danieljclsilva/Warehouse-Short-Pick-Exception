import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
import { getCurrentConfiguration } from "../src/server/configuration";
import { PATCH as patchConfigurationRoute } from "../src/app/api/admin/configuration/route";

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
  let originalCheckCapacity: number | null = 1;

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
    originalCheckCapacity = (await getCurrentConfiguration()).values.MAX_SIMULTANEOUS_CHECKS_PER_CASE;
    const resetCapacity = await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: 1 }, leaderCookie));
    expect(resetCapacity.status).toBe(200);
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
    if (leaderCookie) {
      const currentCapacity = (await getCurrentConfiguration()).values.MAX_SIMULTANEOUS_CHECKS_PER_CASE;
      if (currentCapacity !== originalCheckCapacity) {
        await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: originalCheckCapacity }, leaderCookie));
      }
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
    // Capacity is operational configuration: an open case created under an older snapshot follows the current cap.
    expect((await claimRoute(request(`/api/checks/${pendingTask}/claim`, "POST", undefined, pendingCookie), { params: Promise.resolve({ id: pendingTask }) })).status).toBe(200);

    // A case created after the change receives capacity two and can claim both lines.
    const newCase = await makeCase("22");
    const newLineResponse = await addLineRoute(request(`/api/cases/${newCase.caseId}/lines`, "POST", { location: "02.bb.3", sku: "sku-new", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: newCase.caseId }) });
    expect(newLineResponse.status).toBe(201);
    const newLine = (await newLineResponse.json()).line as { id: string };
    const [newTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, newLine.id));
    expect((await claimRoute(request(`/api/checks/${newCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: newCase.taskId }) })).status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${newTask!.id}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: newTask!.id }) })).status).toBe(200);
    expect((await getDb().select().from(shortPickLines).where(eq(shortPickLines.caseId, newCase.caseId))).map((line) => line.state)).toEqual(["CHECKING", "CHECKING"]);

    const third = await addLineRoute(request(`/api/cases/${newCase.caseId}/lines`, "POST", { location: "03.cc.3", sku: "sku-c", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: newCase.caseId }) });
    expect(third.status).toBe(201);
    const thirdLine = (await third.json()).line as { id: string };
    const [thirdTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, thirdLine.id));
    expect((await claimRoute(request(`/api/checks/${thirdTask!.id}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: thirdTask!.id }) })).status).toBe(409);
    expect((await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: null }, leaderCookie))).status).toBe(200);
    // Current operational configuration is read at claim time, including for cases created under older snapshots.
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
  it("returns every available check through cursor pages with a total", async () => {
    for (let index = 0; index < 105; index += 1) await makeCase(String(index).padStart(3, "0"));
    // Same-millisecond page-boundary fixture: four rows straddling the page-1 cursor share one
    // millisecond with distinct microseconds. A cursor keeps millisecond ISO precision, so the
    // keyset ordering MUST truncate to the same precision or rows between the truncated cursor
    // and the full-precision cursor row are skipped.
    const boundary = await getDb().select({ id: checkTasks.id, createdAt: checkTasks.createdAt }).from(checkTasks)
      .innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
      .innerJoin(orderCases, eq(shortPickLines.caseId, orderCases.id))
      .where(and(eq(checkTasks.status, "AVAILABLE"), eq(shortPickLines.state, "OPEN"), ne(orderCases.phase, "CLOSED")))
      .orderBy(desc(sql`date_trunc('milliseconds', ${checkTasks.createdAt})`), desc(checkTasks.id)).limit(60);
    expect(boundary).toHaveLength(60);
    const anchor = new Date(Math.floor(new Date(boundary[49]!.createdAt!).getTime())).toISOString();
    const cluster = [boundary[48]!, boundary[49]!, boundary[50]!, boundary[51]!];
    for (const [offset, row] of cluster.entries()) {
      await getDb().update(checkTasks).set({ createdAt: new Date(new Date(anchor).getTime() + offset) }).where(eq(checkTasks.id, row.id));
    }
    const first = await listChecksRoute(request("/api/checks?scope=available&limit=50", "GET", undefined, assistantCookie));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { items: Array<{ id: string }>; nextCursor: string | null; total: number; checks: Array<{ id: string }> };
    expect(firstBody.items).toHaveLength(50);
    expect(firstBody.checks).toHaveLength(50);
    expect(firstBody.total).toBeGreaterThanOrEqual(105);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const seen = firstBody.items.map((item) => item.id);
    let cursor = firstBody.nextCursor;
    let pages = 1;
    while (cursor) {
      const response = await listChecksRoute(request(`/api/checks?scope=available&limit=50&cursor=${encodeURIComponent(cursor)}`, "GET", undefined, assistantCookie));
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ id: string }>; nextCursor: string | null; total: number };
      expect(body.total).toBe(firstBody.total);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages += 1;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(firstBody.total);
    expect(new Set(seen).size).toBe(firstBody.total);
  });
  it("completes FOUND_AT_ORIGINAL with COMPLETE_CHECK only and routes retrieval", async () => {
    const item = await makeCase("991");
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const completed = await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND_AT_ORIGINAL" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) });
    expect(completed.status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ state: "FOUND", discoveredLocation: null, retrievalState: "PENDING", retrievalResponsibleUserId: pickerId });
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.caseId));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["CHECK_COMPLETED", "FOUND_AT_ORIGINAL_VERIFIED", "RETRIEVAL_ASSIGNED"]));
    const logs = await getDb().select().from(auditLog).where(and(eq(auditLog.actorUserId, checkerOneId), eq(auditLog.action, "CHECK_COMPLETED")));
    expect(logs.some((log) => log.details.code === "FOUND_AT_ORIGINAL")).toBe(true);
  });
  it("completes under the case snapshot while claims follow the current capacity", async () => {
    const current = await getCurrentConfiguration();
    const withFao = current.values.ALLOWED_RESOLUTION_CODES.includes("FOUND_AT_ORIGINAL")
      ? [...current.values.ALLOWED_RESOLUTION_CODES]
      : [...current.values.ALLOWED_RESOLUTION_CODES, "FOUND_AT_ORIGINAL" as const];
    const withoutFao = withFao.filter((code) => code !== "FOUND_AT_ORIGINAL");
    expect(withoutFao.length).toBeGreaterThan(0);
    const base = await getCurrentConfiguration();
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: base.version, values: { ALLOWED_RESOLUTION_CODES: withFao, MAX_SIMULTANEOUS_CHECKS_PER_CASE: 2 } }, leaderCookie))).status).toBe(200);
    // Old case pinned to a snapshot allowing FOUND_AT_ORIGINAL; current capacity 2 governs claims.
    const oldCase = await makeCase("9910");
    const oldSecond = await addLineRoute(request(`/api/cases/${oldCase.caseId}/lines`, "POST", { location: "02.snap.1", sku: "sku-snap-1", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: oldCase.caseId }) });
    expect(oldSecond.status).toBe(201);
    const oldSecondLine = (await oldSecond.json()).line as { id: string };
    const [oldSecondTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, oldSecondLine.id));
    expect((await claimRoute(request(`/api/checks/${oldCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: oldCase.taskId }) })).status).toBe(200);
    expect((await claimRoute(request(`/api/checks/${oldSecondTask!.id}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: oldSecondTask!.id }) })).status).toBe(200);
    // Narrow the current configuration: forbid FOUND_AT_ORIGINAL and cap capacity at 1.
    const narrowedBase = await getCurrentConfiguration();
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: narrowedBase.version, values: { ALLOWED_RESOLUTION_CODES: withoutFao, MAX_SIMULTANEOUS_CHECKS_PER_CASE: 1 } }, leaderCookie))).status).toBe(200);
    // Snapshot still governs completion: the old case completes FOUND_AT_ORIGINAL though current forbids it.
    expect((await completeRoute(request(`/api/checks/${oldCase.taskId}/complete`, "POST", { code: "FOUND_AT_ORIGINAL" }, checkerOneCookie), { params: Promise.resolve({ id: oldCase.taskId }) })).status).toBe(200);
    // Current capacity governs claims on the old snapshot case: one active check remains, cap is 1.
    const oldThird = await addLineRoute(request(`/api/cases/${oldCase.caseId}/lines`, "POST", { location: "03.snap.1", sku: "sku-snap-2", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: oldCase.caseId }) });
    expect(oldThird.status).toBe(201);
    const oldThirdLine = (await oldThird.json()).line as { id: string };
    const [oldThirdTask] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, oldThirdLine.id));
    expect((await claimRoute(request(`/api/checks/${oldThirdTask!.id}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: oldThirdTask!.id }) })).status).toBe(409);
    // A case created under the narrowed snapshot is forbidden from completing FOUND_AT_ORIGINAL.
    const newCase = await makeCase("9911");
    expect((await claimRoute(request(`/api/checks/${newCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: newCase.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${newCase.taskId}/complete`, "POST", { code: "FOUND_AT_ORIGINAL" }, checkerOneCookie), { params: Promise.resolve({ id: newCase.taskId }) })).status).toBe(400);
    const restoreBase = await getCurrentConfiguration();
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: restoreBase.version, values: { ALLOWED_RESOLUTION_CODES: current.values.ALLOWED_RESOLUTION_CODES, MAX_SIMULTANEOUS_CHECKS_PER_CASE: current.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE } }, leaderCookie))).status).toBe(200);
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
