import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { notificationPreferenceKeyEnum, notificationPreferences, notifications, orderCases, pushOutbox, pushSubscriptions, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { getCurrentConfiguration } from "@/server/configuration";

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

/** Emits one threshold notification per recipient, case, and configured threshold. */
export async function emitUnresolvedMonitoringNotifications() {
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const [cases, lines, candidates] = await Promise.all([
      tx.select({ id: orderCases.id, orderNumber: orderCases.orderNumber, createdAt: orderCases.createdAt })
        .from(orderCases).where(sql`${orderCases.phase} <> 'CLOSED'`),
      tx.select({ caseId: shortPickLines.caseId, state: shortPickLines.state }).from(shortPickLines),
      tx.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.status, "ACTIVE")),
    ]);
    const eligible = candidates.filter((user) => canReceiveMonitoring("UNRESOLVED_OVER_THRESHOLD", user.permissions));
    if (!eligible.length) return 0;
    const unresolvedByCase = new Set(lines.filter((line) => line.state !== "RESOLVED" && line.state !== "CANCELLED").map((line) => line.caseId));
    const saved = await tx.select().from(notificationPreferences).where(inArray(notificationPreferences.userId, eligible.map((user) => user.id)));
    const prefs = new Map(saved.map((pref) => [`${pref.userId}:${pref.key}`, pref]));
    let created = 0;
    for (const item of cases) {
      if (!unresolvedByCase.has(item.id)) continue;
      const ageMinutes = Math.floor((now.getTime() - item.createdAt.getTime()) / 60_000);
      for (const recipient of eligible) {
        const preference = prefs.get(`${recipient.id}:UNRESOLVED_OVER_THRESHOLD`);
        const enabled = preference?.enabled ?? preferenceDefaults.UNRESOLVED_OVER_THRESHOLD.enabled;
        const threshold = preference?.thresholdMinutes ?? preferenceDefaults.UNRESOLVED_OVER_THRESHOLD.thresholdMinutes!;
        if (!enabled || ageMinutes < threshold) continue;
        let notification: Awaited<ReturnType<typeof insertNotification>> | undefined;
        try {
          notification = await tx.transaction(async (nested) => insertNotification(nested, { recipientUserId: recipient.id, type: "UNRESOLVED_OVER_THRESHOLD",
            caseId: item.id, payload: { orderNumber: item.orderNumber, ageMinutes, thresholdMinutes: threshold }, dedupeKey: `unresolved:${item.id}:${threshold}` }));
        } catch (error) {
          if (!isMissingRecipientError(error)) throw error;
        }
        if (notification) created += 1;
      }
    }
    return created;
  });
}

export async function getNotifications(auth: AuthContext) {
  const db = getDb();
  const [rows, unread] = await Promise.all([
    db.select({ id: notifications.id, type: notifications.type, caseId: notifications.caseId,
      shortPickLineId: notifications.shortPickLineId, payload: notifications.payload,
      createdAt: notifications.createdAt, readAt: notifications.readAt })
      .from(notifications).where(eq(notifications.recipientUserId, auth.user.id)).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(100),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.recipientUserId, auth.user.id), isNull(notifications.readAt))),
  ]);
  return { notifications: rows, unreadCount: unread[0]?.count ?? 0 };
}

export async function markNotificationRead(auth: AuthContext, notificationId: string) {
  const readAt = new Date();
  const [updated] = await getDb().update(notifications).set({ readAt })
    .where(and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, auth.user.id))).returning({ id: notifications.id, readAt: notifications.readAt });
  if (!updated) throw new CaseApiError("CASE_NOT_FOUND", "Notification not found", 404);
  return { id: updated.id, readAt: updated.readAt };
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
