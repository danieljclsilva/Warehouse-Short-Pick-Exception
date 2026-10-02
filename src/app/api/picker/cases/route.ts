import { authenticate } from "@/server/auth";
import { caseListQuerySchema, listCasesForUser } from "@/server/cases";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams);
    const parsed = caseListQuerySchema.parse({ scope: "mine" as const, page, pageSize });
    const pageData = await listCasesForUser(auth, "mine", { page: parsed.page, pageSize: parsed.pageSize });
    return Response.json({ ...pageData, items: pageData.cases });
  } catch (error) { return handleRouteError(error); }
}
