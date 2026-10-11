import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { notificationPreferenceKeyEnum, notificationPreferences, notifications, orderCases, pushOutbox, pushSubscriptions, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { getCurrentConfiguration } from "@/server/configuration";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "@/server/pagination";
import { logServerEvent } from "@/server/logger";

export type NotificationType = typeof notifications.$inferInsert.type;
export type PreferenceKey = typeof notificationPreferences.$inferInsert.key;

export const preferenceKeys = notificationPreferenceKeyEnum.enumValues;
export const notificationPreferenceSchema = z.object({
  preferences: z.partialRecord(z.enum(preferenceKeys), z.boolean()).default({}),
  thresholdMinutes: z.partialRecord(z.enum(preferenceKeys), z.number().int().min(1).max(1440)).optional(),
});

const preferenceDefaults: Record<PreferenceKey, { enabled: boolean; thresholdMinutes: number | null }> = {
  NEW_SHORT_PICK: { enabled: true, thresholdMinutes: null },
  CHECK_CLAIMED: { enabled: false, thresholdMinutes: null },
  NEW_LOCATION: { enabled: true, thresholdMinutes: null },
  TROUBLESHOOTER_MESSAGE: { enabled: true, thresholdMinutes: null },
  UNRESOLVED_OVER_THRESHOLD: { enabled: true, thresholdMinutes: 10 },
  CASE_RESOLVED: { enabled: false, thresholdMinutes: null },
};

type DbOperations = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "transaction">;

export type NotificationPayload = Record<string, unknown>;
export type NotificationInput = {
  recipientUserId: string;
  type: NotificationType;
  caseId?: string | null;
  shortPickLineId?: string | null;
  payload?: NotificationPayload;
  dedupeKey?: string | null;
};

/** Inserts an in-app notification. Call this from the originating transaction. */
export async function insertNotification(tx: DbOperations, input: NotificationInput) {
  const [notification] = await tx.insert(notifications).values({
    recipientUserId: input.recipientUserId,
    type: input.type,
    caseId: input.caseId ?? null,
    shortPickLineId: input.shortPickLineId ?? null,
    payload: input.payload ?? {},
    dedupeKey: input.dedupeKey ?? null,
  }).onConflictDoNothing().returning();
  const configuration = notification ? await getCurrentConfiguration(tx) : null;
  if (notification && configuration?.values.PUSH_ENABLED && process.env.PUSH_PUBLIC_KEY && process.env.PUSH_PRIVATE_KEY && process.env.PUSH_SUBJECT) {
    const subscriptions = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId, input.recipientUserId), isNull(pushSubscriptions.disabledAt),
    ));
    if (subscriptions.length) {
      await tx.insert(pushOutbox).values(subscriptions.map((subscription) => ({
        notificationId: notification.id, subscriptionId: subscription.id,
      }))).onConflictDoNothing();
    }
  }
  return notification;
}

export async function insertResponsibilityNotification(tx: DbOperations, input: Omit<NotificationInput, "type"> & { type: Extract<NotificationType, `RESPONSIBILITY_${string}`> }) {
  const [recipient] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.recipientUserId), eq(users.status, "ACTIVE"))).limit(1);
  if (!recipient) return null;
  return insertNotification(tx, input);
}
export type InformationalNotificationType = Extract<NotificationType, "ORDER_STAGED" | "CHECK_RESOLVED_EXTERNALLY">;

export async function insertInformationalNotification(tx: DbOperations, input: Omit<NotificationInput, "type"> & {
  type: InformationalNotificationType;
  excludeActorId?: string | null;
}) {
  if (input.excludeActorId && input.recipientUserId === input.excludeActorId) return null;
  const [recipient] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.recipientUserId), eq(users.status, "ACTIVE"))).limit(1);
  if (!recipient) return null;
  return insertNotification(tx, { recipientUserId: input.recipientUserId, type: input.type,
    caseId: input.caseId, shortPickLineId: input.shortPickLineId, payload: input.payload, dedupeKey: input.dedupeKey });
}


const managerMonitoringKeys = new Set<PreferenceKey>(preferenceKeys);

function isMissingRecipientError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : "";
  return `${message}\n${causeMessage}`.includes("notifications_recipient_user_id_users_id_fk");
}

function canReceiveMonitoring(key: PreferenceKey, permissions: readonly string[]) {
  if (!permissions.includes("VIEW_ALL_OPEN_CASES")) return false;
  return key !== "TROUBLESHOOTER_MESSAGE" || permissions.includes("VIEW_CASE_MESSAGES");
}

/** Routes optional monitoring notifications to active, authorized users in the same transaction. */
export async function insertMonitoringNotifications(tx: DbOperations, input: Omit<NotificationInput, "recipientUserId" | "type"> & {
  type: Extract<NotificationType, PreferenceKey>;
  excludeUserId?: string;
}) {
  if (!managerMonitoringKeys.has(input.type)) return [];
  const candidates = await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.status, "ACTIVE"));
  const eligible = candidates.filter((user) => user.id !== input.excludeUserId && canReceiveMonitoring(input.type, user.permissions));
  if (!eligible.length) return [];
  const saved = await tx.select().from(notificationPreferences).where(inArray(notificationPreferences.userId, eligible.map((user) => user.id)));
  const prefs = new Map(saved.map((pref) => [`${pref.userId}:${pref.key}`, pref]));
  const recipients = eligible.filter((user) => {
    const preference = prefs.get(`${user.id}:${input.type}`);
    return preference ? preference.enabled : preferenceDefaults[input.type].enabled;
  });
  const result = [];
  for (const recipient of recipients) {
    try {
      // A concurrent account archival or test cleanup can remove a candidate after the
      // eligibility query. Keep that race isolated so the originating operation commits.
      result.push(await tx.transaction(async (nested) => insertNotification(nested, { ...input, recipientUserId: recipient.id })));
    } catch (error) {
      if (!isMissingRecipientError(error)) throw error;
    }
  }
  return result;
}

/**
 * Emits one threshold notification per recipient, case, and configured threshold.
 *
 * Bounded by design: eligible cases are processed in chunks of open cases per
 * transaction (default {@link EMIT_CASE_CHUNK_SIZE}), so one 5-minute tick never
 * holds locks over the full cases x recipients cross product. A failing chunk
 * aborts only its own transaction; previously committed chunks are kept.
 *
 * Dedupe: (recipientUserId, dedupeKey) is a partial unique index
 * (`notifications_recipient_dedupe_uq`), and dedupeKey covers case+threshold —
 * but NOT recipient — so the first tick creates eligible x cases rows and every
 * later tick is a quiet `onConflictDoNothing` no-op. Quiet under steady state is
 * expected, not evidence of a stuck emitter.
 */
export const EMIT_CASE_CHUNK_SIZE = 100;

/** Stateless eligibility pre-pass so chunk transactions only touch actionable cases. */
export type UnresolvedEmitWorkItem = { id: string; orderNumber: string; ageMinutes: number };

export function unresolvedEmitWorkItems(
  cases: ReadonlyArray<{ id: string; orderNumber: string; createdAt: Date }>,
  unresolvedCaseIds: ReadonlySet<string> | ReadonlyArray<string>,
  now: Date = new Date(),
): UnresolvedEmitWorkItem[] {
  const unresolved = unresolvedCaseIds instanceof Set ? unresolvedCaseIds : new Set(unresolvedCaseIds);
  const items: UnresolvedEmitWorkItem[] = [];
  for (const item of cases) {
    if (!unresolved.has(item.id)) continue;
    items.push({ id: item.id, orderNumber: item.orderNumber, ageMinutes: Math.floor((now.getTime() - item.createdAt.getTime()) / 60_000) });
  }
  return items;
}

export type EmitEligibleRecipient = { id: string; thresholdMinutes: number };

export function emitEligibleRecipients(
  candidates: ReadonlyArray<{ id: string; permissions: readonly string[] }>,
  savedPreferences: ReadonlyArray<{ userId: string; key: string; enabled: boolean; thresholdMinutes: number | null }>,
): EmitEligibleRecipient[] {
  const eligible = candidates.filter((user) => canReceiveMonitoring("UNRESOLVED_OVER_THRESHOLD", user.permissions));
  if (!eligible.length) return [];
  const prefs = new Map(savedPreferences.map((pref) => [`${pref.userId}:${pref.key}`, pref]));
  const recipients: EmitEligibleRecipient[] = [];
  for (const user of eligible) {
    const preference = prefs.get(`${user.id}:UNRESOLVED_OVER_THRESHOLD`);
    const enabled = preference?.enabled ?? preferenceDefaults.UNRESOLVED_OVER_THRESHOLD.enabled;
    const threshold = preference?.thresholdMinutes ?? preferenceDefaults.UNRESOLVED_OVER_THRESHOLD.thresholdMinutes!;
    if (!enabled || threshold < 1) continue;
    recipients.push({ id: user.id, thresholdMinutes: threshold });
  }
  return recipients;
}

export async function emitUnresolvedMonitoringNotifications(chunkSize: number = EMIT_CASE_CHUNK_SIZE) {
  const db = getDb();
  const now = new Date();
  // Reads happen outside any transaction: snapshots only, no locks held.
  const [cases, lines, candidates] = await Promise.all([
    db.select({ id: orderCases.id, orderNumber: orderCases.orderNumber, createdAt: orderCases.createdAt })
      .from(orderCases).where(sql`${orderCases.phase} <> 'CLOSED'`),
    db.select({ caseId: shortPickLines.caseId, state: shortPickLines.state }).from(shortPickLines),
    db.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.status, "ACTIVE")),
  ]);
  const recipients = emitEligibleRecipients(candidates, candidates.length
    ? await db.select().from(notificationPreferences).where(inArray(notificationPreferences.userId, candidates.map((user) => user.id)))
    : []);
  // Early exit before opening any transaction: nothing can be created.
  if (!recipients.length || !cases.length) {
    logServerEvent("info", "notification.monitoring.emit_completed", { area: "notifications", casesScanned: cases.length, eligibleRecipients: recipients.length, created: 0 });
    return 0;
  }
  const unresolvedByCase = new Set(lines.filter((line) => line.state !== "RESOLVED" && line.state !== "CANCELLED").map((line) => line.caseId));
  const work = unresolvedEmitWorkItems(cases, unresolvedByCase, now).filter((item) =>
    recipients.some((recipient) => item.ageMinutes >= recipient.thresholdMinutes));
  if (!work.length) {
    logServerEvent("info", "notification.monitoring.emit_completed", { area: "notifications", casesScanned: cases.length, eligibleRecipients: recipients.length, created: 0 });
    return 0;
  }
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : EMIT_CASE_CHUNK_SIZE;
  let created = 0;
  for (let offset = 0; offset < work.length; offset += size) {
    const chunk = work.slice(offset, offset + size);
    // One transaction per chunk: bounded lock scope, no nested savepoints.
    // A chunk failure rolls back only that chunk; prior chunks stay committed.
    created += await db.transaction(async (tx) => {
      let chunkCreated = 0;
      for (const item of chunk) {
        for (const recipient of recipients) {
          if (item.ageMinutes < recipient.thresholdMinutes) continue;
          try {
            const notification = await insertNotification(tx, { recipientUserId: recipient.id, type: "UNRESOLVED_OVER_THRESHOLD",
              caseId: item.id, payload: { orderNumber: item.orderNumber, ageMinutes: item.ageMinutes, thresholdMinutes: recipient.thresholdMinutes },
              dedupeKey: `unresolved:${item.id}:${recipient.thresholdMinutes}` });
            if (notification) chunkCreated += 1;
          } catch (error) {
            if (!isMissingRecipientError(error)) throw error;
          }
        }
      }
      return chunkCreated;
    });
  }
  logServerEvent("info", "notification.monitoring.emit_completed", { area: "notifications", casesScanned: cases.length, eligibleRecipients: recipients.length, created });
  return created;
}

export const notificationListQuerySchema = paginationQuerySchema;

export async function getNotifications(auth: AuthContext, options: { page?: number; pageSize?: number } = {}) {
  const parsed = notificationListQuerySchema.parse({ page: options.page ?? 1, pageSize: options.pageSize ?? 50 });
  const db = getDb();
  const scope = eq(notifications.recipientUserId, auth.user.id);
  const [rows, totalRow, unread] = await Promise.all([
    db.select({ id: notifications.id, type: notifications.type, caseId: notifications.caseId,
      shortPickLineId: notifications.shortPickLineId, payload: notifications.payload,
      createdAt: notifications.createdAt, readAt: notifications.readAt })
      .from(notifications).where(scope).orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(parsed.pageSize).offset(paginationOffset(parsed.page, parsed.pageSize)),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(scope),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(scope, isNull(notifications.readAt))),
  ]);
  return { notifications: rows, unreadCount: unread[0]?.count ?? 0, ...paginationMeta(totalRow[0]?.count ?? 0, parsed.page, parsed.pageSize) };
}

export async function getNotificationById(auth: AuthContext, notificationId: string) {
  const scope = and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, auth.user.id));
  const [row] = await getDb().select({ id: notifications.id, type: notifications.type, caseId: notifications.caseId,
    shortPickLineId: notifications.shortPickLineId, payload: notifications.payload,
    createdAt: notifications.createdAt, readAt: notifications.readAt })
    .from(notifications).where(scope).limit(1);
  if (!row) throw new CaseApiError("CASE_NOT_FOUND", "Notification not found", 404);
  return row;
}

async function recipientUnreadCount(recipientUserId: string) {
  const unread = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.recipientUserId, recipientUserId), isNull(notifications.readAt)));
  return unread[0]?.count ?? 0;
}

export async function markNotificationRead(auth: AuthContext, notificationId: string) {
  const db = getDb();
  const [updated] = await db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, auth.user.id), isNull(notifications.readAt)))
    .returning({ id: notifications.id, readAt: notifications.readAt });
  if (updated) return { id: updated.id, readAt: updated.readAt, unreadCount: await recipientUnreadCount(auth.user.id) };
  const [existing] = await db.select({ id: notifications.id, readAt: notifications.readAt }).from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, auth.user.id))).limit(1);
  if (!existing) throw new CaseApiError("CASE_NOT_FOUND", "Notification not found", 404);
  return { id: existing.id, readAt: existing.readAt, unreadCount: await recipientUnreadCount(auth.user.id) };
}

/**
 * Marks every unread notification for the signed-in recipient read.
 * Single UPDATE scoped to recipient + unread rows: atomic, idempotent, no row limit.
 * Replenishment hook for domain owner: call insertNotification/insertResponsibilityNotification
 * from the replenishment transaction with a REPLENISHMENT_* type (new enum values owned by domain).
 */
export async function markAllNotificationsRead(auth: AuthContext) {
  const readAt = new Date();
  const updated = await getDb().update(notifications).set({ readAt })
    .where(and(eq(notifications.recipientUserId, auth.user.id), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: updated.length, unreadCount: await recipientUnreadCount(auth.user.id) };
}

function requireMonitoringPermission(auth: AuthContext) {
  if (!hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "Monitoring preferences require manager access", 403);
}

export async function getNotificationPreferences(auth: AuthContext) {
  requireMonitoringPermission(auth);
  const rows = await getDb().select().from(notificationPreferences).where(eq(notificationPreferences.userId, auth.user.id));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return {
    preferences: Object.fromEntries(preferenceKeys.map((key) => [key, byKey.get(key)?.enabled ?? preferenceDefaults[key].enabled])),
    thresholdMinutes: Object.fromEntries(preferenceKeys.map((key) => [key, byKey.get(key)?.thresholdMinutes ?? preferenceDefaults[key].thresholdMinutes])),
  };
}

export async function updateNotificationPreferences(auth: AuthContext, input: z.infer<typeof notificationPreferenceSchema>) {
  requireMonitoringPermission(auth);
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const key of preferenceKeys) {
      const enabled = input.preferences[key];
      const thresholdMinutes = input.thresholdMinutes?.[key];
      if (enabled === undefined && thresholdMinutes === undefined) continue;
      await tx.insert(notificationPreferences).values({ userId: auth.user.id, key,
        enabled: enabled ?? preferenceDefaults[key].enabled,
        thresholdMinutes: thresholdMinutes ?? preferenceDefaults[key].thresholdMinutes,
        updatedAt: new Date() }).onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.key],
        set: { ...(enabled === undefined ? {} : { enabled }), ...(thresholdMinutes === undefined ? {} : { thresholdMinutes }), updatedAt: new Date() } });
    }
  });
  return getNotificationPreferences(auth);
}
