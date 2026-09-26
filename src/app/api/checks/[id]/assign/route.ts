import { z } from "zod";
import { authenticate } from "@/server/auth";
import { assignCheck, assignCheckSchema } from "@/server/checks";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const input = await parseJson(request, assignCheckSchema);
    return Response.json({ check: await assignCheck(auth, z.uuid().parse(id), input.userId) });
  } catch (error) { return handleRouteError(error); }
}
