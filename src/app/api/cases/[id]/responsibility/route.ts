import { authenticate } from "@/server/auth";
import { assignCaseResponsibility, caseResponsibilitySchema } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, caseResponsibilitySchema);
    return Response.json(await assignCaseResponsibility(auth, (await params).id, input.userId));
  } catch (error) { return handleRouteError(error); }
}
