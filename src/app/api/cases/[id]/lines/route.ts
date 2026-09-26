import { authenticate } from "@/server/auth";
import { addCaseLine, addLineSchema } from "@/server/cases";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    const input = await parseJson(request, addLineSchema);
    const line = await addCaseLine(auth, id, input);
    return Response.json({ line }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
