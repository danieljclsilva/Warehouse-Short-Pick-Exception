import { authenticate } from "@/server/auth";
import { getOperationsDashboard, operationsDashboardQuerySchema } from "@/server/operations";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    const parsed = operationsDashboardQuerySchema.parse({ page, pageSize });
    return Response.json(await getOperationsDashboard(auth, { page: parsed.page, pageSize: parsed.pageSize }));
  } catch (error) { return handleRouteError(error); }
}
