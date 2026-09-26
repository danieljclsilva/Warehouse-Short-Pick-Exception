import { z } from "zod";
import { authenticate } from "@/server/auth";
import { confirmRetrieval, retrievalSchema } from "@/server/case-progress";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string; lineId: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, retrievalSchema);
    const { id, lineId } = await context.params;
    return Response.json({ retrieval: await confirmRetrieval(auth, z.uuid().parse(id), z.uuid().parse(lineId), input.result) });
  } catch (error) { return handleRouteError(error); }
}
