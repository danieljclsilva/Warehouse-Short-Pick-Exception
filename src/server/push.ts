import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import webpush from "web-push";
import { z } from "zod";
import { getDb } from "@/db";
import { notifications, pushOutbox, pushSubscriptions, users } from "@/db/schema";
import { getMessages, translate, type MessageKey } from "@/i18n/messages";
import type { AuthContext } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { getCurrentConfiguration } from "@/server/configuration";
import { logServerEvent } from "@/server/logger";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const providerHosts = [
  "fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com", "wns.windows.com",
];

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
  }).strict(),
  deviceLabel: z.string().trim().min(1).max(100).optional(),
}).strict();

function configuredVapid() {
  const publicKey = process.env.PUSH_PUBLIC_KEY?.trim();
  const privateKey = process.env.PUSH_PRIVATE_KEY?.trim();
  const subject = process.env.PUSH_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export function isPushConfigured() {
  return configuredVapid() !== null;
}

function providerAllowed(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return providerHosts.some((provider) => host === provider || host.endsWith(`.${provider}`));
}

function privateAddress(address: string) {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

/** Validates provider host, HTTPS transport, and public DNS resolution before storage or delivery. */
export async function validatePushEndpoint(endpoint: string) {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid push endpoint", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !providerAllowed(parsed.hostname)) {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid push endpoint", 400);
  }
  let addresses;
  try { addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true }); } catch {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid push endpoint", 400);
  }
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid push endpoint", 400);
  }
  return parsed.toString();
}

function expirationDate(expirationTime: number | null | undefined) {
  if (expirationTime === null || expirationTime === undefined) return null;
  const date = new Date(expirationTime);
  if (!Number.isFinite(date.getTime())) throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid push expiration", 400);
  return date;
}

export function pushStatus() {
  return { enabled: isPushConfigured(), publicKey: configuredVapid()?.publicKey ?? null };
}

export function assertPushMutationOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let expectedOrigin: string;
  try { expectedOrigin = new URL(process.env.APP_URL || request.url).origin; } catch { throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid application origin", 403); }
  let suppliedOrigin: string;
  try { suppliedOrigin = new URL(origin).origin; } catch { throw new CaseApiError("CASE_ACCESS_DENIED", "Invalid request origin", 403); }
  if (suppliedOrigin !== expectedOrigin) throw new CaseApiError("CASE_ACCESS_DENIED", "Cross-origin push mutation denied", 403);
}

export async function listPushSubscriptions(auth: AuthContext) {
  const configuration = await getCurrentConfiguration();
  const rows = await getDb().select({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel, createdAt: pushSubscriptions.createdAt })
    .from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, auth.user.id), isNull(pushSubscriptions.disabledAt))).orderBy(pushSubscriptions.createdAt);
  return { ...pushStatus(), enabled: isPushConfigured() && configuration.values.PUSH_ENABLED, subscriptions: rows };
}

export async function registerPushSubscription(auth: AuthContext, input: z.infer<typeof pushSubscriptionSchema>) {
  const configuration = await getCurrentConfiguration();
  if (!configuration.values.PUSH_ENABLED) throw new CaseApiError("CASE_ACCESS_DENIED", "Push notifications are disabled", 503);
  if (!isPushConfigured()) throw new CaseApiError("CASE_ACCESS_DENIED", "Push notifications are not configured", 503);
  const endpoint = await validatePushEndpoint(input.endpoint);
  const db = getDb();
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).for("update").limit(1);
    if (existing && existing.userId !== auth.user.id) throw new CaseApiError("CASE_ACCESS_DENIED", "Push endpoint is already registered", 409);
    const values = { userId: auth.user.id, endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
      expirationTime: expirationDate(input.expirationTime), deviceLabel: input.deviceLabel ?? existing?.deviceLabel ?? "Browser device",
      updatedAt: new Date(), disabledAt: null };
    if (existing) {
      const [updated] = await tx.update(pushSubscriptions).set(values).where(eq(pushSubscriptions.id, existing.id)).returning({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel, createdAt: pushSubscriptions.createdAt });
      return updated!;
    }
    const [inserted] = await tx.insert(pushSubscriptions).values(values).returning({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel, createdAt: pushSubscriptions.createdAt });
    return inserted!;
  });
  return { subscription: created };
}

export async function removePushSubscription(auth: AuthContext, subscriptionId: string) {
  const [removed] = await getDb().delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, subscriptionId), eq(pushSubscriptions.userId, auth.user.id))).returning({ id: pushSubscriptions.id });
  if (!removed) throw new CaseApiError("CASE_NOT_FOUND", "Push subscription not found", 404);
  return { ok: true };
}

const pushTitleKeys: Record<string, MessageKey> = {
  RESPONSIBILITY_CASE_ASSIGNED: "notificationResponsibilityChanged",
  RESPONSIBILITY_CHECK_ASSIGNED: "notificationCheckAssigned",
  RESPONSIBILITY_RETRIEVAL_ASSIGNED: "notificationRetrievalAssigned",
  RESPONSIBILITY_NEW_LOCATION: "notificationNewLocationFound",
  RESPONSIBILITY_CASE_REOPENED: "notificationCaseReopened",
  NEW_SHORT_PICK: "notificationNewShortPick",
  CHECK_CLAIMED: "notificationCheckClaimed",
  NEW_LOCATION: "notificationNewLocationFound",
  TROUBLESHOOTER_MESSAGE: "notificationCaseMessage",
  UNRESOLVED_OVER_THRESHOLD: "notificationCaseUnresolved",
  CASE_RESOLVED: "notificationCaseResolved",
  CHECK_RESOLVED_EXTERNALLY: "notificationCheckResolvedExternally",
  ORDER_STAGED: "notificationOrderStaged",
  PROFILE_PHOTO_APPROVAL_REQUIRED: "notificationPhotoApprovalRequired",
};

export function buildLocalizedPushPayload(
  notification: { id: string; type: string },
  language: string | null | undefined,
) {
  const { messages } = getMessages(language);
  const title = translate(messages, pushTitleKeys[notification.type] ?? "notificationUpdate");
  const body = translate(messages, "pushNotificationBody");
  return { title, body, notificationId: notification.id };
}

type DeliveryRow = {
  outbox: typeof pushOutbox.$inferSelect;
  subscription: typeof pushSubscriptions.$inferSelect;
  notification: typeof notifications.$inferSelect;
  language: string;
};

async function claimOutbox(limit: number): Promise<DeliveryRow[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return getDb().transaction(async (tx) => {
    const rows = await tx.select({ outbox: pushOutbox, subscription: pushSubscriptions, notification: notifications, language: users.preferredLanguage })
      .from(pushOutbox).innerJoin(pushSubscriptions, eq(pushOutbox.subscriptionId, pushSubscriptions.id)).innerJoin(notifications, eq(pushOutbox.notificationId, notifications.id))
      .innerJoin(users, eq(notifications.recipientUserId, users.id))
      .where(and(sql`${pushOutbox.attempts} < ${MAX_ATTEMPTS}`, or(
        and(or(eq(pushOutbox.status, "QUEUED"), eq(pushOutbox.status, "RETRY")), lte(pushOutbox.availableAt, now)),
        and(eq(pushOutbox.status, "PROCESSING"), lt(pushOutbox.leaseUntil, now)),
      ), isNull(pushSubscriptions.disabledAt))).orderBy(pushOutbox.availableAt).for("update", { skipLocked: true }).limit(limit);
    for (const row of rows) {
      await tx.update(pushOutbox).set({ status: "PROCESSING", attempts: sql`${pushOutbox.attempts} + 1`, leaseUntil, lastAttemptAt: now }).where(eq(pushOutbox.id, row.outbox.id));
      await tx.update(notifications).set({ pushAttemptedAt: now }).where(eq(notifications.id, row.notification.id));
      row.outbox.status = "PROCESSING";
      row.outbox.attempts += 1;
      row.outbox.leaseUntil = leaseUntil;
      row.outbox.lastAttemptAt = now;
    }
    return rows;
  });
}

function pushErrorStatus(error: unknown) {
  if (error instanceof CaseApiError) return error.status;
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}

async function finishDelivery(row: DeliveryRow, error: unknown) {
  const statusCode = pushErrorStatus(error);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    const ownership = and(eq(pushOutbox.id, row.outbox.id), eq(pushOutbox.status, "PROCESSING"), eq(pushOutbox.leaseUntil, row.outbox.leaseUntil!));
    if (!error) {
      await tx.update(pushOutbox).set({ status: "SENT", sentAt: now, leaseUntil: null, lastError: null }).where(ownership);
      return;
    }
    if (statusCode === 404 || statusCode === 410) {
      const [owned] = await tx.update(pushOutbox).set({ status: "DISABLED", leaseUntil: null, lastError: `push service ${statusCode}` }).where(ownership).returning({ id: pushOutbox.id });
      if (owned) await tx.update(pushSubscriptions).set({ disabledAt: now, updatedAt: now }).where(and(eq(pushSubscriptions.id, row.subscription.id), eq(pushSubscriptions.endpoint, row.subscription.endpoint), eq(pushSubscriptions.updatedAt, row.subscription.updatedAt)));
      return;
    }
    const retry = row.outbox.attempts < MAX_ATTEMPTS && (statusCode === null || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500);
    await tx.update(pushOutbox).set({ status: retry ? "RETRY" : "FAILED", availableAt: retry ? new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.outbox.attempts)) : now,
      leaseUntil: null, lastError: statusCode ? `push service ${statusCode}` : "push delivery failed" }).where(ownership);
  });
}

export async function deliverPushBatch(limit = 25) {
  const configuration = await getCurrentConfiguration();
  if (!configuration.values.PUSH_ENABLED) return { attempted: 0, sent: 0, retried: 0, disabled: 0, failed: 0 };
  const vapid = configuredVapid();
  if (!vapid) return { attempted: 0, sent: 0, retried: 0, disabled: 0, failed: 0 };
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const rows = await claimOutbox(Math.max(1, Math.min(100, limit)));
  const result = { attempted: rows.length, sent: 0, retried: 0, disabled: 0, failed: 0 };
  for (const row of rows) {
    let error: unknown;
    try {
      await validatePushEndpoint(row.subscription.endpoint);
      await webpush.sendNotification({ endpoint: row.subscription.endpoint, keys: { p256dh: row.subscription.p256dh, auth: row.subscription.auth } }, JSON.stringify(buildLocalizedPushPayload(row.notification, row.language)), { TTL: 60 });
    } catch (caught) { error = caught; }
    await finishDelivery(row, error);
    if (!error) result.sent += 1;
    else if (pushErrorStatus(error) === 404 || pushErrorStatus(error) === 410) {
      result.disabled += 1;
      logServerEvent("warn", "notification.push.delivery_failed", { area: "notifications", outcome: "subscription_disabled", status: pushErrorStatus(error)!, outboxId: row.outbox.id, notificationId: row.notification.id });
    } else if (row.outbox.attempts < MAX_ATTEMPTS && (pushErrorStatus(error) === null || [408, 425, 429].includes(pushErrorStatus(error)!) || pushErrorStatus(error)! >= 500)) {
      result.retried += 1;
      logServerEvent("warn", "notification.push.delivery_failed", { area: "notifications", outcome: "retry_scheduled", ...(pushErrorStatus(error) === null ? {} : { status: pushErrorStatus(error)! }), outboxId: row.outbox.id, notificationId: row.notification.id });
    } else {
      result.failed += 1;
      logServerEvent("error", "notification.push.delivery_failed", { area: "notifications", outcome: "permanent_failure", ...(pushErrorStatus(error) === null ? {} : { status: pushErrorStatus(error)! }), outboxId: row.outbox.id, notificationId: row.notification.id });
    }
  }
  return result;
}
