import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { CaseApiError } from "@/server/cases";

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  preferredLanguage: z.enum(["en", "nl", "pl", "es"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide a profile field to update");

export async function getSelfProfile(auth: AuthContext) {
  const db = getDb();
  const [user] = await db.select({ id: users.id, displayName: users.displayName, role: users.role,
    status: users.status, preferredLanguage: users.preferredLanguage, profilePhotoStatus: users.profilePhotoStatus })
    .from(users).where(eq(users.id, auth.user.id)).limit(1);
  if (!user) throw new CaseApiError("CASE_NOT_FOUND", "Profile not found", 404);
  return { ...user, photoUrl: user.profilePhotoStatus === "APPROVED" ? `/api/profile/photo?userId=${user.id}` : null };
}

export async function updateSelfProfile(auth: AuthContext, input: z.infer<typeof profileUpdateSchema>) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ displayName: users.displayName, preferredLanguage: users.preferredLanguage })
      .from(users).where(eq(users.id, auth.user.id)).limit(1);
    if (!current) throw new CaseApiError("CASE_NOT_FOUND", "Profile not found", 404);
    const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => current[key as keyof typeof current] !== value));
    if (!Object.keys(changes).length) return;
    await tx.update(users).set({ ...input, updatedAt: new Date() }).where(eq(users.id, auth.user.id));
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, targetUserId: auth.user.id, action: "PROFILE_UPDATED", details: changes });
  });
  return getSelfProfile(auth);
}
