import { authenticate } from "@/server/auth";
import { addCaseMessage, messageSchema } from "@/server/operations";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, messageSchema);
    return Response.json({ message: await addCaseMessage(auth, (await params).id, input) }, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
