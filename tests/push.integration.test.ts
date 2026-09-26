import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { closeDb, getDb } from "../src/db";
import { auditLog, notifications, pushOutbox, pushSubscriptions, sessions, users } from "../src/db/schema";
import { defaultPermissions } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { POST as notificationsPost } from "../src/app/api/notifications/push-subscriptions/route";
import { GET as notificationsGet } from "../src/app/api/notifications/push-subscriptions/route";
import { DELETE as notificationsDelete } from "../src/app/api/notifications/push-subscriptions/[id]/route";
import { insertNotification } from "../src/server/notifications";
import { deliverPushBatch } from "../src/server/push";

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

  beforeAll(async () => {
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
    const db = getDb();
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
});
