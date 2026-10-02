import { authenticate, hasAuthPermission } from "@/server/auth";
import { caseListQuerySchema, createCase, createCaseSchema, listCasesForUser } from "@/server/cases";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") === "active" ? "active" : "mine";
    const { page, pageSize } = parsePaginationParams(params);
    const parsed = caseListQuerySchema.parse({ scope, page, pageSize });
    const pageData = await listCasesForUser(auth, parsed.scope, { page: parsed.page, pageSize: parsed.pageSize });
    return Response.json({ ...pageData, items: pageData.cases });
  } catch (error) { return handleRouteError(error); }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    // Picker reports and troubleshooter reports share the same flow; troubleshooters are specialized pickers.
    if (!["PICKER", "TROUBLESHOOTER"].includes(auth.user.role) || !hasAuthPermission(auth, "REPORT_SHORT_PICK")) return jsonError("Forbidden", 403);
    const input = await parseJson(request, createCaseSchema);
    const created = await createCase(auth, input.orderNumber, input.confirmedHistoricalCaseIds, input.firstLine);
    return Response.json({ case: created }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
