import { authenticate } from "@/server/auth";
import { overrideCaseSchema, overrideCaseState } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { z } from "zod";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await params;
    const input = await parseJson(request, overrideCaseSchema);
    return Response.json({ override: await overrideCaseState(auth, z.uuid().parse(id), input) });
  } catch (error) { return handleRouteError(error); }
}
