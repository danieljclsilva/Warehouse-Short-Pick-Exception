import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";
import { defaultPermissions, type Role } from "../../src/domain/permissions";
import { hashPin } from "../../src/server/security";

/**
 * Phase 8 critical workflow smoke tests.
 *
 * These tests intentionally use fetch against a running Next server. The only
 * direct database access is fixture setup and final database disposal; every
 * workflow mutation and read is performed through the real HTTP route.
 */

const appHost = process.env.E2E_APP_HOST ?? "127.0.0.1";
const databaseHost = process.env.E2E_POSTGRES_HOST ?? process.env.PGHOST ?? "127.0.0.1";
const databasePort = process.env.E2E_POSTGRES_PORT ?? process.env.PGPORT ?? "5433";
const databaseAdminUser = process.env.E2E_POSTGRES_ADMIN_USER ?? process.env.PGUSER ?? "komorinokage";
const databaseAdminPassword = process.env.E2E_POSTGRES_ADMIN_PASSWORD ?? process.env.PGPASSWORD ?? "";
const databaseAdminDatabase = process.env.E2E_POSTGRES_ADMIN_DATABASE ?? process.env.PGDATABASE ?? "postgres";
const port = Number(process.env.E2E_PORT ?? 3217);
const pin = "123456";
const databaseName = `shortpick_phase8_e2e_${process.pid}_${Date.now().toString(36)}`;
const databaseAuthority = `${encodeURIComponent(databaseAdminUser)}${databaseAdminPassword ? `:${encodeURIComponent(databaseAdminPassword)}` : ""}@${databaseHost}:${databasePort}`;
const databaseUrl = `postgresql://${databaseAuthority}/${databaseName}`;
const appUrl = `http://${appHost}:${port}`;
const postgresCliEnv = { ...process.env, ...(databaseAdminPassword ? { PGPASSWORD: databaseAdminPassword } : {}) };

type JsonRecord = Record<string, unknown>;
type ApiResult<T = JsonRecord> = { status: number; body: T; headers: Headers };
type Session = { identifier: string; userId: string; cookie: string };
type CasePayload = { id: string; phase: string; lines: Array<JsonRecord>; orderNumber: string };

let databaseClient: ReturnType<typeof postgres> | undefined;
let appProcess: ChildProcess | undefined;
let appOutput = "";
let cleanupPromise: Promise<void> | undefined;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

async function request<T = JsonRecord>(path: string, options: { method?: string; cookie?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const response = await fetch(`${appUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

function expectStatus(result: ApiResult, status: number, label: string): asserts result is ApiResult<JsonRecord> {
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
}

function responseCookie(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  const cookie = values.map((value) => value.match(/spx_session=[^;]+/)?.[0]).find(Boolean);
  assert.ok(cookie, "login response did not set a session cookie");
  return cookie;
}

async function createUser(label: string, role: Role): Promise<{ id: string; identifier: string }> {
  assert.ok(databaseClient, "fixture database is not connected");
  const identifier = `e2e-${process.pid}-${label}-${randomUUID().slice(0, 8)}`;
  const pinHash = await hashPin(pin);
  const db = drizzle(databaseClient, { schema });
  const [user] = await db.insert(schema.users).values({ identifier, displayName: `E2E ${label}`, pinHash, role, permissions: defaultPermissions(role) }).returning({ id: schema.users.id, identifier: schema.users.identifier });
  assert.ok(user, `could not create ${role} fixture user`);
  return user;
}

async function login(user: { id: string; identifier: string }): Promise<Session> {
  const result = await request<JsonRecord>("/api/auth/login", { method: "POST", body: { identifier: user.identifier, pin } });
  expectStatus(result, 200, `login ${user.identifier}`);
  return { identifier: user.identifier, userId: user.id, cookie: responseCookie(result.headers) };
}

async function createCase(session: Session, orderNumber: string, location = "A-01", sku = "SKU-ONE", quantity = 1): Promise<CasePayload> {
  const result = await request<{ case?: CasePayload }>("/api/cases", { method: "POST", cookie: session.cookie, body: { orderNumber, firstLine: { location, sku, quantity } } });
  expectStatus(result, 201, `create case ${orderNumber}`);
  assert.ok(result.body.case, `create case ${orderNumber} returned no case`);
  return result.body.case;
}

async function readCase(session: Session, caseId: string): Promise<CasePayload> {
  const result = await request<{ case?: CasePayload }>(`/api/cases/${caseId}`, { cookie: session.cookie });
  expectStatus(result, 200, `read case ${caseId}`);
  assert.ok(result.body.case, `read case ${caseId} returned no case`);
  return result.body.case;
}

async function findAvailableCheck(session: Session, caseId: string) {
  const result = await request<{ checks?: Array<JsonRecord> }>("/api/checks?scope=available", { cookie: session.cookie });
  expectStatus(result, 200, "list available checks");
  const check = result.body.checks?.find((item) => item.caseId === caseId);
  assert.ok(check, `no available check for case ${caseId}`);
  assert.equal(typeof check.id, "string");
  return check;
}

async function findLine(casePayload: CasePayload, index = 0) {
  const line = casePayload.lines[index];
  assert.ok(line, `case ${casePayload.id} has no line at index ${index}`);
  assert.equal(typeof line.id, "string");
  return line;
}

async function setupDatabase() {
  execFileSync("createdb", ["-h", databaseHost, "-p", databasePort, "-U", databaseAdminUser, "--maintenance-db", databaseAdminDatabase, databaseName], { env: postgresCliEnv, stdio: "inherit" });
  const env = { ...postgresCliEnv, DATABASE_URL: databaseUrl };
  execFileSync("npm", ["run", "db:migrate"], { cwd: process.cwd(), env, stdio: "inherit" });
  databaseClient = postgres(databaseUrl, { max: 8, prepare: false });
}

async function startApp() {
  const env = { ...process.env, DATABASE_URL: databaseUrl, APP_URL: appUrl, NODE_ENV: "test" as const };
  const child = spawn("npm", ["run", "start", "--", "--hostname", appHost, "--port", String(port)], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  appProcess = child;
  child.stdout?.on("data", (chunk: Buffer) => { appOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { appOutput += chunk.toString(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited before readiness:\n${appOutput}`);
    try {
      const response = await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await delay(250);
  }
  throw new Error(`Next server did not become ready:\n${appOutput}`);
}

async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) return;
  appProcess.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => appProcess?.once("exit", () => resolve())), delay(5_000)]);
  if (appProcess.exitCode === null) appProcess.kill("SIGKILL");
}

async function closeDatabase() {
  if (databaseClient) await databaseClient.end({ timeout: 5 });
  databaseClient = undefined;
  execFileSync("dropdb", ["-h", databaseHost, "-p", databasePort, "-U", databaseAdminUser, "--maintenance-db", databaseAdminDatabase, "--if-exists", databaseName], { env: postgresCliEnv, stdio: "inherit" });
}

function cleanup() {
  cleanupPromise ??= (async () => {
    await stopApp();
    await closeDatabase();
  })();
  return cleanupPromise;
}

function installSignalCleanup() {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => { void cleanup().finally(() => process.exit(exitCode)); });
  }
}

async function run() {
  await setupDatabase();
  await startApp();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const picker = await login(await createUser("picker", "PICKER"));
  const checker = await login(await createUser("checker", "TROUBLESHOOTER"));
  const checkerTwo = await login(await createUser("checker-two", "TROUBLESHOOTER"));
  const leader = await login(await createUser("leader", "TEAM_LEADER"));

  // A. Simple picker report, location found, retrieval, and closure.
  const simple = await createCase(picker, `${suffix}01`);
  assert.equal(simple.phase, "PICKING");
  assert.equal(simple.lines.length, 1);
  const mine = await request<{ cases?: Array<JsonRecord> }>("/api/cases?scope=mine", { cookie: picker.cookie });
  expectStatus(mine, 200, "picker own cases");
  assert.ok(mine.body.cases?.some((item) => item.id === simple.id));
  const simpleCheck = await findAvailableCheck(checker, simple.id);
  expectStatus(await request(`/api/checks/${String(simpleCheck.id)}/claim`, { method: "POST", cookie: checker.cookie }), 200, "checker claims simple case");
  expectStatus(await request(`/api/checks/${String(simpleCheck.id)}/complete`, { method: "POST", cookie: checker.cookie, body: { code: "FOUND", discoveredLocation: "A-99" } }), 200, "checker finds simple case item");
  const simpleNotifications = await request<{ notifications?: Array<JsonRecord> }>("/api/notifications", { cookie: picker.cookie });
  expectStatus(simpleNotifications, 200, "picker simple case notifications");
  assert.ok(simpleNotifications.body.notifications?.some((item) => item.type === "RESPONSIBILITY_NEW_LOCATION" && item.caseId === simple.id));
  const simpleLine = await findLine(simple);
  expectStatus(await request(`/api/cases/${simple.id}/lines/${String(simpleLine.id)}/retrieve`, { method: "POST", cookie: picker.cookie, body: { result: "RETRIEVED" } }), 200, "picker retrieves simple case");
  expectStatus(await request(`/api/cases/${simple.id}/close`, { method: "POST", cookie: picker.cookie, body: {} }), 200, "picker closes simple case");
  assert.equal((await readCase(picker, simple.id)).phase, "CLOSED");

  // B. Checker claims a check and records an alternate location.
  const foundCase = await createCase(picker, `${suffix}02`, "A-02", "SKU-ALT");
  const foundCheck = await findAvailableCheck(checker, foundCase.id);
  const claimFound = await request(`/api/checks/${String(foundCheck.id)}/claim`, { method: "POST", cookie: checker.cookie });
  expectStatus(claimFound, 200, "checker claim alternate-location check");
  const completeFound = await request(`/api/checks/${String(foundCheck.id)}/complete`, { method: "POST", cookie: checker.cookie, body: { code: "FOUND", discoveredLocation: "B-42" } });
  expectStatus(completeFound, 200, "checker reports alternate location");
  const foundNotifications = await request<{ notifications?: Array<JsonRecord> }>("/api/notifications", { cookie: picker.cookie });
  expectStatus(foundNotifications, 200, "picker alternate-location notifications");
  assert.ok(foundNotifications.body.notifications?.some((item) => item.type === "RESPONSIBILITY_NEW_LOCATION" && item.caseId === foundCase.id));
  const foundAfter = await readCase(picker, foundCase.id);
  assert.equal(foundAfter.lines[0]?.state, "FOUND");
  assert.equal(foundAfter.lines[0]?.discoveredLocation, "B-42");
  const foundLine = await findLine(foundCase);
  expectStatus(await request(`/api/cases/${foundCase.id}/lines/${String(foundLine.id)}/retrieve`, { method: "POST", cookie: picker.cookie, body: { result: "RETRIEVED" } }), 200, "picker retrieves alternate-location case");
  assert.equal((await readCase(picker, foundCase.id)).lines[0]?.state, "RESOLVED");

  // C. A failed check is retried after staging and routes retrieval to an assigned troubleshooter.
  const staged = await createCase(picker, `${suffix}03`, "A-03", "SKU-STAGED");
  const stagedLine = await findLine(staged);
  const firstStagedCheck = await findAvailableCheck(checker, staged.id);
  expectStatus(await request(`/api/checks/${String(firstStagedCheck.id)}/claim`, { method: "POST", cookie: checker.cookie }), 200, "checker claims staged retry candidate");
  expectStatus(await request(`/api/checks/${String(firstStagedCheck.id)}/complete`, { method: "POST", cookie: checker.cookie, body: { code: "NOT_FOUND" } }), 200, "checker fails first staged check");
  assert.equal((await readCase(picker, staged.id)).lines[0]?.state, "OPEN");
  const stage = await request(`/api/cases/${staged.id}/stage`, { method: "POST", cookie: picker.cookie, body: { confirmedPhysicalPlacement: true } });
  expectStatus(stage, 200, "picker confirms physical staging");
  const retryCheck = await request<{ check?: JsonRecord }>(`/api/cases/${staged.id}/lines/${String(stagedLine.id)}/checks`, { method: "POST", cookie: leader.cookie });
  expectStatus(retryCheck, 201, "team leader requests staged retry check");
  assert.ok(retryCheck.body.check?.taskId);
  const assignedRetry = await request(`/api/checks/${String(retryCheck.body.check?.taskId)}/assign`, { method: "PATCH", cookie: leader.cookie, body: { userId: checkerTwo.userId } });
  expectStatus(assignedRetry, 200, "team leader assigns staged retry to troubleshooter");
  expectStatus(await request(`/api/checks/${String(retryCheck.body.check?.taskId)}/complete`, { method: "POST", cookie: checkerTwo.cookie, body: { code: "FOUND", discoveredLocation: "C-07" } }), 200, "troubleshooter finds staged item");
  const retrievals = await request<{ retrievals?: Array<JsonRecord> }>("/api/retrievals", { cookie: checkerTwo.cookie });
  expectStatus(retrievals, 200, "troubleshooter retrieval queue");
  assert.ok(retrievals.body.retrievals?.some((item) => item.caseId === staged.id));
  expectStatus(await request(`/api/cases/${staged.id}/lines/${String(stagedLine.id)}/retrieve`, { method: "POST", cookie: checkerTwo.cookie, body: { result: "RETRIEVED" } }), 200, "troubleshooter confirms staged retrieval");
  assert.equal((await readCase(picker, staged.id)).lines[0]?.state, "RESOLVED");
  expectStatus(await request(`/api/cases/${staged.id}/close`, { method: "POST", cookie: picker.cookie, body: {} }), 200, "picker closes staged case");
  assert.equal((await readCase(picker, staged.id)).phase, "CLOSED");

  // D. A checker claims line A, the picker adds line B, and A resolves while B stays open.
  const multi = await createCase(picker, `${suffix}04`, "A-04", "SKU-MULTI-ONE");
  const multiLineA = await findLine(multi);
  const multiCheckA = await findAvailableCheck(checker, multi.id);
  expectStatus(await request(`/api/checks/${String(multiCheckA.id)}/claim`, { method: "POST", cookie: checker.cookie }), 200, "checker claims multi-line A");
  const secondLine = await request(`/api/cases/${multi.id}/lines`, { method: "POST", cookie: picker.cookie, body: { location: "A-05", sku: "SKU-MULTI-TWO", quantity: 2 } });
  expectStatus(secondLine, 201, "add second shortage line");
  const multiAfterAdd = await readCase(picker, multi.id);
  assert.equal(multiAfterAdd.lines.length, 2);
  assert.equal(multiAfterAdd.lines.find((line) => line.id === multiLineA.id)?.state, "CHECKING");
  assert.equal(multiAfterAdd.lines.find((line) => line.id !== multiLineA.id)?.state, "OPEN");
  expectStatus(await request(`/api/checks/${String(multiCheckA.id)}/complete`, { method: "POST", cookie: checker.cookie, body: { code: "FOUND", discoveredLocation: "D-04" } }), 200, "checker finds multi-line A");
  expectStatus(await request(`/api/cases/${multi.id}/lines/${String(multiLineA.id)}/retrieve`, { method: "POST", cookie: picker.cookie, body: { result: "RETRIEVED" } }), 200, "picker retrieves multi-line A");
  const multiAfterResolve = await readCase(picker, multi.id);
  assert.equal(multiAfterResolve.lines.find((line) => line.id === multiLineA.id)?.state, "RESOLVED");
  assert.equal(multiAfterResolve.lines.find((line) => line.id !== multiLineA.id)?.state, "OPEN");

  // E. Closed history triggers a duplicate warning; confirmation creates a new occurrence.
  const historical = await createCase(picker, `${suffix}05`, "A-06", "SKU-HISTORY");
  const closeHistorical = await request(`/api/cases/${historical.id}/close`, { method: "POST", cookie: leader.cookie, body: { administrativeResolutionReason: "Historical E2E fixture closed by team leader" } });
  expectStatus(closeHistorical, 200, "close historical case");
  const historyLookup = await request<JsonRecord>("/api/cases/lookup", { method: "POST", cookie: picker.cookie, body: { orderNumber: `${suffix}05` } });
  expectStatus(historyLookup, 200, "lookup historical order");
  assert.equal(historyLookup.body.kind, "HISTORY");
  const history = Array.isArray(historyLookup.body.history) ? historyLookup.body.history : [];
  assert.equal(history.length, 1);
  const warningCreate = await request(`/api/cases`, { method: "POST", cookie: picker.cookie, body: { orderNumber: `${suffix}05`, firstLine: { location: "A-06", sku: "SKU-HISTORY", quantity: 1 } } });
  expectStatus(warningCreate, 409, "historical duplicate confirmation requirement");
  assert.ok(Array.isArray(record(warningCreate.body).history));
  const confirmedCreate = await request<{ case?: CasePayload }>("/api/cases", { method: "POST", cookie: picker.cookie, body: { orderNumber: `${suffix}05`, confirmedHistoricalCaseIds: history.map((item) => String(record(item).id)), firstLine: { location: "A-06", sku: "SKU-HISTORY", quantity: 1 } } });
  expectStatus(confirmedCreate, 201, "create confirmed historical occurrence");
  assert.ok(confirmedCreate.body.case);

  // F. Two real HTTP claims against one task produce exactly one winner.
  const concurrent = await createCase(picker, `${suffix}06`, "A-07", "SKU-CONCURRENT");
  const concurrentCheck = await findAvailableCheck(checker, concurrent.id);
  const claimResults = await Promise.all([
    request(`/api/checks/${String(concurrentCheck.id)}/claim`, { method: "POST", cookie: checker.cookie }),
    request(`/api/checks/${String(concurrentCheck.id)}/claim`, { method: "POST", cookie: checkerTwo.cookie }),
  ]);
  assert.deepEqual(claimResults.map((result) => result.status).sort((a, b) => a - b), [200, 409]);
  assert.equal((await readCase(picker, concurrent.id)).lines[0]?.state, "CHECKING");

  console.log(JSON.stringify({
    database: databaseName,
    baseUrl: appUrl,
    flows: { A: "passed", B: "passed", C: "passed", D: "passed", E: "passed", F: "passed" },
    concurrencyStatuses: claimResults.map((result) => result.status),
    coverage: "Real HTTP route and database coverage; no browser automation in this runner.",
  }, null, 2));
}

async function main() {
  installSignalCleanup();
  try {
    await run();
  } finally {
    await cleanup();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
