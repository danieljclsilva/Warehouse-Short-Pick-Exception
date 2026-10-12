import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { desc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../src/db";
import { auditLog, configurationVersions, orderCases, sessions, shortPickLines, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import type { AuthContext } from "../src/server/auth";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { getCurrentConfiguration } from "../src/server/configuration";
import { getOperationsDashboard } from "../src/server/operations";
import { GET as dashboardRoute } from "../src/app/api/operations/dashboard/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type Metrics = { openCases: number; openShortPicks: number; openMissingQuantity?: number; checking: number; staged: number; overThreshold: number; resolvedToday: number };

describeDatabase("F10 global dashboard summary against PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const caseIds: string[] = [];
  const userIds: string[] = [];
  let originalConfigValues: Record<string, unknown> | null = null;
  let auth: AuthContext;
  let managerCookie = "";
  let reporterId = "";
  let orderSeq = 0;

  const orderNumber = () => `7${Date.now()}${String(++orderSeq).padStart(2, "0")}${suffix.slice(0, 4)}`.replaceAll(/\D/g, "").slice(0, 20);

  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({ identifier: `dashsum-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role) }).returning();
    userIds.push(user!.id);
    return user!;
  }

  async function makeConfigVersion(critical: number, warning = 1, attention = 2) {
    const db = getDb();
    const current = await getCurrentConfiguration(db);
    const [latest] = await db.select({ version: configurationVersions.version }).from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    const [row] = await db.insert(configurationVersions)
      .values({ version: (latest?.version ?? 0) + 1, values: { ...current.values, WARNING_THRESHOLD_MINUTES: warning, ATTENTION_THRESHOLD_MINUTES: attention, CRITICAL_THRESHOLD_MINUTES: critical } })
      .returning();
    return row!;
  }

  async function makeCase(phase: "PICKING" | "STAGED" | "CLOSED", configurationVersionId: string, createdAt: Date) {
    const db = getDb();
    const [row] = await db.insert(orderCases).values({ orderNumber: orderNumber(), phase,
      physicalState: phase === "STAGED" ? "SHORT_PICK_HOLD" : "WITH_PICKER", source: "PICKER_REPORT",
      createdByUserId: reporterId, pickingUserId: reporterId, configurationVersionId, createdAt, updatedAt: createdAt,
      ...(phase === "CLOSED" ? { resolvedAt: createdAt } : {}) }).returning();
    caseIds.push(row!.id);
    return row!;
  }

  async function makeLine(caseId: string, state: "OPEN" | "CHECKING" | "FOUND" | "RESOLVED" | "CANCELLED", missingQuantity: number,
    extra?: { retrievalState?: string; replenishmentState?: string }) {
    const [row] = await getDb().insert(shortPickLines).values({ caseId, originalLocation: `DS-${suffix}-${randomUUID().slice(0, 6)}`.toUpperCase(),
      sku: `DS-SKU-${randomUUID().slice(0, 6)}`.toUpperCase(), missingQuantity, reportedByUserId: reporterId, state,
      ...(extra?.retrievalState ? { retrievalState: extra.retrievalState } : {}),
      ...(extra?.replenishmentState ? { replenishmentState: extra.replenishmentState } : {}),
      ...(state === "RESOLVED" || state === "CANCELLED" ? { resolvedAt: new Date() } : {}) }).returning();
    return row!;
  }

  beforeAll(async () => {
    await getDb().select().from(orderCases).limit(1);
    const manager = await makeUser("MANAGER", "dashboard-summary-manager");
    const reporter = await makeUser("PICKER", "dashboard-summary-reporter");
    reporterId = reporter.id;
    auth = { user: { id: manager.id, displayName: manager.displayName, loginIdentifier: manager.identifier,
      role: manager.role as Role, preferredLanguage: manager.preferredLanguage, permissions: manager.permissions }, sessionId: "test" };
    managerCookie = (await createSession(manager.id)).cookie.split(";")[0]!;
    originalConfigValues = (await getCurrentConfiguration(getDb())).values as unknown as Record<string, unknown>;
  });

  afterAll(async () => {
    const db = getDb();
    if (caseIds.length) {
      await db.delete(shortPickLines).where(inArray(shortPickLines.caseId, caseIds));
      await db.delete(orderCases).where(inArray(orderCases.id, caseIds));
    }
    // Configuration history is immutable: restore the pre-test values as a new version.
    if (originalConfigValues) {
      const [latest] = await db.select({ version: configurationVersions.version }).from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
      await db.insert(configurationVersions).values({ version: (latest?.version ?? 0) + 1, values: originalConfigValues });
    }
    if (userIds.length) {
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("keeps global metrics/summary invariant across pages while paging case detail", async () => {
    const before = await getOperationsDashboard(auth, { page: 1, pageSize: 1 });
    // Explicit business time: Monday 2026-10-12 10:00 UTC = 12:00 CEST, inside
    // Mon-Fri 08:00-17:00, so a 60-working-minute age exceeds the strict 5-min
    // pinned threshold while staying under the lenient 1440-min one.
    // Fixture timestamps are explicit; Date is faked only for the business reads
    // below so PostgreSQL I/O keeps real timers.
    const businessNow = new Date("2026-10-12T10:00:00Z");
    const aged = new Date(businessNow.getTime() - 60 * 60_000);
    const strict = await makeConfigVersion(5);
    const lenient = await makeConfigVersion(1440, 100, 500);
    expect(strict.id).not.toBe(lenient.id);

    // Case A (PICKING, strict 5-min config, aged 60m -> over threshold): OPEN x3 + CHECKING x1 + terminal RESOLVED x5 + CANCELLED x2.
    const caseA = await makeCase("PICKING", strict.id, aged);
    await makeLine(caseA.id, "OPEN", 3);
    await makeLine(caseA.id, "CHECKING", 1);
    // Completed-replenishment CHECKING with a pending retrieval obligation stays an
    // open line (and its pieces) but leaves the check queue: no checking delta.
    await makeLine(caseA.id, "CHECKING", 2, { retrievalState: "PENDING", replenishmentState: "COMPLETED" });
    await makeLine(caseA.id, "RESOLVED", 5);
    await makeLine(caseA.id, "CANCELLED", 2);
    // Case B (STAGED, lenient 1440-min config, aged 60m -> NOT over threshold): OPEN x2 + FOUND x1.
    const caseB = await makeCase("STAGED", lenient.id, aged);
    await makeLine(caseB.id, "OPEN", 2);
    await makeLine(caseB.id, "FOUND", 1);
    // Case C (CLOSED, resolved 48h ago): excluded from open metrics and from resolvedToday.
    const caseC = await makeCase("CLOSED", lenient.id, new Date(Date.now() - 48 * 60 * 60_000));
    // Legacy inconsistent data on a closed case must not leak into open totals.
    await makeLine(caseC.id, "OPEN", 99);
    await makeLine(caseC.id, "RESOLVED", 50);
    const expectedDelta = { openCases: 2, openShortPicks: 5, openMissingQuantity: 9, checking: 1, staged: 1, overThreshold: 1 };

    // Business-time reads only: fake Date, keep real timers for PostgreSQL I/O.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(businessNow);
    let narrowOne!: typeof before;
    let narrowTwo!: typeof before;
    let wide!: typeof before;
    let viaRoute!: Response;
    try {
      narrowOne = await getOperationsDashboard(auth, { page: 1, pageSize: 1 });
      narrowTwo = await getOperationsDashboard(auth, { page: 2, pageSize: 1 });
      wide = await getOperationsDashboard(auth, { page: 1, pageSize: 100 });
      // Domain read and API route read agree.
      viaRoute = await dashboardRoute(request("/api/operations/dashboard?page=1&pageSize=1", "GET", undefined, managerCookie));
    } finally {
      vi.useRealTimers();
    }
    // Global metrics/summary are page-invariant even when other suites' open
    // cases share the database: pages agree, and owned fixtures add the delta.
    for (const after of [narrowOne, narrowTwo, wide]) {
      expect(after.metrics.openCases - before.metrics.openCases).toBe(expectedDelta.openCases);
      expect(after.metrics.openShortPicks - before.metrics.openShortPicks).toBe(expectedDelta.openShortPicks);
      expect(after.metrics.openMissingQuantity! - (before.metrics.openMissingQuantity ?? 0)).toBe(expectedDelta.openMissingQuantity);
      expect(after.metrics.checking - before.metrics.checking).toBe(expectedDelta.checking);
      expect(after.metrics.staged - before.metrics.staged).toBe(expectedDelta.staged);
      expect(after.metrics.resolvedToday - before.metrics.resolvedToday).toBe(0);
      // Summary fields are global too.
      expect(after.summary.openCases - before.summary.openCases).toBe(expectedDelta.openCases);
      expect(after.summary.openLines - before.summary.openLines).toBe(expectedDelta.openShortPicks);
      expect(after.summary.checking - before.summary.checking).toBe(expectedDelta.checking);
      expect(after.summary.staged - before.summary.staged).toBe(expectedDelta.staged);
      expect(after.summary.resolvedToday - before.summary.resolvedToday).toBe(0);
    }
    expect(narrowOne.metrics.overThreshold).toBe(narrowTwo.metrics.overThreshold);
    expect(narrowOne.metrics.overThreshold).toBe(wide.metrics.overThreshold);
    expect(narrowOne.summary.overThreshold).toBe(wide.metrics.overThreshold);
    expect(wide.metrics.overThreshold - before.metrics.overThreshold).toBeGreaterThanOrEqual(1);
    // Owned cases are over-threshold exactly as pinned: A (strict 5m) yes, B (lenient 1440m) no.
    const detailA = wide.cases.find((item) => item.id === caseA.id);
    const detailB = wide.cases.find((item) => item.id === caseB.id);
    expect(detailA).toMatchObject({ openLineCount: 3, checkingCount: 1, missingCount: 6, currentIssue: "CHECKING", attentionLevel: "CRITICAL" });
    expect(detailB).toMatchObject({ openLineCount: 2, missingCount: 3, attentionLevel: "NORMAL" });
    // Domain read and API route read agree.
    expect(viaRoute.status).toBe(200);
    const routePayload = (await viaRoute.json()) as { metrics: Metrics };
    expect(routePayload.metrics.openShortPicks - before.metrics.openShortPicks).toBe(expectedDelta.openShortPicks);
    // Paginated case detail is preserved: full line projections and per-case piece-quantity missingCount.
    expect(detailA!.lines).toHaveLength(5);
    expect(detailA!.lineProjections).toHaveLength(5);
    expect(detailB!.lines).toHaveLength(2);
  });
});
