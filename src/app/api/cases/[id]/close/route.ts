import { authenticate } from "@/server/auth";
import { closeCase, closeCaseSchema } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, closeCaseSchema);
    return Response.json(await closeCase(auth, (await params).id, input));
  } catch (error) { return handleRouteError(error); }
}
