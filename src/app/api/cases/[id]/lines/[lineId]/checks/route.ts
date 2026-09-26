import { z } from "zod";
import { authenticate } from "@/server/auth";
import { requestAnotherCheck } from "@/server/checks";
import { handleRouteError, jsonError } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string; lineId: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id, lineId } = await context.params;
    const result = await requestAnotherCheck(auth, z.uuid().parse(id), z.uuid().parse(lineId));
    return Response.json({ check: result }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
