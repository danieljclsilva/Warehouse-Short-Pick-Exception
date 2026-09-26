import { z } from "zod";
import { authenticate } from "@/server/auth";
import { assignRetrieval, assignRetrievalSchema } from "@/server/case-progress";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; lineId: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, assignRetrievalSchema);
    const { id, lineId } = await context.params;
    return Response.json({ retrieval: await assignRetrieval(auth, z.uuid().parse(id), z.uuid().parse(lineId), input.userId) });
  } catch (error) { return handleRouteError(error); }
}
