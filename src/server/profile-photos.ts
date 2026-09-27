import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, asc, desc, eq, inArray, ne, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, notifications, profilePhotos, pushOutbox, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { CaseApiError } from "@/server/cases";
import { insertNotification } from "@/server/notifications";
import { assertStorageConfigured, getStorage } from "@/server/storage";
import { logServerError } from "@/server/logger";

export const DEFAULT_PROFILE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MULTIPART_OVERHEAD_LIMIT_BYTES = 64 * 1024;
const acceptedInputTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function parseBoundedMultipartFormData(request: Request, maxFileBytes: number) {
  const limit = maxFileBytes + MULTIPART_OVERHEAD_LIMIT_BYTES;
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > limit) throw new CaseApiError("INVALID_INPUT", "Photo upload exceeds the configured size limit", 413);
  if (!request.body) return request.formData();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* Stream cancellation is best effort after enforcing the byte limit. */ }
      throw new CaseApiError("INVALID_INPUT", "Photo upload exceeds the configured size limit", 413);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: "POST", headers: request.headers, body }).formData();
}

export async function normalizeProfilePhoto(input: Uint8Array) {
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000, failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
      throw new Error("Unsupported image format");
    }
    return await image.rotate().resize(512, 512, { fit: "cover", position: "centre" }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  } catch {
    throw new CaseApiError("INVALID_INPUT", "The uploaded file is not a valid supported image", 400);
  }
}

function requirePhotoApprover(auth: AuthContext) {
  if (!hasAuthPermission(auth, "APPROVE_PROFILE_PHOTO")) throw new CaseApiError("CASE_ACCESS_DENIED", "Profile photo approval permission required", 403);
}

export async function uploadProfilePhoto(auth: AuthContext, file: File, maxUploadBytes = DEFAULT_PROFILE_UPLOAD_BYTES) {
  if (!acceptedInputTypes.has(file.type)) throw new CaseApiError("INVALID_INPUT", "Photo must be a JPEG, PNG, or WebP image", 400);
  if (file.size === 0 || file.size > maxUploadBytes) throw new CaseApiError("INVALID_INPUT", "Photo exceeds the configured size limit", 413);
  const input = Buffer.from(await file.arrayBuffer());
  const jpeg = await normalizeProfilePhoto(input);
  let storage;
  try { storage = assertStorageConfigured(); }
  catch { throw new CaseApiError("STORAGE_UNAVAILABLE", "Profile photo storage is unavailable", 503); }
  const objectKey = `profile-photos/${auth.user.id}/${randomUUID()}.jpg`;
  await storage.put(objectKey, jpeg, "image/jpeg");
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.user.id)).limit(1).for("update");
      if (!owner) throw new CaseApiError("CASE_NOT_FOUND", "Profile not found", 404);
      await tx.update(profilePhotos).set({ status: "SUPERSEDED" })
        .where(and(eq(profilePhotos.userId, auth.user.id), ne(profilePhotos.status, "SUPERSEDED")));
      const [last] = await tx.select({ revision: profilePhotos.revision }).from(profilePhotos).where(eq(profilePhotos.userId, auth.user.id))
        .orderBy(desc(profilePhotos.revision)).limit(1);
      const revision = (last?.revision ?? 0) + 1;
      const [photo] = await tx.insert(profilePhotos).values({ userId: auth.user.id, revision, objectKey, contentType: "image/jpeg", byteSize: jpeg.byteLength,
        status: "PENDING", reviewedByUserId: null, reviewedAt: null, reviewReason: null }).returning({ id: profilePhotos.id });
      if (!photo) throw new Error("Profile photo revision was not saved");
      await tx.update(users).set({ profilePhotoStatus: "PENDING", updatedAt: new Date() }).where(eq(users.id, auth.user.id));
      await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: auth.user.id, action: "PROFILE_PHOTO_UPLOADED", details: { photoId: photo.id, revision, status: "PENDING", byteSize: jpeg.byteLength } });
      const approvers = await tx.select({ id: users.id, permissions: users.permissions }).from(users).where(eq(users.status, "ACTIVE"));
      for (const approver of approvers) {
        if (approver.id === auth.user.id || !approver.permissions.includes("APPROVE_PROFILE_PHOTO")) continue;
        await insertNotification(tx, { recipientUserId: approver.id, type: "PROFILE_PHOTO_APPROVAL_REQUIRED",
          payload: { photoOwnerUserId: auth.user.id, photoId: photo.id, revision }, dedupeKey: `profile-photo:${photo.id}` });
      }
    });
  } catch (error) {
    try { await storage.delete(objectKey); }
    catch (deleteError) { logServerError("profile_photo.upload_compensation_failed", deleteError, { area: "profile_photo", userId: auth.user.id, reason: "uploaded object could not be deleted after database failure" }); }
    throw error;
  }
}

export async function getProfilePhoto(auth: AuthContext, userId: string) {
  const db = getDb();
  const [photo] = await db.select({ id: profilePhotos.id, objectKey: profilePhotos.objectKey, contentType: profilePhotos.contentType,
    status: profilePhotos.status, userId: profilePhotos.userId }).from(profilePhotos).where(eq(profilePhotos.userId, userId))
    .orderBy(desc(profilePhotos.revision)).limit(1);
  if (!photo || photo.status === "SUPERSEDED" || (photo.status === "REJECTED" && photo.userId !== auth.user.id)) throw new CaseApiError("CASE_NOT_FOUND", "Profile photo not found", 404);
  if (photo.status !== "APPROVED" && photo.userId !== auth.user.id && !hasAuthPermission(auth, "APPROVE_PROFILE_PHOTO")) {
    throw new CaseApiError("CASE_ACCESS_DENIED", "Profile photo is awaiting approval", 403);
  }
  const storage = getStorage();
  if (!storage) throw new CaseApiError("STORAGE_UNAVAILABLE", "Profile photo storage is unavailable", 503);
  const object = await storage.get(photo.objectKey);
  if (!object) throw new CaseApiError("CASE_NOT_FOUND", "Profile photo not found", 404);
  return { body: object.body, contentType: photo.contentType };
}

export async function listPendingProfilePhotos(auth: AuthContext) {
  requirePhotoApprover(auth);
  const rows = await getDb().select({ id: profilePhotos.id, userId: users.id, displayName: users.displayName,
    createdAt: profilePhotos.createdAt, contentType: profilePhotos.contentType })
    .from(profilePhotos).innerJoin(users, eq(profilePhotos.userId, users.id))
    .where(eq(profilePhotos.status, "PENDING")).orderBy(asc(profilePhotos.createdAt));
  return { photos: rows.map((row) => ({ ...row, photoUrl: `/api/profile/photo?userId=${row.userId}` })) };
}

export async function removeProfilePhoto(auth: AuthContext) {
  const db = getDb();
  const keys = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id, profilePhotoStatus: users.profilePhotoStatus }).from(users).where(eq(users.id, auth.user.id)).limit(1).for("update");
    if (!owner) throw new CaseApiError("CASE_NOT_FOUND", "Profile not found", 404);
    if (owner.profilePhotoStatus === "NONE") return [] as string[];
    const rows = await tx.select({ id: profilePhotos.id, objectKey: profilePhotos.objectKey }).from(profilePhotos)
      .where(and(eq(profilePhotos.userId, auth.user.id), ne(profilePhotos.status, "SUPERSEDED"))).for("update");
    if (rows.length) {
      await tx.update(profilePhotos).set({ status: "SUPERSEDED" })
        .where(and(eq(profilePhotos.userId, auth.user.id), ne(profilePhotos.status, "SUPERSEDED")));
      const photoIds = new Set(rows.map((row) => row.id));
      const pendingApprovalNotifications = await tx.select({ id: notifications.id, payload: notifications.payload })
        .from(notifications).where(eq(notifications.type, "PROFILE_PHOTO_APPROVAL_REQUIRED"));
      const notificationIds = pendingApprovalNotifications
        .filter((notification) => typeof notification.payload.photoId === "string" && photoIds.has(notification.payload.photoId))
        .map((notification) => notification.id);
      if (notificationIds.length) {
        const now = new Date();
        await tx.update(notifications).set({ readAt: now }).where(and(inArray(notifications.id, notificationIds), isNull(notifications.readAt)));
        await tx.update(pushOutbox).set({ status: "DISABLED", leaseUntil: null })
          .where(and(inArray(pushOutbox.notificationId, notificationIds), or(eq(pushOutbox.status, "QUEUED"), eq(pushOutbox.status, "RETRY"))));
      }
    }
    await tx.update(users).set({ profilePhotoStatus: "NONE", updatedAt: new Date() }).where(eq(users.id, auth.user.id));
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: auth.user.id,
      action: "PROFILE_PHOTO_REMOVED", details: { photoIds: rows.map((row) => row.id), revisionCount: rows.length } });
    return rows.map((row) => row.objectKey);
  });
  const storage = getStorage();
  if (storage && keys.length) {
    await Promise.all(keys.map(async (key) => {
      try { await storage.delete(key); }
      catch (error) { logServerError("profile_photo.remove_compensation_failed", error, { area: "profile_photo", userId: auth.user.id, reason: "removed object could not be deleted from storage" }); }
    }));
  }
}

export async function reviewProfilePhoto(auth: AuthContext, photoId: string, decision: "APPROVED" | "REJECTED", reason?: string) {
  requirePhotoApprover(auth);
  const db = getDb();
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ userId: profilePhotos.userId }).from(profilePhotos).where(eq(profilePhotos.id, photoId)).limit(1);
    if (!candidate) throw new CaseApiError("CASE_NOT_FOUND", "Pending profile photo not found", 404);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, candidate.userId)).limit(1).for("update");
    const [photo] = await tx.select().from(profilePhotos).where(and(eq(profilePhotos.id, photoId), eq(profilePhotos.status, "PENDING"))).limit(1).for("update");
    if (!photo) throw new CaseApiError("CASE_NOT_FOUND", "Pending profile photo not found", 404);
    const [current] = await tx.select({ id: profilePhotos.id }).from(profilePhotos).where(eq(profilePhotos.userId, photo.userId))
      .orderBy(desc(profilePhotos.revision)).limit(1);
    if (current?.id !== photo.id) throw new CaseApiError("CASE_NOT_FOUND", "Pending profile photo not found", 404);
    const now = new Date();
    const [updated] = await tx.update(profilePhotos).set({ status: decision, reviewedByUserId: auth.user.id, reviewedAt: now, reviewReason: reason ?? null })
      .where(and(eq(profilePhotos.id, photo.id), eq(profilePhotos.status, "PENDING"))).returning({ id: profilePhotos.id });
    if (!updated) throw new CaseApiError("CASE_NOT_FOUND", "Pending profile photo not found", 404);
    await tx.update(users).set({ profilePhotoStatus: decision, updatedAt: now }).where(eq(users.id, photo.userId));
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: photo.userId,
      action: decision === "APPROVED" ? "PROFILE_PHOTO_APPROVED" : "PROFILE_PHOTO_REJECTED", details: { photoId: photo.id, ...(reason ? { reason } : {}) } });
    const [user] = await tx.select({ id: users.id, displayName: users.displayName, role: users.role, status: users.status,
      preferredLanguage: users.preferredLanguage, profilePhotoStatus: users.profilePhotoStatus }).from(users).where(eq(users.id, photo.userId)).limit(1);
    return { profile: user ? { ...user, photoUrl: decision === "APPROVED" ? `/api/profile/photo?userId=${user.id}` : null } : null };
  });
}
