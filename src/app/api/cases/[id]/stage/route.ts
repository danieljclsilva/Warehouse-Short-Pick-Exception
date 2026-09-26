import { z } from "zod";
import { authenticate } from "@/server/auth";
import { stageCase, stageCaseSchema } from "@/server/case-progress";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    await parseJson(request, stageCaseSchema);
    const { id } = await context.params;
    return Response.json({ case: await stageCase(auth, z.uuid().parse(id)) });
  } catch (error) { return handleRouteError(error); }
}
