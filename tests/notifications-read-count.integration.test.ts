import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { closeDb, getDb } from "../src/db";
import { auditLog, notificationPreferences, notifications, sessions, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { createSession } from "../src/server/auth";
import { hashPin } from "../src/server/security";
import { GET as getByIdRoute } from "../src/app/api/notifications/[id]/route";
import { POST as readRoute } from "../src/app/api/notifications/[id]/read/route";
import { GET as listRoute } from "../src/app/api/notifications/route";
import { POST as readAllRoute } from "../src/app/api/notifications/read-all/route";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const request = (path: string, method: string, body?: unknown, cookie?: string) => new Request(`http://localhost${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ReadShape = z.object({ id: z.string(), readAt: z.string().nullable(), unreadCount: z.number() });
const ListShape = z.object({
  notifications: z.array(z.object({ id: z.string(), readAt: z.string().nullable() })),
  unreadCount: z.number(), page: z.number().optional(), pageSize: z.number().optional(), total: z.number().optional(),
});
const ByIdShape = z.object({ notification: z.object({ id: z.string(), caseId: z.string().nullable(), shortPickLineId: z.string().nullable(), readAt: z.string().nullable() }) });

describeDatabase("F8/F14 notification read count and exact lookup", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  let readerCookie = "";
  let readerId = "";
  let otherCookie = "";
  let otherId = "";
  let readTargetId = "";
  async function makeUser(role: Role, name: string) {
    const [user] = await getDb().insert(users).values({
      identifier: `notify-f8f14-${suffix}-${name}`, displayName: name,
      pinHash: await hashPin("123456"), role, permissions: defaultPermissions(role),
    }).returning();
    userIds.push(user!.id);
    return user!;
  }

  beforeAll(async () => {
    const reader = await makeUser("PICKER", "reader");
    const other = await makeUser("PICKER", "other");
    readerId = reader.id;
    otherId = other.id;
    readerCookie = (await createSession(reader.id)).cookie.split(";")[0]!;
    otherCookie = (await createSession(other.id)).cookie.split(";")[0]!;
    await getDb().insert(notifications).values(Array.from({ length: 80 }, (_, index) => ({
      recipientUserId: readerId, type: "NEW_SHORT_PICK" as const, caseId: null, shortPickLineId: null,
      payload: { orderNumber: `f8f14-${suffix}-${index}` }, dedupeKey: `f8f14-${suffix}-${readerId}-${index}`,
    })));
    await getDb().insert(notifications).values([{
      recipientUserId: otherId, type: "NEW_SHORT_PICK" as const, caseId: null, shortPickLineId: null,
      payload: { orderNumber: `f8f14-${suffix}-foreign` }, dedupeKey: `f8f14-${suffix}-${otherId}-foreign`,
    }]);
  });

  afterAll(async () => {
    const db = getDb();
    if (userIds.length) {
      await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
      await db.delete(notifications).where(inArray(notifications.recipientUserId, userIds));
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await closeDb();
  });

  it("marks one of 80 unread as read with a global 79 count, including page-2 IDs", async () => {
    const page2 = await listRoute(request("/api/notifications?page=2&pageSize=50", "GET", undefined, readerCookie));
    expect(page2.status).toBe(200);
    const page2Body = ListShape.parse(await page2.json());
    expect(page2Body.unreadCount).toBe(80);
    expect(page2Body.notifications.length).toBeGreaterThan(0);
    const target = page2Body.notifications[0]!;
    readTargetId = target.id;
    const read = await readRoute(request(`/api/notifications/${target.id}/read`, "POST", undefined, readerCookie), { params: Promise.resolve({ id: target.id }) });
    expect(read.status).toBe(200);
    expect(ReadShape.parse(await read.json())).toMatchObject({ id: target.id, unreadCount: 79 });
    const fresh = await listRoute(request("/api/notifications?page=2&pageSize=50", "GET", undefined, readerCookie));
    expect(ListShape.parse(await fresh.json()).unreadCount).toBe(79);
  });

  it("preserves readAt and count on idempotent reread", async () => {
    if (!readTargetId) throw new Error("expected a read target");
    const first = await readRoute(request(`/api/notifications/${readTargetId}/read`, "POST", undefined, readerCookie), { params: Promise.resolve({ id: readTargetId }) });
    const second = await readRoute(request(`/api/notifications/${readTargetId}/read`, "POST", undefined, readerCookie), { params: Promise.resolve({ id: readTargetId }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = ReadShape.parse(await first.json());
    const secondBody = ReadShape.parse(await second.json());
    expect(secondBody).toMatchObject({ id: readTargetId, readAt: firstBody.readAt, unreadCount: 79 });
  });

  it("resolves an exact recipient notification by ID and denies foreign/unknown IDs the same way", async () => {
    const page = await listRoute(request("/api/notifications?page=1&pageSize=50", "GET", undefined, readerCookie));
    const own = ListShape.parse(await page.json()).notifications.find((row) => row.readAt === null);
    if (!own) throw new Error("expected an unread row");
    const found = await getByIdRoute(request(`/api/notifications/${own.id}`, "GET", undefined, readerCookie), { params: Promise.resolve({ id: own.id }) });
    expect(ByIdShape.parse(await found.json()).notification.id).toBe(own.id);

    const foreignRow = (await getDb().select({ id: notifications.id }).from(notifications).where(eq(notifications.recipientUserId, otherId)).limit(1))[0]!;
    const foreignRead = await readRoute(request(`/api/notifications/${foreignRow.id}/read`, "POST", undefined, readerCookie), { params: Promise.resolve({ id: foreignRow.id }) });
    expect(foreignRead.status).toBe(404);
    const foreignGet = await getByIdRoute(request(`/api/notifications/${foreignRow.id}`, "GET", undefined, readerCookie), { params: Promise.resolve({ id: foreignRow.id }) });
    expect(foreignGet.status).toBe(404);
    expect((await foreignRead.json()).error).toBe((await foreignGet.json()).error);

    const unknownId = randomUUID();
    const unknownRead = await readRoute(request(`/api/notifications/${unknownId}/read`, "POST", undefined, readerCookie), { params: Promise.resolve({ id: unknownId }) });
    const unknownGet = await getByIdRoute(request(`/api/notifications/${unknownId}`, "GET", undefined, readerCookie), { params: Promise.resolve({ id: unknownId }) });
    expect(unknownRead.status).toBe(404);
    expect(unknownGet.status).toBe(404);
    expect((await unknownRead.json()).error).toBe((await unknownGet.json()).error);
    expect(await otherUnread()).toBe(1);
  });

  it("keeps mark-all recipient scoped and idempotent", async () => {
    const first = await readAllRoute(request("/api/notifications/read-all", "POST", undefined, readerCookie));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ updated: 79, unreadCount: 0 });
    const second = await readAllRoute(request("/api/notifications/read-all", "POST", undefined, readerCookie));
    expect(await second.json()).toEqual({ updated: 0, unreadCount: 0 });
    expect(await otherUnread()).toBe(1);
  });

  async function otherUnread() {
    const response = await listRoute(request("/api/notifications", "GET", undefined, otherCookie));
    return ListShape.parse(await response.json()).unreadCount;
  }
});
