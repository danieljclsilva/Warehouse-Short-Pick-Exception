import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { closeDb, getDb } from "../src/db";
import { auditLog, configurationVersions, notifications, pushOutbox, pushSubscriptions, sessions, users } from "../src/db/schema";
import { defaultPermissions } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as notificationsPost } from "../src/app/api/notifications/push-subscriptions/route";
import { GET as notificationsGet } from "../src/app/api/notifications/push-subscriptions/route";
import { DELETE as notificationsDelete } from "../src/app/api/notifications/push-subscriptions/[id]/route";
import { insertNotification } from "../src/server/notifications";
import { deliverPushBatch } from "../src/server/push";
import { getMessages, translate } from "../src/i18n/messages";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describeDatabase("Web Push subscriptions and durable outbox", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  let userId = "";
  let otherUserId = "";
  let cookie = "";
  let otherCookie = "";
  let vapidPublic = "";
  let vapidPrivate = "";
  const originalEnv = { publicKey: process.env.PUSH_PUBLIC_KEY, privateKey: process.env.PUSH_PRIVATE_KEY, subject: process.env.PUSH_SUBJECT };
  const endpointOne = `https://fcm.googleapis.com/fcm/send/${suffix}-one`;
  const endpointTwo = `https://updates.push.services.mozilla.com/wpush/v2/${suffix}-two`;
  let originalConfiguration: Record<string, unknown>;

  beforeAll(async () => {
    const [current] = await getDb().select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    originalConfiguration = current!.values as Record<string, unknown>;
    await getDb().insert(configurationVersions).values({ version: current!.version + 1,
      values: { ...originalConfiguration, WORKING_HOURS_DAYS: [1, 2, 3, 4, 5, 6, 7], WORKING_HOURS_START: "00:00", WORKING_HOURS_END: "23:59" } });
    const keys = webpush.generateVAPIDKeys();
    vapidPublic = keys.publicKey; vapidPrivate = keys.privateKey;
    process.env.PUSH_PUBLIC_KEY = vapidPublic;
    process.env.PUSH_PRIVATE_KEY = vapidPrivate;
    process.env.PUSH_SUBJECT = "mailto:warehouse@example.com";
    const [user] = await getDb().insert(users).values({ identifier: `push-${suffix}-one`, displayName: "Push One",
      pinHash: await hashPin("123456"), role: "PICKER", permissions: defaultPermissions("PICKER") }).returning();
    const [other] = await getDb().insert(users).values({ identifier: `push-${suffix}-two`, displayName: "Push Two",
      pinHash: await hashPin("123456"), role: "PICKER", permissions: defaultPermissions("PICKER") }).returning();
    userId = user!.id; otherUserId = other!.id; userIds.push(userId, otherUserId);
    cookie = (await createSession(userId)).cookie.split(";")[0]!;
    otherCookie = (await createSession(otherUserId)).cookie.split(";")[0]!;
  });

  afterAll(async () => {
    vi.useRealTimers();
    const db = getDb();
    const [current] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    await db.insert(configurationVersions).values({ version: current!.version + 1, values: originalConfiguration });
    await db.delete(pushOutbox).where(inArray(pushOutbox.subscriptionId, (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds))).map((row) => row.id)));
    await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds));
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    if (originalEnv.publicKey === undefined) delete process.env.PUSH_PUBLIC_KEY; else process.env.PUSH_PUBLIC_KEY = originalEnv.publicKey;
    if (originalEnv.privateKey === undefined) delete process.env.PUSH_PRIVATE_KEY; else process.env.PUSH_PRIVATE_KEY = originalEnv.privateKey;
    if (originalEnv.subject === undefined) delete process.env.PUSH_SUBJECT; else process.env.PUSH_SUBJECT = originalEnv.subject;
    await closeDb();
  });

  const subscriptionBody = (endpoint: string) => ({ endpoint, expirationTime: null,
    keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }, deviceLabel: "Warehouse phone" });

  it("rejects private or unapproved endpoints and keeps secrets out of the response", async () => {
    const crossOrigin = await notificationsPost(new Request("http://localhost/api/notifications/push-subscriptions", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie }, body: JSON.stringify(subscriptionBody(endpointOne)),
    }));
    expect(crossOrigin.status).toBe(403);
    const invalid = await notificationsPost(request("/api/notifications/push-subscriptions", "POST", subscriptionBody("https://127.0.0.1/push"), cookie));
    expect(invalid.status).toBe(400);
    const created = await notificationsPost(request("/api/notifications/push-subscriptions", "POST", subscriptionBody(endpointOne), cookie));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ subscription: expect.objectContaining({ deviceLabel: "Warehouse phone", id: expect.any(String), createdAt: expect.any(String) }) });
    const listed = await notificationsGet(request("/api/notifications/push-subscriptions", "GET", undefined, cookie));
    const body = await listed.json();
    expect(body).toMatchObject({ enabled: true, publicKey: vapidPublic });
    expect(body.subscriptions[0]).not.toHaveProperty("endpoint");
    expect(body.subscriptions[0]).not.toHaveProperty("keys");
  });

  it("supports multiple devices, ownership isolation, and one-device removal", async () => {
    const created = await notificationsPost(request("/api/notifications/push-subscriptions", "POST", subscriptionBody(endpointTwo), cookie));
    const subscriptionId = (await created.json()).subscription.id as string;
    expect((await notificationsDelete(request(`/api/notifications/push-subscriptions/${subscriptionId}`, "DELETE", undefined, otherCookie), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(404);
    expect((await notificationsDelete(request(`/api/notifications/push-subscriptions/${subscriptionId}`, "DELETE", undefined, cookie), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    const listed = await notificationsGet(request("/api/notifications/push-subscriptions", "GET", undefined, cookie));
    expect((await listed.json()).subscriptions).toHaveLength(1);
  });

  it("creates outbox rows atomically and disables or retries only the affected delivery", async () => {
    const created = await notificationsPost(request("/api/notifications/push-subscriptions", "POST", subscriptionBody(endpointTwo), cookie));
    await created.json();
    const [notification] = await getDb().transaction(async (tx) => [await insertNotification(tx, { recipientUserId: userId, type: "NEW_SHORT_PICK", payload: {} })]);
    const outbox = await getDb().select().from(pushOutbox).where(eq(pushOutbox.notificationId, notification!.id));
    expect(outbox).toHaveLength(2);

    const send = vi.spyOn(webpush, "sendNotification")
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockResolvedValue({ statusCode: 201 } as never);
    const disabled = await deliverPushBatch(10);
    expect(disabled.disabled).toBe(1);
    const [disabledRow] = await getDb().select().from(pushOutbox).where(and(eq(pushOutbox.notificationId, notification!.id), eq(pushOutbox.status, "DISABLED")));
    const [subscription] = await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.id, disabledRow!.subscriptionId));
    expect(subscription?.disabledAt).toEqual(expect.any(Date));

    const [retrySubscription] = await getDb().insert(pushSubscriptions).values({ userId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-retry`, p256dh: "C".repeat(87), auth: "D".repeat(22), deviceLabel: "Retry device" }).returning();
    const [retryNotification] = await getDb().transaction(async (tx) => [await insertNotification(tx, { recipientUserId: userId, type: "CASE_RESOLVED", payload: {} })]);
    const retryRow = (await getDb().select().from(pushOutbox).where(and(eq(pushOutbox.notificationId, retryNotification!.id), eq(pushOutbox.subscriptionId, retrySubscription!.id))))[0]!;
    send.mockReset().mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }));
    const retried = await deliverPushBatch(10);
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    const [retryState] = await getDb().select().from(pushOutbox).where(eq(pushOutbox.id, retryRow.id));
    expect(retryState?.status).toBe("RETRY");
    await getDb().update(pushOutbox).set({ availableAt: new Date(0) }).where(eq(pushOutbox.id, retryRow.id));
    send.mockReset().mockResolvedValue({ statusCode: 201 } as never);
    await deliverPushBatch(10);
    const [sent] = await getDb().select().from(pushOutbox).where(eq(pushOutbox.id, retryRow.id));
    expect(sent?.status).toBe("SENT");
    send.mockRestore();
  });

  it("delivers using the recipient's saved language at claim time", async () => {
    const db = getDb();
    const notification = await db.transaction((tx) => insertNotification(tx, {
      recipientUserId: userId, type: "RESPONSIBILITY_CHECK_ASSIGNED", payload: {},
    }));
    expect(notification).toBeTruthy();
    await db.update(users).set({ preferredLanguage: "pl" }).where(eq(users.id, userId));
    const send = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201 } as never);
    try {
      await deliverPushBatch(100);
      const payloads = send.mock.calls.map((call) => JSON.parse(String(call[1])) as Record<string, unknown>)
        .filter((payload) => payload.notificationId === notification!.id);
      const { messages } = getMessages("pl");
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(payload).toEqual({ notificationId: notification!.id,
          title: translate(messages, "notificationCheckAssigned"),
          body: translate(messages, "pushNotificationBody") });
      }
    } finally {
      send.mockRestore();
      await db.update(users).set({ preferredLanguage: "en" }).where(eq(users.id, userId));
    }
  });

  it("returns zeros without throwing when PUSH_ENABLED=false", async () => {
    const db = getDb();
    const [current] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    expect(current).toBeTruthy();
    const originalValues = current!.values as Record<string, unknown>;
    // History rows are immutable (UPDATE/DELETE blocked), but INSERT of a new
    // version is the supported write path. Push the flag off, verify the
    // short-circuit, then restore with a follow-up version so later suites
    // still see the original effective configuration.
    const [disabled] = await db.insert(configurationVersions)
      .values({ version: current!.version + 1, values: { ...originalValues, PUSH_ENABLED: false } }).returning();
    expect(disabled).toBeTruthy();
    let result;
    try {
      result = await deliverPushBatch(10);
    } finally {
      await db.insert(configurationVersions)
        .values({ version: disabled!.version + 1, values: originalValues });
    }
    expect(result).toMatchObject({ attempted: 0, sent: 0, retried: 0, disabled: 0, failed: 0 });
    const [restored] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    expect((restored!.values as Record<string, unknown>).PUSH_ENABLED).toBe(originalValues.PUSH_ENABLED);
  });

  it("does not deliver during warm-up or after hours, and suppresses earlier-shift alerts without disabling devices", async () => {
    const db = getDb();
    const [current] = await db.select().from(configurationVersions).orderBy(desc(configurationVersions.version)).limit(1);
    const [shift] = await db.insert(configurationVersions).values({ version: current!.version + 1,
      values: { ...(current!.values as Record<string, unknown>), WORKING_HOURS_DAYS: [1, 2, 3, 4, 5], WORKING_HOURS_START: "08:00", WORKING_HOURS_END: "17:00" } }).returning();
    const [subscription] = await db.insert(pushSubscriptions).values({ userId, endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}-shift`, p256dh: "C".repeat(87), auth: "D".repeat(22) }).returning();
    const [notification] = await db.insert(notifications).values({ recipientUserId: userId, type: "NEW_SHORT_PICK", createdAt: new Date("2026-10-11T18:00:00Z") }).returning();
    const [outbox] = await db.insert(pushOutbox).values({ notificationId: notification!.id, subscriptionId: subscription!.id, availableAt: new Date(0) }).returning();
    const send = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201 } as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const instant of ["2026-10-12T05:45:00Z", "2026-10-12T15:00:00Z", "2026-10-17T08:00:00Z"]) {
        vi.setSystemTime(new Date(instant));
        expect((await deliverPushBatch(100)).attempted).toBe(0);
      }
      expect(send).not.toHaveBeenCalled();
      expect((await db.select().from(pushOutbox).where(eq(pushOutbox.id, outbox!.id)))[0]!.status).toBe("QUEUED");
      vi.setSystemTime(new Date("2026-10-12T06:00:00Z"));
      await deliverPushBatch(100);
      expect(send).not.toHaveBeenCalled();
      expect((await db.select().from(pushOutbox).where(eq(pushOutbox.id, outbox!.id)))[0]).toMatchObject({ status: "DISABLED", leaseUntil: null });
      expect((await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, subscription!.id)))[0]!.disabledAt).toBeNull();
      expect((await db.select().from(notifications).where(eq(notifications.id, notification!.id)))[0]!.readAt).toBeNull();
      const fresh = await db.insert(notifications).values([0, 1].map(() => ({ recipientUserId: userId,
        type: "NEW_SHORT_PICK" as const, createdAt: new Date("2026-10-12T06:00:00Z") }))).returning();
      await db.insert(pushOutbox).values(fresh.map((item) => ({ notificationId: item.id, subscriptionId: subscription!.id, availableAt: new Date(0) })));
      send.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
        return { statusCode: 201 } as never;
      });
      expect(await deliverPushBatch(100)).toMatchObject({ attempted: 2, sent: 1, disabled: 1 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      send.mockRestore();
      await db.insert(configurationVersions).values({ version: shift!.version + 1, values: current!.values });
    }
  });
});
