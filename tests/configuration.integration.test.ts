import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import {
  auditLog,
  caseEvents,
  checkTasks,
  configurationAudits,
  configurationVersions,
  orderCases,
  sessions,
  shortPickLines,
  users,
} from "../src/db/schema";
import { defaultPermissions, type Permission, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { GET as getConfigurationRoute, PATCH as patchConfigurationRoute } from "../src/app/api/admin/configuration/route";
import { GET as getCapacityRoute, PUT as setCapacityRoute } from "../src/app/api/admin/check-capacity/route";
import { POST as createCaseRoute } from "../src/app/api/cases/route";
import { POST as addLineRoute } from "../src/app/api/cases/[id]/lines/route";
import { POST as claimRoute } from "../src/app/api/checks/[id]/claim/route";
import { POST as completeRoute } from "../src/app/api/checks/[id]/complete/route";
import { POST as stageRoute } from "../src/app/api/cases/[id]/stage/route";
import { GET as dashboardRoute } from "../src/app/api/operations/dashboard/route";
import { CONFIGURATION_DEFAULTS, configurationPatchSchema, normalizeConfigurationValues } from "../src/server/configuration";
import { ZodError } from "zod";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function errorMessageChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && current !== null && "message" in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") messages.push(message);
      current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
      continue;
    }
    break;
  }
  return messages.join(" | ");
}

async function expectImmutableFailure(operation: Promise<unknown>) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(errorMessageChain(caught)).toMatch(/immutable/i);
}

describeDatabase("Phase 6 configuration versioning and snapshots against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let pickerCookie = "";
  let checkerOneCookie = "";
  let checkerTwoCookie = "";
  let leaderCookie = "";
  let adminCookie = "";
  let assistantCookie = "";
  let assistantId = "";
  let checkerOneId = "";
  let initialConfigurationValues: Record<string, unknown> | null = null;
  let caseCounter = 0;

  async function makeUser(role: Role, name: string, extraPermissions: Permission[] = []) {
    const permissions = [...new Set([...defaultPermissions(role), ...extraPermissions])];
    const [user] = await getDb().insert(users).values({
      identifier: `configuration-${suffix}-${name}`,
      displayName: `Configuration ${name}`,
      pinHash: await hashPin("123456"),
      role,
      permissions,
    }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function cookieFor(userId: string) {
    return (await createSession(userId)).cookie.split(";")[0]!;
  }

  async function currentConfiguration(cookie = leaderCookie) {
    const response = await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, cookie));
    expect(response.status).toBe(200);
    return await response.json() as {
      version: number;
      versionId: string;
      values: Record<string, unknown>;
      history: Array<{ version: number; versionId: string; values: Record<string, unknown>; changedBy: { id: string } | null; changedValues: Record<string, unknown> }>;
    };
  }

  async function updateConfiguration(cookie: string, expectedVersion: number, values: Record<string, unknown>) {
    return patchConfigurationRoute(request("/api/admin/configuration", "PATCH", { expectedVersion, values }, cookie));
  }

  async function createCase(orderSuffix: string, cookie = pickerCookie) {
    const response = await createCaseRoute(request("/api/cases", "POST", {
      orderNumber: `9${Date.now()}${String(++caseCounter).padStart(3, "0")}`,
      confirmedHistoricalCaseIds: [],
      firstLine: { location: `01.cfg.${orderSuffix}`, sku: `sku-${orderSuffix}`, quantity: 1 },
    }, cookie));
    expect(response.status).toBe(201);
    const created = (await response.json()).case as { id: string; configurationVersionId: string; lines: Array<{ id: string }> };
    caseIds.push(created.id);
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, created.lines[0]!.id));
    return { ...created, lineId: created.lines[0]!.id, taskId: task!.id };
  }

  async function addSecondLine(caseId: string, suffixValue: string) {
    const response = await addLineRoute(request(`/api/cases/${caseId}/lines`, "POST", {
      location: `02.cfg.${suffixValue}`,
      sku: `sku-second-${suffixValue}`,
      quantity: 1,
    }, pickerCookie), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(201);
    const line = (await response.json()).line as { id: string };
    const [task] = await getDb().select().from(checkTasks).where(eq(checkTasks.shortPickLineId, line.id));
    return { lineId: line.id, taskId: task!.id };
  }

  beforeAll(async () => {
    await getDb().select().from(configurationVersions).limit(1);
    const [initial] = await getDb().select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    initialConfigurationValues = initial?.values ?? null;
    const picker = await makeUser("PICKER", "picker");
    const checkerOne = await makeUser("TROUBLESHOOTER", "checker-one");
    const checkerTwo = await makeUser("TROUBLESHOOTER", "checker-two");
    const leader = await makeUser("TEAM_LEADER", "leader");
    const admin = await makeUser("ADMIN", "admin");
    const assistant = await makeUser("ASSISTANT", "assistant", ["MANAGE_CONFIGURATION"]);
    assistantId = assistant.id;
    checkerOneId = checkerOne.id;
    pickerCookie = await cookieFor(picker.id);
    checkerOneCookie = await cookieFor(checkerOne.id);
    checkerTwoCookie = await cookieFor(checkerTwo.id);
    leaderCookie = await cookieFor(leader.id);
    adminCookie = await cookieFor(admin.id);
    assistantCookie = await cookieFor(assistant.id);
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      const lineIds = (await db.select({ id: shortPickLines.id }).from(shortPickLines).where(inArray(shortPickLines.caseId, caseIds))).map((row) => row.id);
      if (lineIds.length) await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId, lineIds));
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    if (initialConfigurationValues) {
      const [current] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
      if (current && JSON.stringify(current.values) !== JSON.stringify(initialConfigurationValues)) {
        await updateConfiguration(leaderCookie, current.version, initialConfigurationValues);
      }
    }
    if (userIds.length) {
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("limits configuration access to authorized managers and records immutable version history", async () => {
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET"))).status).toBe(401);
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, pickerCookie))).status).toBe(403);
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, assistantCookie))).status).toBe(403);
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, leaderCookie))).status).toBe(200);
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, adminCookie))).status).toBe(200);

    const before = await currentConfiguration();
    const changed = await updateConfiguration(leaderCookie, before.version, { SHORT_PICK_HOLD_LOCATION_NAME: `CFG-HOLD-${suffix}` });
    expect(changed.status).toBe(200);
    const after = await changed.json() as { version: number; versionId: string; values: Record<string, unknown>; changedBy: { id: string }; changedValues: Record<string, unknown> };
    expect(after).toMatchObject({ version: before.version + 1, values: { SHORT_PICK_HOLD_LOCATION_NAME: `CFG-HOLD-${suffix}` }, changedValues: { SHORT_PICK_HOLD_LOCATION_NAME: `CFG-HOLD-${suffix}` }, changedBy: { id: expect.any(String) } });

    const [oldVersion] = await getDb().select().from(configurationVersions).where(eq(configurationVersions.id, before.versionId));
    expect(normalizeConfigurationValues(oldVersion!.values)).toMatchObject(before.values);
    const [audit] = await getDb().select().from(configurationAudits).where(eq(configurationAudits.newVersionId, after.versionId));
    expect(audit).toMatchObject({ previousVersionId: before.versionId, newVersionId: after.versionId, changedByUserId: expect.any(String), changedValues: { SHORT_PICK_HOLD_LOCATION_NAME: `CFG-HOLD-${suffix}` } });
    const [log] = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "CONFIGURATION_CHANGED"), eq(auditLog.actorUserId, audit!.changedByUserId!))).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(log?.details).toMatchObject({ previousVersion: before.version, newVersion: after.version, changedValues: { SHORT_PICK_HOLD_LOCATION_NAME: `CFG-HOLD-${suffix}` } });
  });

  it("rejects stale optimistic updates while serializing concurrent configuration changes", async () => {
    const before = await currentConfiguration();
    const firstValue = !Boolean(before.values.PUSH_ENABLED);
    const secondValue = !Boolean(before.values.MANUAL_CASE_CREATION_ENABLED);
    const responses = await Promise.all([
      updateConfiguration(leaderCookie, before.version, { PUSH_ENABLED: firstValue }),
      updateConfiguration(adminCookie, before.version, { MANUAL_CASE_CREATION_ENABLED: secondValue }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toMatchObject({ code: "CONFIGURATION_VERSION_CONFLICT", details: { currentVersion: before.version + 1 } });
    const after = await currentConfiguration();
    expect(after.version).toBe(before.version + 1);
  });

  it("allows an Assistant to manage configuration only when both permission and the feature flag are enabled", async () => {
    const initial = await currentConfiguration();
    if (initial.values.ASSISTANT_CAN_MANAGE_CONFIGURATION !== false) {
      const resetFlag = await updateConfiguration(leaderCookie, initial.version, { ASSISTANT_CAN_MANAGE_CONFIGURATION: false });
      expect(resetFlag.status).toBe(200);
    }
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, assistantCookie))).status).toBe(403);
    const deniedWithoutPermissionUser = await makeUser("ASSISTANT", "without-permission");
    const deniedWithoutPermissionCookie = await cookieFor(deniedWithoutPermissionUser.id);
    expect((await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, deniedWithoutPermissionCookie))).status).toBe(403);

    const enabled = await currentConfiguration();
    expect((await updateConfiguration(leaderCookie, enabled.version, { ASSISTANT_CAN_MANAGE_CONFIGURATION: true })).status).toBe(200);
    const assistantRead = await getConfigurationRoute(request("/api/admin/configuration", "GET", undefined, assistantCookie));
    expect(assistantRead.status).toBe(200);
    const assistantVersion = await assistantRead.json() as { version: number };
    const assistantChanged = await updateConfiguration(assistantCookie, assistantVersion.version, { PUSH_ENABLED: !Boolean((await currentConfiguration()).values.PUSH_ENABLED) });
    expect(assistantChanged.status).toBe(200);
    const assistantDisableAttemptVersion = await currentConfiguration();
    const assistantDisableAttempt = await updateConfiguration(assistantCookie, assistantDisableAttemptVersion.version, { ASSISTANT_CAN_MANAGE_CONFIGURATION: false });
    expect(assistantDisableAttempt.status).toBe(403);
    expect((await currentConfiguration()).values.ASSISTANT_CAN_MANAGE_CONFIGURATION).toBe(true);

    const disabled = await currentConfiguration();
    expect((await updateConfiguration(leaderCookie, disabled.version, { ASSISTANT_CAN_MANAGE_CONFIGURATION: false })).status).toBe(200);
    expect((await updateConfiguration(assistantCookie, disabled.version + 1, { WARNING_THRESHOLD_MINUTES: 8 })).status).toBe(403);
    expect(assistantId).toBeTruthy();
  });

  it("versions the legacy check-capacity route and applies current capacity while snapshots stay intact", async () => {
    const before = await currentConfiguration();
    const legacyRead = await getCapacityRoute(request("/api/admin/check-capacity", "GET", undefined, leaderCookie));
    expect(legacyRead.status).toBe(200);
    expect((await legacyRead.json()).maxSimultaneousChecksPerCase).toBe(before.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE);

    const desired = before.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE === 2 ? 1 : 2;
    const cappedCase = await createCase("legacy-old-capacity");
    const cappedSecond = await addSecondLine(cappedCase.id, "legacy-old-capacity");
    expect(cappedCase.configurationVersionId).toBe(before.versionId);
    const [snapshotBefore] = await getDb().select().from(configurationVersions).where(eq(configurationVersions.id, before.versionId));
    const changed = await setCapacityRoute(request("/api/admin/check-capacity", "PUT", { maxSimultaneousChecksPerCase: desired }, leaderCookie));
    expect(changed.status).toBe(200);
    const after = await currentConfiguration();
    expect(after).toMatchObject({ version: before.version + 1, values: { MAX_SIMULTANEOUS_CHECKS_PER_CASE: desired } });
    const [audit] = await getDb().select().from(configurationAudits).where(eq(configurationAudits.newVersionId, after.versionId));
    expect(audit?.changedValues).toMatchObject({ MAX_SIMULTANEOUS_CHECKS_PER_CASE: desired });
    const [legacyLog] = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "CONFIGURATION_CHANGED"), eq(auditLog.actorUserId, (await getDb().select({ id: users.id }).from(users).where(eq(users.identifier, `configuration-${suffix}-leader`)).limit(1))[0]!.id))).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(legacyLog?.details).toMatchObject({ source: "legacy_check_capacity_endpoint", newVersion: after.version });
    // The historical snapshot row is immutable: the version the case was created under is unchanged.
    const [snapshotAfter] = await getDb().select().from(configurationVersions).where(eq(configurationVersions.id, before.versionId));
    expect(snapshotAfter).toMatchObject({ version: before.version, values: snapshotBefore!.values });
    const [storedCase] = await getDb().select().from(orderCases).where(eq(orderCases.id, cappedCase.id));
    expect(storedCase.configurationVersionId).toBe(before.versionId);

    expect((await claimRoute(request(`/api/checks/${cappedCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: cappedCase.taskId }) })).status).toBe(200);
    // Claim capacity is operational: the old-snapshot case follows the CURRENT cap, not its snapshot.
    const oldCapacityClaim = await claimRoute(request(`/api/checks/${cappedSecond.taskId}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: cappedSecond.taskId }) });
    expect(oldCapacityClaim.status).toBe(desired === 1 ? 409 : 200);

    const newVersionCase = await createCase("new-capacity");
    const newVersionSecond = await addSecondLine(newVersionCase.id, "new-capacity");
    if (desired === 2) {
      expect((await claimRoute(request(`/api/checks/${newVersionCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: newVersionCase.taskId }) })).status).toBe(200);
      expect((await claimRoute(request(`/api/checks/${newVersionSecond.taskId}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: newVersionSecond.taskId }) })).status).toBe(200);
    } else {
      expect((await claimRoute(request(`/api/checks/${newVersionCase.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: newVersionCase.taskId }) })).status).toBe(200);
      expect((await claimRoute(request(`/api/checks/${newVersionSecond.taskId}/claim`, "POST", undefined, checkerTwoCookie), { params: Promise.resolve({ id: newVersionSecond.taskId }) })).status).toBe(409);
    }
  });

  it("keeps the baseline picking retrieval assignment on the picker when checker retrieval is disabled", async () => {
    let configuration = await currentConfiguration();
    if (configuration.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED !== false) {
      const changed = await updateConfiguration(leaderCookie, configuration.version, { CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false });
      expect(changed.status).toBe(200);
      configuration = await currentConfiguration();
    }
    const item = await createCase("picker-retrieval");
    expect(configuration.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED).toBe(false);
    expect(item.configurationVersionId).toBe(configuration.versionId);
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "BTS-PICKING" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    const [picker] = await getDb().select({ id: users.id }).from(users).where(eq(users.identifier, `configuration-${suffix}-picker`)).limit(1);
    expect(line).toMatchObject({ state: "FOUND", retrievalState: "PENDING", retrievalResponsibleUserId: picker!.id });
    expect(line!.retrievalResponsibleUserId).not.toBe(checkerOneId);
  });

  it("keeps the hold location and other workflow behavior pinned to each case configuration version", async () => {
    const before = await currentConfiguration();
    const oldLocationCase = await createCase("old-location");
    expect(oldLocationCase.configurationVersionId).toBe(before.versionId);
    const nextLocation = `CFG-HOLD-NEXT-${suffix}`;
    const changed = await updateConfiguration(leaderCookie, before.version, { SHORT_PICK_HOLD_LOCATION_NAME: nextLocation });
    expect(changed.status).toBe(200);
    const after = await changed.json() as { version: number; versionId: string };
    const newLocationCase = await createCase("new-location");
    expect(newLocationCase.configurationVersionId).toBe(after.versionId);

    const oldStaged = await stageRoute(request(`/api/cases/${oldLocationCase.id}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: oldLocationCase.id }) });
    expect(oldStaged.status).toBe(200);
    const newStaged = await stageRoute(request(`/api/cases/${newLocationCase.id}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: newLocationCase.id }) });
    expect(newStaged.status).toBe(200);
    const [oldStored] = await getDb().select().from(orderCases).where(eq(orderCases.id, oldLocationCase.id));
    const [newStored] = await getDb().select().from(orderCases).where(eq(orderCases.id, newLocationCase.id));
    expect(oldStored).toMatchObject({ configurationVersionId: before.versionId, physicalLocation: before.values.SHORT_PICK_HOLD_LOCATION_NAME });
    expect(newStored).toMatchObject({ configurationVersionId: after.versionId, physicalLocation: nextLocation });
  });

  it("keeps old attention thresholds on existing cases while new cases use the updated version", async () => {
    let before = await currentConfiguration();
    if (before.values.WARNING_THRESHOLD_MINUTES !== 3 || before.values.ATTENTION_THRESHOLD_MINUTES !== 4 || before.values.CRITICAL_THRESHOLD_MINUTES !== 5) {
      const normalized = await updateConfiguration(leaderCookie, before.version, {
        WARNING_THRESHOLD_MINUTES: 3,
        ATTENTION_THRESHOLD_MINUTES: 4,
        CRITICAL_THRESHOLD_MINUTES: 5,
      });
      expect(normalized.status).toBe(200);
      before = await currentConfiguration();
    }
    const oldCase = await createCase("threshold-old");
    expect(oldCase.configurationVersionId).toBe(before.versionId);
    expect(before.values.CRITICAL_THRESHOLD_MINUTES).toBe(5);
    const changed = await updateConfiguration(leaderCookie, before.version, {
      WARNING_THRESHOLD_MINUTES: 1,
      ATTENTION_THRESHOLD_MINUTES: 2,
      CRITICAL_THRESHOLD_MINUTES: 3,
    });
    expect(changed.status).toBe(200);
    const after = await changed.json() as { version: number; versionId: string };
    const newCase = await createCase("threshold-new");
    expect(newCase.configurationVersionId).toBe(after.versionId);
    // Explicit business time: Monday 06:30 UTC = 08:30 CEST, inside Mon-Fri
    // 08:00-17:00, so both 4-real-minute ages read as 4 working minutes.
    // PostgreSQL I/O needs real timers: fake Date only for the read; fixture
    // timestamps use explicit business dates.
    const businessNow = new Date("2026-10-12T06:30:00Z");
    const agedAt = new Date(businessNow.getTime() - 4 * 60_000);
    await getDb().update(orderCases).set({ createdAt: agedAt, updatedAt: agedAt }).where(eq(orderCases.id, oldCase.id));
    await getDb().update(orderCases).set({ createdAt: agedAt, updatedAt: agedAt }).where(eq(orderCases.id, newCase.id));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(businessNow);
    try {
      const dashboard = await dashboardRoute(request("/api/operations/dashboard?page=1&pageSize=100", "GET", undefined, leaderCookie));
      expect(dashboard.status).toBe(200);
      const payload = await dashboard.json() as {
        thresholds: { warning: number; attention: number; critical: number };
        cases: Array<{ id: string; configurationVersionId: string; attentionLevel: string; elapsedWorkingMinutes: number; createdAt: string }>;
      };
      expect(payload.thresholds).toEqual({ warning: 1, attention: 2, critical: 3 });
      const oldRow = payload.cases.find((row) => row.id === oldCase.id);
      const newRow = payload.cases.find((row) => row.id === newCase.id);
      expect(oldRow).toMatchObject({ configurationVersionId: before.versionId, attentionLevel: "ATTENTION" });
      expect(newRow).toMatchObject({ configurationVersionId: after.versionId, attentionLevel: "CRITICAL" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not route an existing found line to a checker when its staged retrieval setting is disabled", async () => {
    const before = await currentConfiguration();
    const changed = await updateConfiguration(leaderCookie, before.version, {
      CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false,
      CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: false,
    });
    expect(changed.status).toBe(200);
    const configuration = await currentConfiguration();
    const item = await createCase("staged-no-checker");
    expect(item.configurationVersionId).toBe(configuration.versionId);
    expect((await claimRoute(request(`/api/checks/${item.taskId}/claim`, "POST", undefined, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    expect((await completeRoute(request(`/api/checks/${item.taskId}/complete`, "POST", { code: "FOUND", discoveredLocation: "BTS-STAGED" }, checkerOneCookie), { params: Promise.resolve({ id: item.taskId }) })).status).toBe(200);
    const staged = await stageRoute(request(`/api/cases/${item.id}/stage`, "POST", { confirmedPhysicalPlacement: true }, pickerCookie), { params: Promise.resolve({ id: item.id }) });
    expect(staged.status).toBe(200);
    const [line] = await getDb().select().from(shortPickLines).where(eq(shortPickLines.id, item.lineId));
    expect(line).toMatchObject({ state: "FOUND", retrievalState: "PENDING" });
    expect(line!.retrievalResponsibleUserId).not.toBe(checkerOneId);
    expect(line!.currentResponsibleUserId).not.toBe(checkerOneId);
    const events = await getDb().select().from(caseEvents).where(eq(caseEvents.caseId, item.id));
    expect(events.some((event) => event.eventType === "RETRIEVAL_ASSIGNED" && (event.details as { responsibleUserId?: string }).responsibleUserId === checkerOneId)).toBe(false);
  });

  it("backfills every existing case to a real configuration version and preserves the bootstrap audit", async () => {
    const db = getDb();
    const [bootstrap] = await db.select().from(configurationVersions).where(eq(configurationVersions.version, 1));
    expect(bootstrap).toBeTruthy();
    const [bootstrapAudit] = await db.select().from(configurationAudits).where(eq(configurationAudits.newVersionId, bootstrap!.id));
    expect(bootstrapAudit).toMatchObject({ previousVersionId: null, newVersionId: bootstrap!.id });
    const orphaned = await db.select({ id: orderCases.id }).from(orderCases)
      .leftJoin(configurationVersions, eq(orderCases.configurationVersionId, configurationVersions.id))
      .where(isNull(configurationVersions.id));
    expect(orphaned).toEqual([]);
  });

  it("rejects direct mutation of version history even when changed_by_user_id is cleared", async () => {
    const db = getDb();
    const [version] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    expect(version).toBeTruthy();
    await expectImmutableFailure(db.update(configurationVersions).set({
      version: version!.version + 1000,
      values: { ...version!.values, CRITICAL_THRESHOLD_MINUTES: 5 },
      changedByUserId: null,
    }).where(eq(configurationVersions.id, version!.id)));
    const [storedVersion] = await db.select().from(configurationVersions).where(eq(configurationVersions.id, version!.id));
    expect(storedVersion).toMatchObject({ version: version!.version, values: version!.values, changedByUserId: version!.changedByUserId });

    const [audit] = await db.select().from(configurationAudits).where(eq(configurationAudits.newVersionId, version!.id)).limit(1);
    if (audit) {
      await expectImmutableFailure(db.update(configurationAudits).set({ changedValues: { CRITICAL_THRESHOLD_MINUTES: 5 }, changedByUserId: null }).where(eq(configurationAudits.id, audit.id)));
    }
  });

  it("normalizes a legacy v1 row (missing newer keys) with defaults", () => {
    const { PROFILE_PHOTO_MAX_UPLOAD_BYTES: _dropped, ...rest } = { ...CONFIGURATION_DEFAULTS } as Record<string, unknown>; void _dropped;
    const legacy = { ...rest, ALLOWED_RESOLUTION_CODES: ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"], MAX_SIMULTANEOUS_CHECKS_PER_CASE: 1 };
    const normalized = normalizeConfigurationValues(legacy);
    expect(normalized.PROFILE_PHOTO_MAX_UPLOAD_BYTES).toBe(CONFIGURATION_DEFAULTS.PROFILE_PHOTO_MAX_UPLOAD_BYTES);
    expect(normalized.MAX_SIMULTANEOUS_CHECKS_PER_CASE).toBe(1);
    expect(normalized.ALLOWED_RESOLUTION_CODES).toEqual(["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"]);
  });

  it("drops unknown retired keys without touching known values", () => {
    const normalized = normalizeConfigurationValues({ ...CONFIGURATION_DEFAULTS, LEGACY_PICKER_PIN_ENABLED: true });
    expect("LEGACY_PICKER_PIN_ENABLED" in normalized).toBe(false);
    expect(normalized.PUSH_ENABLED).toBe(CONFIGURATION_DEFAULTS.PUSH_ENABLED);
  });

  it("still throws on wrong-typed stored values", () => {
    expect(() => normalizeConfigurationValues({ ...CONFIGURATION_DEFAULTS, WARNING_THRESHOLD_MINUTES: "soon" })).toThrow(ZodError);
  });

  it("keeps PATCH input strict against unknown keys", () => {
    expect(configurationPatchSchema.safeParse({ expectedVersion: 1, values: { PUSH_ENABLED: true, BOGUS_KEY: 1 } }).success).toBe(false);
    expect(configurationPatchSchema.safeParse({ expectedVersion: 1, values: { PUSH_ENABLED: false } }).success).toBe(true);
  });
});
