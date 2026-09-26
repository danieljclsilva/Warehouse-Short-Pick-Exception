import { authenticate } from "@/server/auth";
import { createManualCase, manualCaseSchema } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, manualCaseSchema);
    return Response.json({ case: await createManualCase(auth, input) }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
