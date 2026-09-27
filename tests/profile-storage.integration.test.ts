import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { closeDb, getDb } from "../src/db";
import { analyticsReports, auditLog, notifications, profilePhotos, sessions, users } from "../src/db/schema";
import { defaultPermissions, type Role } from "../src/domain/permissions";
import { deleteAnalyticsReport, getAnalyticsReport, listAnalyticsReports, persistAnalyticsReport } from "../src/server/analytics-report-storage";
import { removeProfilePhoto, reviewProfilePhoto, uploadProfilePhoto } from "../src/server/profile-photos";
import { setStorageForTests, resetStorageConfigurationForTests, type ObjectStorage } from "../src/server/storage";

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeDatabase("profile photo revisions and durable object compensation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const userIds: string[] = [];
  const photoIds: string[] = [];
  const reportIds: string[] = [];
  const notificationsIds: string[] = [];
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  let failObjectDelete = false;
  const storage: ObjectStorage = {
    async put(key, body, contentType) { objects.set(key, { body, contentType }); },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) { if (failObjectDelete) throw new Error("test storage delete failure"); objects.delete(key); },
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

  beforeEach(() => { failObjectDelete = false; setStorageForTests(storage); });

  afterAll(async () => {
    const db = getDb();
    if (reportIds.length) await db.delete(analyticsReports).where(inArray(analyticsReports.id, reportIds));
    if (userIds.length) await db.delete(profilePhotos).where(inArray(profilePhotos.userId, userIds));
    else if (photoIds.length) await db.delete(profilePhotos).where(inArray(profilePhotos.id, photoIds));
    if (notificationsIds.length) await db.delete(notifications).where(inArray(notifications.id, notificationsIds));
    if (userIds.length) await db.delete(auditLog).where(inArray(auditLog.targetUserId, userIds));
    if (userIds.length) await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
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

  it("removes the owner's photo, closes pending approval notifications, retains audit history, and does not require an operational permission", async () => {
    await uploadProfilePhoto(picker!.auth, await imageFile());
    const [photo] = await getDb().select().from(profilePhotos)
      .where(eq(profilePhotos.userId, picker!.id)).orderBy(desc(profilePhotos.revision)).limit(1);
    photoIds.push(photo!.id);
    const notificationRows = await getDb().select({ id: notifications.id, payload: notifications.payload })
      .from(notifications).where(and(eq(notifications.recipientUserId, approver!.id), eq(notifications.type, "PROFILE_PHOTO_APPROVAL_REQUIRED")));
    const approval = notificationRows.find((row) => row.payload.photoId === photo!.id);
    expect(approval).toBeDefined();
    notificationsIds.push(approval!.id);

    const noOperationalPermissions = { ...picker!.auth, user: { ...picker!.auth.user, permissions: [] as string[] } };
    await expect(removeProfilePhoto(noOperationalPermissions)).resolves.toBeUndefined();

    const [removedPhoto] = await getDb().select().from(profilePhotos).where(eq(profilePhotos.id, photo!.id));
    const [owner] = await getDb().select({ profilePhotoStatus: users.profilePhotoStatus }).from(users).where(eq(users.id, picker!.id));
    const [closedNotification] = await getDb().select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, approval!.id));
    expect(removedPhoto!.status).toBe("SUPERSEDED");
    expect(owner!.profilePhotoStatus).toBe("NONE");
    expect(closedNotification!.readAt).toBeInstanceOf(Date);
    expect(objects.has(photo!.objectKey)).toBe(false);

    const removals = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "PROFILE_PHOTO_REMOVED"), eq(auditLog.actorUserId, picker!.id)));
    expect(removals.some((entry) => Array.isArray(entry.details.photoIds) && entry.details.photoIds.includes(photo!.id))).toBe(true);
    await expect(reviewProfilePhoto(approver!.auth, photo!.id, "APPROVED")).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
  });

  it("deletes profile and report objects when their database metadata writes fail", async () => {
    const missingAuth = { ...picker!.auth, user: { ...picker!.auth.user, id: randomUUID() } };
    const existingObjects = [...objects.keys()].sort();
    await expect(uploadProfilePhoto(missingAuth, await imageFile())).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
    expect([...objects.keys()].sort()).toEqual(existingObjects);

    await expect(persistAnalyticsReport(missingAuth, "test.pdf", {}, new Uint8Array([37, 80, 68, 70]))).rejects.toBeDefined();
    expect([...objects.keys()].sort()).toEqual(existingObjects);
  });

  it("denies retained report persistence without EXPORT_ANALYTICS", async () => {
    const denied = { ...picker!.auth, user: { ...picker!.auth.user, permissions: [] as string[] } };
    await expect(persistAnalyticsReport(denied, "denied.pdf", {}, new Uint8Array([37, 80, 68, 70]))).rejects.toMatchObject({ code: "CASE_ACCESS_DENIED" });
    await expect(deleteAnalyticsReport(denied, randomUUID())).rejects.toMatchObject({ code: "CASE_ACCESS_DENIED" });
  });

  it("persists and deletes a retained report with audit events", async () => {
    const reportId = await persistAnalyticsReport(approver!.auth, "retained.pdf", { phase: "PICKING" }, new Uint8Array([37, 80, 68, 70]));
    reportIds.push(reportId!);
    const [report] = await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!));
    expect(report).toMatchObject({ filename: "retained.pdf", byteSize: 4 });
    expect(objects.has(report!.objectKey)).toBe(true);
    expect((await listAnalyticsReports(approver!.auth)).reports.some((row) => row.id === reportId)).toBe(true);
    const generated = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "ANALYTICS_REPORT_GENERATED"), eq(auditLog.actorUserId, approver!.id)));
    expect(generated.some((entry) => typeof entry.details === "object" && entry.details !== null && "reportId" in entry.details && entry.details.reportId === reportId)).toBe(true);

    const nonOwnerExporter = { ...picker!.auth, user: { ...picker!.auth.user, permissions: ["EXPORT_ANALYTICS"] } };
    await expect(deleteAnalyticsReport(nonOwnerExporter, reportId!)).rejects.toMatchObject({ code: "CASE_ACCESS_DENIED", status: 403 });
    await expect(getAnalyticsReport(nonOwnerExporter, reportId!)).rejects.toMatchObject({ code: "CASE_ACCESS_DENIED", status: 403 });
    expect((await listAnalyticsReports(nonOwnerExporter)).reports).toHaveLength(0);
    expect(await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!))).toHaveLength(1);

    reportIds.splice(reportIds.indexOf(reportId!), 1);
    const deleted = await deleteAnalyticsReport(approver!.auth, reportId!);
    expect(deleted).toEqual({ id: reportId });
    expect(await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!))).toHaveLength(0);
    expect(objects.has(report!.objectKey)).toBe(false);
    const removed = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "ANALYTICS_REPORT_DELETED"), eq(auditLog.actorUserId, approver!.id)));
    expect(removed.some((entry) => typeof entry.details === "object" && entry.details !== null && "reportId" in entry.details && entry.details.reportId === reportId)).toBe(true);
    await expect(deleteAnalyticsReport(approver!.auth, reportId!)).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
  });

  it("keeps report metadata when object deletion fails and allows a successful retry", async () => {
    const reportId = await persistAnalyticsReport(approver!.auth, "retry-delete.pdf", {}, new Uint8Array([37, 80, 68, 70]));
    reportIds.push(reportId!);
    const [report] = await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!));

    failObjectDelete = true;
    await expect(deleteAnalyticsReport(approver!.auth, reportId!)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 });
    expect(await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!))).toHaveLength(1);
    expect(objects.has(report!.objectKey)).toBe(true);
    const beforeRetry = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "ANALYTICS_REPORT_DELETED"), eq(auditLog.actorUserId, approver!.id)));
    expect(beforeRetry.some((entry) => entry.details.reportId === reportId)).toBe(false);

    failObjectDelete = false;
    expect(await deleteAnalyticsReport(approver!.auth, reportId!)).toEqual({ id: reportId });
    reportIds.splice(reportIds.indexOf(reportId!), 1);
    expect(await getDb().select().from(analyticsReports).where(eq(analyticsReports.id, reportId!))).toHaveLength(0);
    expect(objects.has(report!.objectKey)).toBe(false);
  });

  it("paginates owned retained reports in bounded pages", async () => {
    const inserted = await getDb().insert(analyticsReports).values(Array.from({ length: 51 }, (_, index) => ({
      generatedByUserId: approver!.id,
      objectKey: `analytics-reports/${approver!.id}/pagination-${suffix}-${index}.pdf`,
      filename: `pagination-${index}.pdf`, filters: {}, byteSize: 64,
    }))).returning({ id: analyticsReports.id });
    reportIds.push(...inserted.map((row) => row.id));

    const first = await listAnalyticsReports(approver!.auth);
    expect(first.reports).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await listAnalyticsReports(approver!.auth, first.nextCursor!);
    expect(second.reports).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.reports, ...second.reports].map((report) => report.id)).size).toBe(51);
    expect([...first.reports, ...second.reports].every((report) => inserted.some((row) => row.id === report.id))).toBe(true);
  });
});
