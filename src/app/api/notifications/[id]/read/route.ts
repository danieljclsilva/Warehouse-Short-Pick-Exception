import { z } from "zod";
import { authenticate } from "@/server/auth";
import { markNotificationRead } from "@/server/notifications";
import { handleRouteError, jsonError } from "@/server/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    return Response.json(await markNotificationRead(auth, z.uuid().parse(id)));
  } catch (error) { return handleRouteError(error); }
}
