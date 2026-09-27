import { z } from "zod";
import { authenticate, changeOwnCredential } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { getSelfProfile, profileUpdateSchema, updateSelfProfile } from "@/server/profile";
import { isPasswordFormat, isPinFormat } from "@/server/security";

export const dynamic = "force-dynamic";

const credentialSchema = z.object({
  credential: z.enum(["PIN", "PASSWORD"]),
  current: z.string().min(1).max(200),
  pin: z.string().max(200, "PIN must contain 6-200 digits").optional(),
  password: z.string().optional(),
}).strict().superRefine((value, context) => {
  if (value.credential === "PIN" && value.password !== undefined) context.addIssue({ code: "custom", message: "Password must not be provided for a PIN change" });
  if (value.credential === "PASSWORD" && value.pin !== undefined) context.addIssue({ code: "custom", message: "PIN must not be provided for a password change" });
  if (value.credential === "PIN" && (value.pin === undefined || value.pin.length === 0)) context.addIssue({ code: "custom", message: "PIN is required" });
  if (value.credential === "PASSWORD" && (value.password === undefined || value.password.length === 0)) context.addIssue({ code: "custom", message: "Password is required" });
});

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json({ profile: await getSelfProfile(auth) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const body: unknown = await request.json().catch(() => null);
    if (body !== null && typeof body === "object" && "credential" in (body as Record<string, unknown>)) {
      const input = credentialSchema.parse(body);
      const next = input.credential === "PIN" ? input.pin! : input.password!;
      if (input.credential === "PIN" && !isPinFormat(next)) return jsonError("PIN must contain 6-200 digits", 400);
      if (input.credential === "PASSWORD" && !isPasswordFormat(next)) return jsonError("Password must be 8-200 characters", 400);
      const result = await changeOwnCredential(auth.user.id, auth.sessionId, input.current, input.credential, next);
      if (result === "LOCKED") return jsonError("Account temporarily locked", 423);
      if (result === "INVALID_CREDENTIAL") return jsonError("Current credential is incorrect", 401);
      if (result === "SESSION_REVOKED") return jsonError("Session is no longer active", 401);
      return Response.json({ profile: await getSelfProfile(auth) }, { headers: { "cache-control": "private, no-store" } });
    }
    const input = profileUpdateSchema.parse(body);
    return Response.json({ profile: await updateSelfProfile(auth, input) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
