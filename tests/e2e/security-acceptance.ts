import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";
import { defaultPermissions, type Role } from "../../src/domain/permissions";
import { hashPin } from "../../src/server/security";

/**
 * PRD §93 security acceptance tests.
 *
 * Each assertion uses the real Next HTTP server. Direct database access is
 * limited to creating fixture users, moving invite state to expired/exhausted,
 * reading the configured lockout cap, and dropping the disposable database.
 */

const appHost = process.env.E2E_APP_HOST ?? "127.0.0.1";
const databaseHost = process.env.E2E_POSTGRES_HOST ?? process.env.PGHOST ?? "127.0.0.1";
const databasePort = process.env.E2E_POSTGRES_PORT ?? process.env.PGPORT ?? "5433";
const databaseAdminUser = process.env.E2E_POSTGRES_ADMIN_USER ?? process.env.PGUSER ?? "komorinokage";
const databaseAdminPassword = process.env.E2E_POSTGRES_ADMIN_PASSWORD ?? process.env.PGPASSWORD ?? "";
const databaseAdminDatabase = process.env.E2E_POSTGRES_ADMIN_DATABASE ?? process.env.PGDATABASE ?? "postgres";
const port = Number(process.env.E2E_SECURITY_PORT ?? 3218);
const pin = "123456";
const databaseName = `shortpick_phase8_security_${process.pid}_${Date.now().toString(36)}`;
const databaseAuthority = `${encodeURIComponent(databaseAdminUser)}${databaseAdminPassword ? `:${encodeURIComponent(databaseAdminPassword)}` : ""}@${databaseHost}:${databasePort}`;
const databaseUrl = `postgresql://${databaseAuthority}/${databaseName}`;
const appUrl = `http://${appHost}:${port}`;
const postgresCliEnv = { ...process.env, ...(databaseAdminPassword ? { PGPASSWORD: databaseAdminPassword } : {}) };
const requestTimeoutMs = Number(process.env.E2E_REQUEST_TIMEOUT_MS ?? 15_000);
const cliTimeoutMs = Number(process.env.E2E_CLI_TIMEOUT_MS ?? 120_000);

type JsonRecord = Record<string, unknown>;
type ApiResult<T = JsonRecord> = { status: number; body: T; headers: Headers };
type FixtureUser = { id: string; identifier: string; pinHash: string | null };
type Session = FixtureUser & { cookie: string };

let databaseClient: ReturnType<typeof postgres> | undefined;
let appProcess: ChildProcess | undefined;
let appOutput = "";
let cleanupPromise: Promise<void> | undefined;

function expectStatus(result: ApiResult, status: number, label: string): asserts result is ApiResult<JsonRecord> {
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
}

async function request<T = JsonRecord>(path: string, options: { method?: string; cookie?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`E2E request failed: ${method} ${path}`, { cause: error });
  }
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

function responseCookie(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  const cookie = values.map((value) => value.match(/spx_session=[^;]+/)?.[0]).find(Boolean);
  assert.ok(cookie, "login response did not set a session cookie");
  return cookie;
}

async function createUser(label: string, role: Role): Promise<FixtureUser> {
  assert.ok(databaseClient, "fixture database is not connected");
  const identifier = `security-${process.pid}-${label}-${randomUUID().slice(0, 8)}`;
  const pinHash = await hashPin(pin);
  const db = drizzle(databaseClient, { schema });
  const [user] = await db.insert(schema.users).values({
    identifier,
    displayName: `Security ${label}`,
    pinHash,
    role,
    permissions: defaultPermissions(role),
  }).returning({ id: schema.users.id, identifier: schema.users.identifier, pinHash: schema.users.pinHash });
  assert.ok(user, `could not create ${role} fixture user`);
  return user;
}

async function login(user: FixtureUser): Promise<Session> {
  const result = await request<JsonRecord>("/api/auth/login", { method: "POST", body: { identifier: user.identifier, pin } });
  expectStatus(result, 200, `login ${user.identifier}`);
  return { ...user, cookie: responseCookie(result.headers) };
}

async function createInvite(admin: Session, overrides: JsonRecord = {}) {
  const result = await request<{ invite?: JsonRecord }>("/api/admin/invites", {
    method: "POST",
    cookie: admin.cookie,
    body: { defaultRole: "PICKER", maxRegistrations: 1, ...overrides },
  });
  expectStatus(result, 201, "create security invite");
  assert.ok(result.body.invite, "invite response omitted invite");
  assert.equal(typeof result.body.invite.id, "string");
  assert.equal(typeof result.body.invite.token, "string");
  return result.body.invite;
}

async function register(inviteToken: string, label: string) {
  return request("/api/auth/register", {
    method: "POST",
    body: { inviteToken, displayName: `Registered ${label}`, pin },
  });
}

async function setupDatabase() {
  execFileSync("createdb", ["-h", databaseHost, "-p", databasePort, "-U", databaseAdminUser, "--maintenance-db", databaseAdminDatabase, databaseName], { env: postgresCliEnv, stdio: "inherit", timeout: cliTimeoutMs });
  const env = { ...postgresCliEnv, DATABASE_URL: databaseUrl };
  execFileSync("npm", ["run", "db:migrate"], { cwd: process.cwd(), env, stdio: "inherit", timeout: cliTimeoutMs });
  databaseClient = postgres(databaseUrl, { max: 8, prepare: false });
}

async function startApp() {
  const env = { ...process.env, DATABASE_URL: databaseUrl, APP_URL: appUrl, NODE_ENV: "test" as const,
    STORAGE_ENDPOINT: "", STORAGE_BUCKET: "", STORAGE_ACCESS_KEY_ID: "", STORAGE_SECRET_ACCESS_KEY: "" };
  const nextBin = `${process.cwd()}/node_modules/next/dist/bin/next`;
  const child = spawn(process.execPath, [nextBin, "start", "--hostname", appHost, "--port", String(port)], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
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
  const child = appProcess;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(1_000)]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function closeDatabase() {
  if (databaseClient) await databaseClient.end({ timeout: 5 });
  databaseClient = undefined;
  execFileSync("dropdb", ["-h", databaseHost, "-p", databasePort, "-U", databaseAdminUser, "--maintenance-db", databaseAdminDatabase, "--if-exists", databaseName], { env: postgresCliEnv, stdio: "inherit", timeout: cliTimeoutMs });
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
  console.log("[e2e-security] setting up disposable database");
  await setupDatabase();
  console.log("[e2e-security] starting Next server");
  await startApp();
  const admin = await login(await createUser("admin", "ADMIN"));
  const leader = await login(await createUser("leader", "TEAM_LEADER"));
  const assistant = await login(await createUser("assistant", "ASSISTANT"));
  const picker = await login(await createUser("picker", "PICKER"));
  const disabledTarget = await login(await createUser("disabled-target", "PICKER"));
  const revokedTarget = await login(await createUser("revoked-target", "PICKER"));
  const lockoutTarget = await createUser("lockout-target", "PICKER");
  const db = drizzle(databaseClient!, { schema });

  // Exercise the optimized Next production bundle, empty analytics state, and
  // PDFKit/font integration over the real HTTP route.
  const emptyPdf = await fetch(`${appUrl}/api/analytics/export/pdf`, {
    headers: { cookie: admin.cookie },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(emptyPdf.status, 200, `empty analytics PDF should render: ${emptyPdf.status}`);
  assert.equal(emptyPdf.headers.get("content-type"), "application/pdf");
  assert.equal(emptyPdf.headers.get("x-report-retention"), "unavailable");
  const pdfPrefix = Buffer.from(await emptyPdf.arrayBuffer()).subarray(0, 5).toString("ascii");
  assert.equal(pdfPrefix, "%PDF-");

  // Session cookies are persistent and explicitly HTTP-only; auth payloads omit PIN hashes.
  const loginResponse = await request<JsonRecord>("/api/auth/login", { method: "POST", body: { identifier: picker.identifier, pin } });
  expectStatus(loginResponse, 200, "picker cookie security login");
  const setCookie = loginResponse.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /(?:^|;\s*)spx_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.doesNotMatch(JSON.stringify(loginResponse.body), /pinHash/i);
  assert.ok(!lockoutTarget.pinHash || !JSON.stringify(loginResponse.body).includes(lockoutTarget.pinHash), "login response exposed a PIN hash");
  const adminUsers = await request<{ users?: Array<JsonRecord> }>("/api/admin/users", { cookie: admin.cookie });
  expectStatus(adminUsers, 200, "admin user list");
  assert.doesNotMatch(JSON.stringify(adminUsers.body), /pinHash/i);

  // Expired, exhausted, and revoked invitations cannot be redeemed over HTTP.
  const expiredInvite = await createInvite(admin);
  await db.update(schema.invites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.invites.id, String(expiredInvite.id)));
  expectStatus(await register(String(expiredInvite.token), "expired"), 400, "expired invitation");

  const exhaustedInvite = await createInvite(admin);
  await db.update(schema.invites).set({ registrationsUsed: 1 }).where(eq(schema.invites.id, String(exhaustedInvite.id)));
  expectStatus(await register(String(exhaustedInvite.token), "exhausted"), 400, "exhausted invitation");

  const revokedInvite = await createInvite(admin);
  expectStatus(await request(`/api/admin/invites/${String(revokedInvite.id)}`, { method: "DELETE", cookie: admin.cookie }), 200, "revoke invitation");
  expectStatus(await register(String(revokedInvite.token), "revoked"), 400, "revoked invitation");

  // Role and user administration boundaries are enforced server-side.
  expectStatus(await request("/api/admin/users", { cookie: picker.cookie }), 403, "picker user administration access");
  expectStatus(await request(`/api/admin/users/${leader.id}`, { method: "PATCH", cookie: assistant.cookie, body: { action: "permissions", permissions: ["EDIT_TL_PERMISSIONS"] } }), 403, "assistant altering team leader privileges");
  expectStatus(await request(`/api/admin/users/${admin.id}`, { method: "PATCH", cookie: assistant.cookie, body: { action: "permissions", permissions: ["VIEW_USERS"] } }), 403, "assistant altering admin privileges");
  expectStatus(await request(`/api/admin/users/${admin.id}`, { method: "PATCH", cookie: leader.cookie, body: { action: "permissions", permissions: ["VIEW_USERS"] } }), 403, "team leader altering admin privileges");

  // Disabling a user and explicitly revoking sessions both invalidate existing cookies.
  expectStatus(await request(`/api/admin/users/${disabledTarget.id}`, { method: "PATCH", cookie: admin.cookie, body: { action: "status", status: "DISABLED" } }), 200, "disable target user");
  expectStatus(await request("/api/auth/session", { cookie: disabledTarget.cookie }), 401, "disabled user session access");
  expectStatus(await request(`/api/admin/users/${revokedTarget.id}`, { method: "PATCH", cookie: admin.cookie, body: { action: "revokeSessions" } }), 200, "revoke target sessions");
  expectStatus(await request("/api/auth/session", { cookie: revokedTarget.cookie }), 401, "revoked session access");

  // Repeated failed PIN attempts eventually lock the account, including a correct PIN during lockout.
  const [configuration] = await db.select().from(schema.configurationVersions).orderBy(desc(schema.configurationVersions.version)).limit(1);
  const maxFailures = Number((configuration?.values as Record<string, unknown> | undefined)?.LOGIN_MAX_FAILED_ATTEMPTS ?? 5);
  const failures = await Promise.all(Array.from({ length: maxFailures + 1 }, () => request("/api/auth/login", { method: "POST", body: { identifier: lockoutTarget.identifier, pin: "999999" } })));
  assert.ok(failures.some((result) => result.status === 423), `failed PIN burst did not lock account: ${failures.map((result) => result.status).join(",")}`);
  expectStatus(await request("/api/auth/login", { method: "POST", body: { identifier: lockoutTarget.identifier, pin } }), 423, "correct PIN during temporary lockout");

  console.log(JSON.stringify({
    database: databaseName,
    baseUrl: appUrl,
    checks: {
      expiredInvite: "passed",
      exhaustedInvite: "passed",
      revokedInvite: "passed",
      pickerAdminDenied: "passed",
      assistantPrivilegeBoundary: "passed",
      teamLeaderAdminBoundary: "passed",
      httpOnlyCookie: "passed",
      pinHashesOmitted: "passed",
      disabledSession: "passed",
      revokedSession: "passed",
      pinLockout: "passed",
    },
    coverage: "Real HTTP route and database coverage; no browser automation in this runner.",
  }, null, 2));
}

async function main() {
  installSignalCleanup();
  try {
    await run();
  } finally {
    console.log("[e2e-security] cleaning up app and database");
    await cleanup();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
