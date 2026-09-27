import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { closeDb, getDb } from "../src/db";
import { analyticsReports, auditLog, notifications, profilePhotos, sessions, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { persistAnalyticsReport } from "../src/server/analytics-report-storage";
import { reviewProfilePhoto, uploadProfilePhoto } from "../src/server/profile-photos";
import { setStorageForTests, resetStorageConfigurationForTests, type ObjectStorage } from "../src/server/storage";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeDatabase("profile photo revisions and durable object compensation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  const photoIds: string[] = [];
  const reportIds: string[] = [];
  const notificationsIds: string[] = [];
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const storage: ObjectStorage = {
    async put(key, body, contentType) { objects.set(key, { body, contentType }); },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) { objects.delete(key); },
  };
  let picker: Awaited<ReturnType<typeof createUser>>;
  let approver: Awaited<ReturnType<typeof createUser>>;
  const imageFile = async () => new File([await sharp({ create: { width: 16, height: 12, channels: 3, background: "#a24" } }).png().toBuffer()], "profile.png", { type: "image/png" });

  async function createUser(role: Role, label: string) {
    const [row] = await getDb().insert(users).values({ identifier: `profile-${suffix}-${label}`, displayName: `Profile ${label}`, pinHash: "test-only-unused", role, permissions: defaultPermissions(role) }).returning();
    userIds.push(row!.id);
    return { ...row!, auth: { user: { id: row!.id, displayName: row!.displayName, loginIdentifier: row!.identifier, role: row!.role,
      preferredLanguage: row!.preferredLanguage, permissions: row!.permissions }, sessionId: "test-session" } };
  }

  beforeAll(async () => {
    picker = await createUser("PICKER", "picker");
    approver = await createUser("TEAM_LEADER", "approver");
  });

  beforeEach(() => setStorageForTests(storage));

  afterAll(async () => {
    const db = getDb();
    if (reportIds.length) await db.delete(analyticsReports).where(inArray(analyticsReports.id, reportIds));
    if (photoIds.length) await db.delete(profilePhotos).where(inArray(profilePhotos.id, photoIds));
    if (notificationsIds.length) await db.delete(notifications).where(inArray(notifications.id, notificationsIds));
    if (userIds.length) await db.delete(auditLog).where(inArray(auditLog.targetUserId, userIds));
    if (userIds.length) await db.delete(sessions).where(inArray(sessions.userId, userIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    objects.clear();
    resetStorageConfigurationForTests();
    await closeDb();
  });

  it("serializes competing upload/review operations, preserves revisions, and notifies each upload", async () => {
    await uploadProfilePhoto(picker!.auth, await imageFile());
    const revisionOne = await getDb().select().from(profilePhotos).where(eq(profilePhotos.userId, picker!.id));
    photoIds.push(...revisionOne.map((row) => row.id));
    expect(revisionOne).toHaveLength(1);

    const concurrent = await Promise.allSettled([
      uploadProfilePhoto(picker!.auth, await imageFile()),
      reviewProfilePhoto(approver!.auth, revisionOne[0]!.id, "APPROVED"),
    ]);
    expect(concurrent[0]!.status).toBe("fulfilled");
    const revisions = await getDb().select().from(profilePhotos).where(eq(profilePhotos.userId, picker!.id)).orderBy(profilePhotos.revision);
    photoIds.push(...revisions.map((row) => row.id).filter((id) => !photoIds.includes(id)));
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ revision: 2, status: "PENDING" });
    expect(revisions[0]!.status).toBe("SUPERSEDED");
    if (concurrent[1]!.status === "fulfilled") expect(concurrent[1]!.value.profile?.profilePhotoStatus).toBe("APPROVED");
    else expect(concurrent[1]!.reason).toMatchObject({ code: "CASE_NOT_FOUND" });

    await expect(reviewProfilePhoto(approver!.auth, revisions[0]!.id, "APPROVED")).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
    const stillPending = await getDb().select({ status: profilePhotos.status }).from(profilePhotos).where(eq(profilePhotos.id, revisions[1]!.id));
    expect(stillPending[0]!.status).toBe("PENDING");

    const routed = await getDb().select({ id: notifications.id, dedupeKey: notifications.dedupeKey }).from(notifications)
      .where(and(eq(notifications.recipientUserId, approver!.id), eq(notifications.type, "PROFILE_PHOTO_APPROVAL_REQUIRED")));
    notificationsIds.push(...routed.map((row) => row.id));
    expect(routed).toHaveLength(2);
    expect(new Set(routed.map((row) => row.dedupeKey)).size).toBe(2);
  });

  it("deletes profile and report objects when their database metadata writes fail", async () => {
    const missingAuth = { ...picker!.auth, user: { ...picker!.auth.user, id: randomUUID() } };
    const existingObjects = [...objects.keys()].sort();
    await expect(uploadProfilePhoto(missingAuth, await imageFile())).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
    expect([...objects.keys()].sort()).toEqual(existingObjects);

    await expect(persistAnalyticsReport(missingAuth, "test.pdf", {}, new Uint8Array([37, 80, 68, 70]))).rejects.toBeDefined();
    expect([...objects.keys()].sort()).toEqual(existingObjects);
  });
});
