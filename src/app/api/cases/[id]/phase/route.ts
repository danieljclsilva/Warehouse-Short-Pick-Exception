import { z } from "zod";
import { authenticate } from "@/server/auth";
import { phaseCaseSchema, updateCasePhase } from "@/server/case-progress";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, phaseCaseSchema);
    const { id } = await context.params;
    return Response.json({ case: await updateCasePhase(auth, z.uuid().parse(id), input.phase, input.confirmedPhysicalPlacement) });
  } catch (error) { return handleRouteError(error); }
}
