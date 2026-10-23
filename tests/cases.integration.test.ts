import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, caseEvents, checkTasks, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { GET as getPickerCases } from "../src/app/api/picker/cases/route";
import { GET as getCase } from "../src/app/api/cases/[id]/route";
import { POST as addLine } from "../src/app/api/cases/[id]/lines/route";
import { GET as listCases, POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as lookup } from "../src/app/api/cases/lookup/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const firstLine = { location: " 00.qa.0 ", sku: " case-seed ", quantity: 1 };

describeDatabase("Phase 2 case workflow against PostgreSQL", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const runOrder = Date.now().toString();
  const userIds: string[] = [];
  const caseIds: string[] = [];
  let pickerCookie = "";
  let otherPickerCookie = "";
  let leaderCookie = "";
  let pickerId = "";

  async function makeUser(role: Role, suffix: string, permissions = defaultPermissions(role)) {
    const [user] = await getDb().insert(users).values({ identifier: `case-test-${runId}-${suffix}`, displayName: `Case ${suffix}`, pinHash: await hashPin("123456"), role, permissions }).returning();
    userIds.push(user!.id);
    return user!;
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const picker = await makeUser("PICKER", "picker");
    const other = await makeUser("PICKER", "other-picker");
    const leader = await makeUser("TEAM_LEADER", "leader");
    pickerId = picker.id;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    otherPickerCookie = (await createSession(other.id)).cookie.split(";")[0]!;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
  });

  afterAll(async () => {
    if (caseIds.length) {
      await getDb().delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      const lineRows = await getDb().select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      if (lineRows.length) await getDb().delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineRows.map((row) => row.id)));
      await getDb().delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await getDb().delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (userIds.length) {
      await getDb().delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await getDb().delete(sessions).where(inArray(sessions.userId, userIds));
      await getDb().delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("stores canonical typed locations and applies duplicate checks to the canonical pair", async () => {
    const orderNumber = `99${runOrder}`;
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber, firstLine: { location: "3aa1", sku: " mixed-case ", quantity: 1 },
    }, pickerCookie));
    expect(response.status).toBe(201);
    const created = (await response.json()).case as { id: string; lines: Array<{ location: string; sku: string }> };
    caseIds.push(created.id);
    expect(created.lines[0]).toMatchObject({ location: "03.AA.1", sku: "MIXED-CASE" });
    const duplicate = await addLine(request(`/api/cases/${created.id}/lines`, "POST", {
      location: "03.AA.1", sku: "mixed-case", quantity: 1,
    }, pickerCookie), { params: Promise.resolve({ id: created.id }) });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("DUPLICATE_LINE");
    const events = await getDb().select().from(caseEvents).where(and(eq(caseEvents.caseId, created.id), eq(caseEvents.eventType, "SHORT_PICK_LINE_ADDED")));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ location: "03.AA.1", sku: "MIXED-CASE" });
  });

  it("requires digits-only order identifiers and preserves leading zeroes", async () => {
    expect((await lookup(request("/api/cases/lookup", "POST", { orderNumber: " 000341151 " }, pickerCookie))).status).toBe(200);
    for (const orderNumber of ["NLVW341151", "34 1151", "341151.0", ""]) {
      const response = await lookup(request("/api/cases/lookup", "POST", { orderNumber }, pickerCookie));
      expect(response.status).toBe(400);
    }
  });

  it("rechecks historical IDs and serializes concurrent order creation", async () => {
    const orderNumber = `8${runOrder}`;
    const emptyCase = await createCaseRoute(request("/api/cases", "POST", { orderNumber, confirmedHistoricalCaseIds: [] }, pickerCookie));
    expect(emptyCase.status).toBe(400);
    expect(await getDb().select().from(orderCases).where(eq(orderCases.orderNumber, orderNumber))).toHaveLength(0);
    const firstResponse = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()).case as { id: string; lines: Array<{ location: string; sku: string; quantity: number }> };
    expect(first.lines).toMatchObject([{ location: "00.QA.0", sku: "CASE-SEED", quantity: 1 }]);
    caseIds.push(first.id);

    const staleConfirmation = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    expect(staleConfirmation.status).toBe(409);
    expect((await staleConfirmation.json()).code).toBe("OPEN_CASE_EXISTS");

    // A closed previous occurrence produces a warning; the creation request must confirm its exact case ID set.
    await getDb().update(orderCases).set({ phase: "CLOSED", resolvedAt: new Date() }).where(eq(orderCases.id, first.id));
    const historyLookup = await lookup(request("/api/cases/lookup", "POST", { orderNumber }, pickerCookie));
    const history = await historyLookup.json();
    expect(history.kind).toBe("HISTORY");
    expect(history.history).toHaveLength(1);
    const wrongHistory = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [randomUUID()] }, pickerCookie));
    expect(wrongHistory.status).toBe(409);
    expect((await wrongHistory.json()).code).toBe("HISTORICAL_CONFIRMATION_REQUIRED");
    const confirmed = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [first.id] }, pickerCookie));
    expect(confirmed.status).toBe(201);
    const confirmedCase = (await confirmed.json()).case as { id: string };
    caseIds.push(confirmedCase.id);
    expect((await getDb().select().from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), eq(orderCases.phase, "CLOSED")))).map((row) => row.id)).toContain(first.id);
    expect((await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, confirmedCase.id))).map((event) => event.eventType)).toContain("CASE_CREATED");

    const secondOrder = `7${runOrder}`;
    const requests = await Promise.all(Array.from({ length: 2 }, () => createCaseRoute(request("/api/cases", "POST", { orderNumber: secondOrder, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie))));
    expect(requests.map((response) => response.status).sort()).toEqual([201, 409]);
    const open = await lookup(request("/api/cases/lookup", "POST", { orderNumber: secondOrder }, pickerCookie));
    expect((await open.json()).kind).toBe("OPEN");
    const createdResponse = requests.find((response) => response.status === 201)!;
    caseIds.push(((await createdResponse.json()).case as { id: string }).id);
    expect((await getDb().select().from(orderCases).where(and(eq(orderCases.orderNumber, secondOrder), eq(orderCases.phase, "PICKING")))).length).toBe(1);
  });

  it("normalizes lines, blocks duplicates, requires an authorized override, and records transactional events", async () => {
    const orderNumber = `6${runOrder}`;
    const response = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    const record = (await response.json()).case as { id: string };
    caseIds.push(record.id);
    expect(response.status).toBe(201);

    const first = await addLine(request(`/api/cases/${record.id}/lines`, "POST", { location: " 03.aa.1 ", sku: " ff405d-42 ", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(first.status).toBe(201);
    const reportedLine = (await first.json()).line as { id: string; location: string; sku: string; quantity: number };
    expect(reportedLine).toMatchObject({ location: "03.AA.1", sku: "FF405D-42", quantity: 1 });

    const duplicate = await addLine(request(`/api/cases/${record.id}/lines`, "POST", { location: "03.AA.1", sku: "FF405D-42", quantity: 4 }, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "DUPLICATE_LINE", line: { id: reportedLine.id, location: "03.AA.1", sku: "FF405D-42", quantity: 1 } });

    const unauthorizedOverride = await addLine(request(`/api/cases/${record.id}/lines`, "POST", { location: "03.AA.1", sku: "FF405D-42", quantity: 1, confirmDuplicate: true }, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(unauthorizedOverride.status).toBe(403);
    expect((await unauthorizedOverride.json()).code).toBe("DUPLICATE_OVERRIDE_FORBIDDEN");

    const override = await addLine(request(`/api/cases/${record.id}/lines`, "POST", { location: "03.AA.1", sku: "FF405D-42", quantity: 2, confirmDuplicate: true }, leaderCookie), { params: Promise.resolve({ id: record.id }) });
    expect(override.status).toBe(201);
    const rows = await getDb().select().from(shortPickLines).where(eq(shortPickLines.caseId, record.id));
    expect(rows).toHaveLength(3);
    expect((await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, record.id))).map((event) => event.eventType)).toEqual(expect.arrayContaining(["CASE_CREATED", "SHORT_PICK_LINE_ADDED", "SHORT_PICK_LINE_DUPLICATE_OVERRIDE_USED"]));
  });

  it("limits picker case lists and detail access to assigned cases", async () => {
    const orderNumber = `5${runOrder}`;
    const response = await createCaseRoute(request("/api/cases", "POST", { orderNumber, firstLine, confirmedHistoricalCaseIds: [] }, pickerCookie));
    const record = (await response.json()).case as { id: string };
    caseIds.push(record.id);
    const mine = await getPickerCases(request("/api/picker/cases", "GET", undefined, pickerCookie));
    expect((await mine.json()).cases.some((item: { id: string }) => item.id === record.id)).toBe(true);
    const otherMine = await getPickerCases(request("/api/picker/cases", "GET", undefined, otherPickerCookie));
    expect((await otherMine.json()).cases.some((item: { id: string }) => item.id === record.id)).toBe(false);
    const forbidden = await getCase(request(`/api/cases/${record.id}`, "GET", undefined, otherPickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(forbidden.status).toBe(403);
    const all = await listCases(request("/api/cases?scope=active", "GET", undefined, leaderCookie));
    expect((await all.json()).cases.some((item: { id: string }) => item.id === record.id)).toBe(true);

    const ownDetail = await getCase(request(`/api/cases/${record.id}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(ownDetail.status).toBe(200);
    await getDb().update(users).set({ permissions: [] }).where(eq(users.id, pickerId));
    const deniedDetail = await getCase(request(`/api/cases/${record.id}`, "GET", undefined, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(deniedDetail.status).toBe(403);
    const deniedList = await getPickerCases(request("/api/picker/cases", "GET", undefined, pickerCookie));
    expect(deniedList.status).toBe(403);
    const mutation = await addLine(request(`/api/cases/${record.id}/lines`, "POST", { location: "02.AA.3", sku: "OTHER-SKU", quantity: 1 }, pickerCookie), { params: Promise.resolve({ id: record.id }) });
    expect(mutation.status).toBe(403);
  });
});
