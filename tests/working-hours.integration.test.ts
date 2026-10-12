import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, configurationAudits, configurationVersions, notificationPreferences, notifications, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import type { AuthContext } from "../src/server/auth";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { getCurrentConfiguration, updateConfiguration } from "../src/server/configuration";
import { getOperationsDashboard } from "../src/server/operations";
import { getCaseForUser, listCasesForUser } from "../src/server/cases";
import { getAnalyticsReportData, parseAnalyticsFilters } from "../src/server/analytics";
import { analyticsCsv } from "../src/server/analytics";
import { emitUnresolvedMonitoringNotifications, unresolvedEmitWorkItems } from "../src/server/notifications";
import { PATCH as patchConfigurationRoute } from "../src/app/api/admin/configuration/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
// Monday 2026-10-12 06:30 UTC = 08:30 CEST: inside Mon-Fri 08:00-17:00.
const BUSINESS_NOW = new Date("2026-10-12T06:30:00Z");
const OFF_HOURS_NOW = new Date("2026-10-12T22:00:00Z");
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("working-hours case clock against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let originalConfigValues: Record<string, unknown> | null = null;
  let auth: AuthContext;
  let managerCookie = "";
  let orderSeq = 0;
  const orderNumber = () => `8${Date.now()}${String(++orderSeq).padStart(2, "0")}${suffix.slice(0, 4)}`.replaceAll(/\D/g, "").slice(0, 20);

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `wh-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeCase(createdAt: Date, resolvedAt: Date | null = null) {
    const current = await getCurrentConfiguration(getDb());
    const picker = userIds[1]!;
    const [row] = await getDb().insert(orderCases).values({ orderNumber: orderNumber(), phase: resolvedAt ? "CLOSED" : "PICKING",
      physicalState: "WITH_PICKER", source: "PICKER_REPORT", createdByUserId: picker, pickingUserId: picker,
      configurationVersionId: current.id, createdAt, updatedAt: createdAt, ...(resolvedAt ? { resolvedAt } : {}) }).returning();
    await getDb().insert(shortPickLines).values({ caseId: row!.id, originalLocation: `WH-${suffix}`.toUpperCase(),
      sku: "WH-SKU", missingQuantity: 1, reportedByUserId: picker });
    caseIds.push(row!.id);
    return row!;
  }

  beforeAll(async () => {
    const manager = await makeUser("MANAGER", "wh-manager");
    await makeUser("PICKER", "wh-picker");
    auth = { user: { id: manager.id, displayName: manager.displayName, loginIdentifier: manager.identifier,
      role: manager.role as Role, preferredLanguage: manager.preferredLanguage, permissions: manager.permissions }, sessionId: "test" };
    managerCookie = (await createSession(manager.id)).cookie.split(";")[0]!;
    originalConfigValues = (await getCurrentConfiguration(getDb())).values as unknown as Record<string, unknown>;
  });

  afterAll(async () => {
    vi.useRealTimers();
    const db = getDb();
    if (caseIds.length) {
      await db.delete(notifications).where(inArray(notifications.caseId, caseIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (originalConfigValues) {
      const [latest] = await db.select({ version: configurationVersions.version }).from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
      await db.insert(configurationVersions).values({ version: (latest?.version ?? 0) + 1, values: originalConfigValues });
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

  it("rejects invalid schedule edits and snapshots valid ones with audit", async () => {
    const current = await getCurrentConfiguration(getDb());
    await expect(updateConfiguration(auth, { values: { WORKING_HOURS_START: "25:00" }, expectedVersion: current.version })).rejects.toThrow();
    await expect(updateConfiguration(auth, { values: { WORKING_HOURS_DAYS: [] }, expectedVersion: current.version })).rejects.toThrow();
    const reversed = await getCurrentConfiguration(getDb());
    await expect(updateConfiguration(auth, { values: { WORKING_HOURS_START: "17:00", WORKING_HOURS_END: "08:00" }, expectedVersion: reversed.version })).rejects.toThrow();
    const fresh = await getCurrentConfiguration(getDb());
    // Same invalid edits through the real route surface as 400s (route maps Zod failures to 400).
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: fresh.version, values: { WORKING_HOURS_START: "25:00" } }, managerCookie))).status).toBe(400);
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: fresh.version, values: { WORKING_HOURS_DAYS: [] } }, managerCookie))).status).toBe(400);
    expect((await patchConfigurationRoute(request("/api/admin/configuration", "PATCH",
      { expectedVersion: fresh.version, values: { WORKING_HOURS_START: "17:00", WORKING_HOURS_END: "08:00" } }, managerCookie))).status).toBe(400);
    const updated = await updateConfiguration(auth, { values: { WORKING_HOURS_DAYS: [1, 2, 3, 4], WORKING_HOURS_START: "09:00", WORKING_HOURS_END: "17:30" }, expectedVersion: fresh.version });
    expect(updated.values.WORKING_HOURS_DAYS).toEqual([1, 2, 3, 4]);
    expect(updated.changedValues).toMatchObject({ WORKING_HOURS_START: "09:00" });
    const [configAudit] = await getDb().select().from(configurationAudits).where(eq(configurationAudits.newVersionId, updated.versionId));
    expect(configAudit).toMatchObject({ previousVersionId: fresh.id, newVersionId: updated.versionId,
      changedValues: { WORKING_HOURS_DAYS: [1, 2, 3, 4], WORKING_HOURS_START: "09:00", WORKING_HOURS_END: "17:30" } });
    const [log] = await getDb().select().from(auditLog)
      .where(and(eq(auditLog.action, "CONFIGURATION_CHANGED"), eq(auditLog.actorUserId, auth.user.id)))
      .orderBy(desc(auditLog.createdAt)).limit(1);
    expect(log?.details).toMatchObject({ previousVersion: fresh.version, newVersion: updated.version,
      changedValues: { WORKING_HOURS_START: "09:00" } });
    // Restore the default schedule for the remaining tests.
    const latest = await getCurrentConfiguration(getDb());
    await updateConfiguration(auth, { values: { WORKING_HOURS_DAYS: [1, 2, 3, 4, 5], WORKING_HOURS_START: "08:00", WORKING_HOURS_END: "17:00" }, expectedVersion: latest.version });
  });

  it("pins each case to its creation-time schedule", async () => {
    const oldCase = await makeCase(new Date("2026-10-09T14:30:00Z"));
    const current = await getCurrentConfiguration(getDb());
    const updated = await updateConfiguration(auth, { values: { WORKING_HOURS_DAYS: [1, 2, 3, 4], WORKING_HOURS_START: "09:00", WORKING_HOURS_END: "17:00" }, expectedVersion: current.version });
    expect(updated.values.WORKING_HOURS_DAYS).toEqual([1, 2, 3, 4]);
    const newCase = await makeCase(new Date("2026-10-09T14:30:00Z"));
    const oldDetail = await getCaseForUser(auth, oldCase.id);
    const newDetail = await getCaseForUser(auth, newCase.id);
    expect(oldDetail!.workingHours).toEqual({ timeZone: "Europe/Amsterdam", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" });
    expect(newDetail!.workingHours).toEqual({ timeZone: "Europe/Amsterdam", days: [1, 2, 3, 4], start: "09:00", end: "17:00" });
    const latest = await getCurrentConfiguration(getDb());
    await updateConfiguration(auth, { values: { WORKING_HOURS_DAYS: [1, 2, 3, 4, 5], WORKING_HOURS_START: "08:00", WORKING_HOURS_END: "17:00" }, expectedVersion: latest.version });
    const restored = await getCurrentConfiguration(getDb());
    expect(restored.values.WORKING_HOURS_DAYS).toEqual([1, 2, 3, 4, 5]);
  });

  it("exposes working schedule and elapsed minutes on case DTOs", async () => {
    // Friday 16:30 CEST -> Monday 08:30 CEST = 60 working minutes.
    const open = await makeCase(new Date("2026-10-09T14:30:00Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUSINESS_NOW);
    try {
      const detail = await getCaseForUser(auth, open.id);
      expect(detail).toMatchObject({ elapsedWorkingMinutes: 60 });
      expect(detail!.workingHours).toEqual({ timeZone: "Europe/Amsterdam", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" });
      const listed = await listCasesForUser(auth, "active", { page: 1, pageSize: 100 });
      expect(listed.cases.find((row) => row.id === open.id)).toMatchObject({ elapsedWorkingMinutes: 60 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the global over-threshold independent of page size", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUSINESS_NOW);
    try {
      const wide = await getOperationsDashboard(auth, { page: 1, pageSize: 100 });
      const narrow = await getOperationsDashboard(auth, { page: 1, pageSize: 1 });
      expect(narrow.metrics.overThreshold).toBe(wide.metrics.overThreshold);
      expect(narrow.summary.overThreshold).toBe(wide.metrics.overThreshold);
      const target = wide.cases.find((row) => caseIds.includes(row.id));
      expect(target).toMatchObject({ elapsedWorkingMinutes: 60 });
      expect(wide.recentClosedCases.length).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports closed-overnight cases on the working basis in analytics and CSV", async () => {
    // Friday 17:30 CEST (after close) -> Monday 08:30 CEST: 30 working minutes, literal UTC kept.
    const closed = await makeCase(new Date("2026-10-09T15:30:00Z"), new Date("2026-10-12T06:30:00Z"));
    const data = await getAnalyticsReportData(auth, parseAnalyticsFilters(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" }), BUSINESS_NOW));
    const row = data.rows.cases.find((item) => item.id === closed.id);
    expect(row).toBeDefined();
    expect(row!.elapsedWorkingSeconds).toBe(30 * 60);
    expect(row!.overThreshold).toBe(true); // 30 working minutes > 15-min default critical
    expect(row!.createdAt.toISOString()).toBe("2026-10-09T15:30:00.000Z");
    const csv = analyticsCsv(data, "case", [row!]);
    expect(csv).toContain("elapsed_working_seconds,working_hours_time_zone,working_hours_days,working_hours_start,working_hours_end");
    expect(csv).toContain("Europe/Amsterdam");
  });

  it("suppresses age monitoring off-hours and fires during the next shift", async () => {
    const open = await makeCase(new Date("2026-10-09T14:30:00Z"));
    const probe = [{ id: open.id, orderNumber: open.orderNumber, createdAt: open.createdAt,
      workingHours: { timeZone: "Europe/Amsterdam", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" } }];
    const night = unresolvedEmitWorkItems(probe, new Set([open.id]), OFF_HOURS_NOW);
    expect(night[0]!.withinWorkingHours).toBe(false);
    const day = unresolvedEmitWorkItems(probe, new Set([open.id]), BUSINESS_NOW);
    expect(day[0]).toMatchObject({ withinWorkingHours: true, ageMinutes: 60 });
  });

  it("emits real age alerts only during working hours with dedupe", async () => {
    const db = getDb();
    const eligible = await makeCase(new Date("2026-10-09T14:30:00Z"));
    await db.insert(notificationPreferences).values({ userId: auth.user.id, key: "UNRESOLVED_OVER_THRESHOLD", enabled: true, thresholdMinutes: 10 })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.key],
        set: { enabled: true, thresholdMinutes: 10, updatedAt: new Date() } });
    const ownAlerts = async () => db.select().from(notifications)
      .where(and(eq(notifications.recipientUserId, auth.user.id), eq(notifications.caseId, eligible.id)));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(OFF_HOURS_NOW);
      await emitUnresolvedMonitoringNotifications();
      expect(await ownAlerts()).toEqual([]);
      vi.setSystemTime(BUSINESS_NOW);
      await emitUnresolvedMonitoringNotifications();
      const created = await ownAlerts();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ type: "UNRESOLVED_OVER_THRESHOLD",
        dedupeKey: `unresolved:${eligible.id}:10`, payload: { orderNumber: eligible.orderNumber, ageMinutes: 60, thresholdMinutes: 10 } });
      await emitUnresolvedMonitoringNotifications();
      expect(await ownAlerts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
