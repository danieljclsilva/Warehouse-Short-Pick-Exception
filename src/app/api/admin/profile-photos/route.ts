import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { listPendingProfilePhotos } from "@/server/profile-photos";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await listPendingProfilePhotos(auth), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
