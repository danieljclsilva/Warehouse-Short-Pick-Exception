import { authenticate } from "@/server/auth";
import { recordReplenishment, replenishmentSchema } from "@/server/case-progress";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { z } from "zod";

type Context = { params: Promise<{ id: string; lineId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id, lineId } = await params;
    const input = await parseJson(request, replenishmentSchema);
    return Response.json(
      { replenishment: await recordReplenishment(auth, z.uuid().parse(id), z.uuid().parse(lineId), input) },
      { status: 201 },
    );
  } catch (error) { return handleRouteError(error); }
}
