import { z } from "zod";
import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { reviewProfilePhoto } from "@/server/profile-photos";

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict().default({});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const body = request.body === null ? {} : await parseJson(request, bodySchema);
    return Response.json(await reviewProfilePhoto(auth, id, "APPROVED", body.reason), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
