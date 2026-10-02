import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { listPendingProfilePhotos } from "@/server/profile-photos";
import { parsePaginationParams, paginationQuerySchema } from "@/server/pagination";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    const parsed = paginationQuerySchema.parse({ page, pageSize });
    return Response.json(await listPendingProfilePhotos(auth, { page: parsed.page, pageSize: parsed.pageSize }), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
