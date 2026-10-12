import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { caseEvents, checkTasks, configurationVersions, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { GET as analyticsRoute } from "../src/app/api/analytics/route";
import { GET as csvRoute } from "../src/app/api/analytics/export/csv/route";
import { parseAnalyticsFilters } from "../src/server/analytics";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method = "GET", cookie?: string) => new Request(`http://localhost${path}`, { method, headers: cookie ? { cookie } : undefined });

describeDatabase("Phase 7 analytics and CSV against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  const caseIds: string[] = [];
  const lineIds: string[] = [];
  let leaderCookie = "";
  let pickerCookie = "";
  let analyticsOrder = "";
  let analyticsConfigurationVersion = 0;
  let leaderId = "";
  let pickerId = "";

  async function makeUser(role: Role, label: string) {
    const [user] = await getDb().insert(users).values({ identifier: `analytics-${suffix}-${label}`, displayName: `Analytics ${label}`, pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  beforeAll(async () => {
    const config = await getDb().select().from(configurationVersions).orderBy(configurationVersions.version).limit(1);
    expect(config[0]).toBeDefined();
    const leader = await makeUser("TEAM_LEADER", "leader");
    const picker = await makeUser("PICKER", "picker");
    leaderId = leader.id;
    pickerId = picker.id;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    pickerCookie = (await createSession(picker.id)).cookie.split(";")[0]!;
    // Fixed business time: Monday 2026-10-12 06:30 UTC = 08:30 CEST, inside
    // Mon-Fri 08:00-17:00, so every event offset below lands in working hours
    // and working-clock medians equal wall-clock gaps (300/480/1020/1080s).
    const now = new Date("2026-10-12T06:30:00Z").getTime();
    const orderNumber = `970${now}`;
    analyticsOrder = orderNumber;
    analyticsConfigurationVersion = config[0]!.version;
    const createdAt = new Date(now - 20 * 60_000);
    for (let index = 0; index < 2; index += 1) {
      const [record] = await getDb().insert(orderCases).values({ orderNumber, phase: "CLOSED", physicalState: "SHORT_PICK_HOLD", source: "TL_MANUAL", createdByUserId: leader.id, pickingUserId: picker.id, configurationVersionId: config[0]!.id, createdAt, resolvedAt: new Date(now - 2 * 60_000), updatedAt: new Date(now - 2 * 60_000) }).returning();
      caseIds.push(record!.id);
      const [line] = await getDb().insert(shortPickLines).values({ caseId: record!.id, originalLocation: index ? "B-01" : "=FORMULA", sku: index ? "SKU-SECOND" : "=SKU-FORMULA", missingQuantity: index + 1, reportedByUserId: picker.id, reportedAt: createdAt, state: "RESOLVED", retrievalState: "RETRIEVED", retrievedByUserId: picker.id, retrievedAt: new Date(now - 3 * 60_000), resolvedAt: new Date(now - 2 * 60_000), resolutionCode: index ? "FOUND" : null }).returning();
      lineIds.push(line!.id);
      await getDb().insert(checkTasks).values({ shortPickLineId: line!.id, status: "COMPLETED", claimedByUserId: leader.id, claimedAt: new Date(now - 15 * 60_000), completedAt: new Date(now - 10 * 60_000), completionCode: "FOUND" });
      await getDb().insert(caseEvents).values([
        { caseId: record!.id, actorUserId: leader.id, eventType: "CASE_CREATED", createdAt },
        { caseId: record!.id, shortPickLineId: line!.id, actorUserId: leader.id, eventType: "CHECK_CLAIMED", createdAt: new Date(now - 15 * 60_000) },
        { caseId: record!.id, shortPickLineId: line!.id, actorUserId: leader.id, eventType: "NEW_LOCATION_REPORTED", createdAt: new Date(now - 12 * 60_000) },
        { caseId: record!.id, shortPickLineId: line!.id, actorUserId: picker.id, eventType: "RETRIEVAL_CONFIRMED", createdAt: new Date(now - 3 * 60_000) },
        { caseId: record!.id, actorUserId: leader.id, eventType: "CASE_CLOSED", createdAt: new Date(now - 2 * 60_000) },
      ]);
    }
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
    if (lineIds.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
    if (lineIds.length) await db.delete(shortPickLines).where(inArray(shortPickLines.id, lineIds));
    if (caseIds.length) await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    if (userIds.length) await db.delete(sessions).where(inArray(sessions.userId, userIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await closeDb();
  });

  it("returns filtered structured metrics, duplicate order history, and event-derived medians", async () => {
    const from = new Date(new Date("2026-10-12T06:30:00Z").getTime() - 60 * 60_000).toISOString();
    const to = new Date(new Date("2026-10-12T06:30:00Z").getTime() + 60 * 60_000).toISOString();
    const response = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&source=TL_MANUAL`, "GET", leaderCookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kpis).toMatchObject({ totalCases: 2, totalLines: 2, foundDuringCheck: 2, retrieved: 2, repeatedOrderNumbers: 1 });
    expect(body.kpis.medianReportToCheckClaimedSeconds).toBe(300);
    expect(body.kpis.medianReportToLocationFoundSeconds).toBe(480);
    expect(body.kpis.medianReportToRetrievalSeconds).toBe(1020);
    expect(body.kpis.medianReportToResolutionSeconds).toBe(1080);
    expect(body.duplicates.orders[0]).toMatchObject({ orderNumber: expect.stringMatching(/^970/), occurrences: 2 });
    expect(body.rows.cases).toHaveLength(2);

    const foundResolution = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&resolution=FOUND`, "GET", leaderCookie));
    expect(foundResolution.status).toBe(200);
    expect((await foundResolution.json()).kpis).toMatchObject({ totalCases: 2, totalLines: 2 });
    expect((await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&resolution=BOGUS`, "GET", leaderCookie))).status).toBe(400);

    const focused = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&orderNumber=${analyticsOrder}&location=%3DFORMULA&phase=CLOSED&configVersion=${analyticsConfigurationVersion}`, "GET", leaderCookie));
    expect(focused.status).toBe(200);
    expect((await focused.json()).kpis).toMatchObject({ totalCases: 1, totalLines: 1 });
    const mismatchedLineFilters = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&orderNumber=${analyticsOrder}&location=%3DFORMULA&sku=SKU-SECOND`, "GET", leaderCookie));
    expect(mismatchedLineFilters.status).toBe(200);
    expect((await mismatchedLineFilters.json()).kpis).toMatchObject({ totalCases: 0, totalLines: 0 });
  });

  it("enforces view/export permissions and protects spreadsheet formula cells", async () => {
    const query = `from=${encodeURIComponent(new Date(new Date("2026-10-12T06:30:00Z").getTime() - 60 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(new Date("2026-10-12T06:30:00Z").getTime() + 60 * 60_000).toISOString())}`;
    expect((await analyticsRoute(request(`/api/analytics?${query}`, "GET", pickerCookie))).status).toBe(403);
    expect((await csvRoute(request(`/api/analytics/export/csv?dataset=line&${query}`, "GET", pickerCookie))).status).toBe(403);
    const response = await csvRoute(request(`/api/analytics/export/csv?dataset=line&${query}`, "GET", leaderCookie));
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("line_id,case_id,order_number");
    expect(csv).toContain("'=FORMULA");
    expect(csv).toContain("'=SKU-FORMULA");
    const events = await csvRoute(request(`/api/analytics/export/csv?dataset=event&${query}`, "GET", leaderCookie));
    expect(events.status).toBe(200);
    expect(await events.text()).toContain("event_id,case_id,line_id");

    const eventWindow = `from=${encodeURIComponent(new Date(new Date("2026-10-12T06:30:00Z").getTime() - 4 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(new Date("2026-10-12T06:30:00Z").getTime() + 60_000).toISOString())}`;
    const recentEvents = await csvRoute(request(`/api/analytics/export/csv?dataset=event&${eventWindow}`, "GET", leaderCookie));
    const recentCsv = await recentEvents.text();
    expect(recentEvents.status).toBe(200);
    expect(recentCsv).toContain("RETRIEVAL_CONFIRMED");
    expect(recentCsv).not.toContain("CHECK_CLAIMED");

    const selectedDate = parseAnalyticsFilters(new URLSearchParams("from=2026-03-01&to=2026-03-01"));
    expect(selectedDate.to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(selectedDate.toExclusive?.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  it("marks row-derived metrics partial when the case cap is reached while totals stay exact", async () => {
    const now = new Date();
    const extraCases = Array.from({ length: 5_001 }, (_, index) => ({
      orderNumber: `971${Date.now()}${String(index).padStart(5, "0")}`,
      phase: "CLOSED" as const,
      physicalState: "SHORT_PICK_HOLD" as const,
      source: "TL_MANUAL" as const,
      createdByUserId: leaderId,
      pickingUserId: pickerId,
      configurationVersionId: undefined,
      createdAt: now,
      updatedAt: now,
      resolvedAt: now,
    }));
    // Fill the snapshot ID once, keeping the insert itself batched and bounded.
    const [configuration] = await getDb().select().from(configurationVersions).orderBy(configurationVersions.version).limit(1);
    for (let offset = 0; offset < extraCases.length; offset += 500) {
      const batch = extraCases.slice(offset, offset + 500).map((row) => ({ ...row, configurationVersionId: configuration!.id }));
      const inserted = await getDb().insert(orderCases).values(batch).returning({ id: orderCases.id });
      caseIds.push(...inserted.map((row) => row.id));
    }
    const from = new Date(now.getTime() - 60_000).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();
    const response = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, "GET", leaderCookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kpis.totalCases).toBe(5_001);
    expect(body.kpis.metricsArePartial).toBe(true);
    expect(body.kpis.partialMetrics).toEqual(expect.arrayContaining(["casesByPeriod", "manualCases", "casesByConfigurationVersion"]));
    expect(body.limits).toMatchObject({ casesTruncated: true, derivedMetricsTruncated: true });
    expect(body.rows.cases).toHaveLength(5_000);
  });
});
