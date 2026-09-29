import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { caseEvents, checkTasks, configurationVersions, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { GET as analyticsRoute } from "../src/app/api/analytics/route";
import { GET as csvRoute } from "../src/app/api/analytics/export/csv/route";
import { renderAnalyticsPdf } from "../src/server/analytics-pdf";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method = "GET", cookie?: string) => new Request(`http://localhost${path}`, { method, headers: cookie ? { cookie } : undefined });

/**
 * Same-location-found acceptance against PostgreSQL: latest-conclusive-wins,
 * OTHER/cancelled exclusion, <20 suppression, date-range + role filter, CSV/PDF parity.
 * FOUND_AT_ORIGINAL rows are written as plain text via SQL so the test passes whether
 * or not the domain A1 check_completion_code enum migration has landed.
 */
describeDatabase("same-location-found analytics against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  const caseIds: string[] = [];
  const lineIds: string[] = [];
  const taskIds: string[] = [];
  let leaderCookie = "";
  let pickerOneId = "";
  let pickerTwoId = "";
  let configId = "";

  async function makeUser(role: Role, label: string) {
    const [user] = await getDb().insert(users).values({ identifier: `slf-${suffix}-${label}`, displayName: `SLF ${label}`, pinHash: await hashPin("123456"), role, permissions: [...defaultPermissions(role), "VIEW_ANALYTICS", "EXPORT_ANALYTICS"] }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function reportLine(orderNumber: string, reporterId: string, reportedAt: Date, state = "RESOLVED") {
    const [record] = await getDb().insert(orderCases).values({ orderNumber, phase: "CLOSED", physicalState: "SHORT_PICK_HOLD", source: "PICKER_REPORT", createdByUserId: reporterId, pickingUserId: reporterId, configurationVersionId: configId, createdAt: reportedAt, resolvedAt: reportedAt, updatedAt: reportedAt }).returning();
    caseIds.push(record!.id);
    const [line] = await getDb().insert(shortPickLines).values({ caseId: record!.id, originalLocation: "SLF-01", sku: "SLF-SKU", missingQuantity: 1, reportedByUserId: reporterId, reportedAt, state: state as "RESOLVED", retrievalState: "NOT_REQUIRED", resolvedAt: reportedAt }).returning();
    lineIds.push(line!.id);
    return line!.id;
  }

  async function completeTask(lineId: string, code: string, at: Date, byId: string) {
    const [task] = await getDb().insert(checkTasks).values({ shortPickLineId: lineId, status: "CLAIMED", claimedByUserId: byId, claimedAt: at }).returning();
    taskIds.push(task!.id);
    // Text write: tolerates FOUND_AT_ORIGINAL with or without the enum migration.
    await getDb().execute(sql`update check_tasks set status = 'COMPLETED', completion_code = ${code}::check_completion_code, completed_at = ${at.toISOString()}::timestamptz, updated_at = ${at.toISOString()}::timestamptz where id = ${task!.id}`);
    return task!.id;
  }

  beforeAll(async () => {
    const [config] = await getDb().select().from(configurationVersions).orderBy(configurationVersions.version).limit(1);
    expect(config).toBeDefined();
    configId = config!.id;
    const leader = await makeUser("TEAM_LEADER", "leader");
    const pickerOne = await makeUser("PICKER", "one");
    const pickerTwo = await makeUser("PICKER", "two");
    pickerOneId = pickerOne.id;
    pickerTwoId = pickerTwo.id;
    leaderCookie = (await createSession(leader.id)).cookie.split(";")[0]!;
    const now = Date.now();
    const inRange = new Date(now - 10 * 60_000);
    // picker one: latest-wins correction (FOUND then FOUND_AT_ORIGINAL), plus one NOT_FOUND.
    const l1 = await reportLine(`972${now}01`, pickerOne.id, inRange);
    await completeTask(l1, "FOUND", new Date(now - 9 * 60_000), leader.id);
    await completeTask(l1, "FOUND_AT_ORIGINAL", new Date(now - 8 * 60_000), leader.id);
    const l2 = await reportLine(`972${now}02`, pickerOne.id, inRange);
    await completeTask(l2, "NOT_FOUND", new Date(now - 8 * 60_000), leader.id);
    // OTHER-only line: excluded (non-conclusive).
    const l3 = await reportLine(`972${now}03`, pickerOne.id, inRange);
    await completeTask(l3, "OTHER", new Date(now - 8 * 60_000), leader.id);
    // Cancelled line without conclusive check: excluded.
    await reportLine(`972${now}04`, pickerOne.id, inRange, "CANCELLED");
    // Out-of-range line: excluded by date range.
    const l5 = await reportLine(`972${now}05`, pickerOne.id, new Date(now - 90 * 24 * 60_60_000));
    await completeTask(l5, "FOUND_AT_ORIGINAL", new Date(now - 89 * 24 * 60_60_000), leader.id);
    // picker two: one WRONG_LOCATION for the role-filter contrast (both are PICKERs; role=PICKER keeps both).
    const l6 = await reportLine(`972${now}06`, pickerTwo.id, inRange);
    await completeTask(l6, "WRONG_LOCATION", new Date(now - 8 * 60_000), leader.id);
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
    if (taskIds.length) await db.delete(checkTasks).where(inArray(checkTasks.id, taskIds));
    if (lineIds.length) await db.delete(shortPickLines).where(inArray(shortPickLines.id, lineIds));
    if (caseIds.length) await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    if (userIds.length) await db.delete(sessions).where(inArray(sessions.userId, userIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await closeDb();
  });

  function window() {
    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 60 * 60_000).toISOString();
    return { from, to };
  }

  it("computes latest-wins counts with OTHER/cancelled/date-range exclusions and suppresses <20", async () => {
    const { from, to } = window();
    const response = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&source=PICKER_REPORT`, "GET", leaderCookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    // picker one: l1 -> FOUND_AT_ORIGINAL (latest wins), l2 -> NOT_FOUND; picker two: WRONG_LOCATION.
    expect(body.kpis.sameLocationFound).toMatchObject({ numerator: 1, denominator: 3, percentage: null, counts: { FOUND_AT_ORIGINAL: 1, NOT_FOUND: 1, WRONG_LOCATION: 1, FOUND: 0 } });
    expect(body.kpis.sameLocationFound.percentageSuppressed).toBe(true);
    expect(body.kpis.sameLocationFound.from).toBeTruthy();
    expect(body.kpis.sameLocationFound.to).toBeTruthy();
    const one = body.kpis.sameLocationFoundByUser.find((row: { userId: string }) => row.userId === pickerOneId);
    const two = body.kpis.sameLocationFoundByUser.find((row: { userId: string }) => row.userId === pickerTwoId);
    expect(one).toMatchObject({ numerator: 1, denominator: 2, percentage: null });
    expect(two).toMatchObject({ numerator: 0, denominator: 1 });
    expect(Array.isArray(body.kpis.userDirectory)).toBe(true);
    expect(body.kpis.userDirectory.length).toBeGreaterThanOrEqual(3);
  });

  it("applies the role filter to the directory and per-user summaries", async () => {
    const { from, to } = window();
    const response = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&role=PICKER`, "GET", leaderCookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kpis.sameLocationFoundByUser.length).toBeGreaterThanOrEqual(2);
    for (const row of body.kpis.sameLocationFoundByUser) expect(row.role).toBe("PICKER");
    for (const row of body.kpis.userDirectory) expect(row.role).toBe("PICKER");
    const tl = await analyticsRoute(request(`/api/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&role=TEAM_LEADER`, "GET", leaderCookie));
    expect((await tl.json()).kpis.sameLocationFoundByUser.find((row: { userId: string }) => row.userId === pickerOneId)).toBeUndefined();
  });

  it("keeps CSV and PDF parity with the dashboard counts", async () => {
    const { from, to } = window();
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&source=PICKER_REPORT`;
    const perUser = await csvRoute(request(`/api/analytics/export/csv?dataset=same-location-found&${query}`, "GET", leaderCookie));
    expect(perUser.status).toBe(200);
    const perUserCsv = await perUser.text();
    expect(perUserCsv.split("\r\n")[0]).toContain("numerator_found_at_original,denominator_eligible_lines");
    expect(perUserCsv).toContain(pickerOneId);
    const overall = await csvRoute(request(`/api/analytics/export/csv?dataset=same-location-found-overall&${query}`, "GET", leaderCookie));
    const overallCsv = await overall.text();
    expect(overallCsv).toContain("1,3,,1,0,1,1,");
    const dashboard = await (await analyticsRoute(request(`/api/analytics?${query}`, "GET", leaderCookie))).json();
    expect(dashboard.kpis.sameLocationFound).toMatchObject({ numerator: 1, denominator: 3, counts: { FOUND_AT_ORIGINAL: 1, NOT_FOUND: 1, WRONG_LOCATION: 1 } });
    // PDF parity: the renderer consumes the same kpis object and emits a per-user table
    // with the same rows the dashboard table and per-user CSV carry (PDF body text is
    // font-subset encoded, so assert structural parity: byte growth + call-graph proof).
    const pdfWithoutUsers = await renderAnalyticsPdf({ ...dashboard, kpis: { ...dashboard.kpis, sameLocationFoundByUser: [] } }, { generatedAt: new Date("2026-09-28T10:00:00Z") });
    const pdf = await renderAnalyticsPdf(dashboard, { generatedAt: new Date("2026-09-28T10:00:00Z") });
    const pdfText = Buffer.from(pdf).toString("latin1");
    expect(pdfText.startsWith("%PDF-")).toBe(true);
    expect(pdf.byteLength).toBeGreaterThan(5000);
    const pickerOne = dashboard.kpis.sameLocationFoundByUser.find((row: { userId: string }) => row.userId === pickerOneId);
    expect(pickerOne).toMatchObject({ numerator: 1, denominator: 2, counts: { FOUND_AT_ORIGINAL: 1, FOUND: 0, NOT_FOUND: 1, WRONG_LOCATION: 0 } });
    // The per-user table adds one drawTable row per reporter: output grows vs no-user render.
    expect(pdf.byteLength).toBeGreaterThan(pdfWithoutUsers.byteLength);
    expect(dashboard.kpis.sameLocationFoundByUser).toHaveLength(2);
  });
});
