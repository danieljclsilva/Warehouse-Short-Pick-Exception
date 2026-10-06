import { authenticate } from "@/server/auth";
import { listCaseHistoryForUser } from "@/server/cases";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    return Response.json(await listCaseHistoryForUser(auth, { page, pageSize }));
  } catch (error) { return handleRouteError(error); }
}
