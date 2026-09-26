import { authenticate } from "@/server/auth";
import { getCaseForUser } from "@/server/cases";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    return Response.json({ case: await getCaseForUser(auth, id) });
  } catch (error) { return handleRouteError(error); }
}
