import { authenticate } from "@/server/auth";
import { previewRepair, repairCase, repairCaseSchema } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { z } from "zod";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await params;
    const url = new URL(request.url);
    const input = await parseJson(request, repairCaseSchema);
    if (url.searchParams.get("preview") === "1" || input.preview) {
      return Response.json({ repair: await previewRepair(auth, z.uuid().parse(id), input) });
    }
    return Response.json({ repair: await repairCase(auth, z.uuid().parse(id), input) });
  } catch (error) { return handleRouteError(error); }
}
