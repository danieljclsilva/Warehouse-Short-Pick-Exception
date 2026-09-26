import { z } from "zod";
import { authenticate } from "@/server/auth";
import { completeCheck, completeCheckSchema } from "@/server/checks";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const input = await parseJson(request, completeCheckSchema);
    return Response.json({ check: await completeCheck(auth, z.uuid().parse(id), input) });
  } catch (error) { return handleRouteError(error); }
}
