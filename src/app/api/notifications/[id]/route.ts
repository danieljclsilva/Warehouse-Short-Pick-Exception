import { z } from "zod";
import { authenticate } from "@/server/auth";
import { getNotificationById } from "@/server/notifications";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { id } = await context.params;
    return Response.json({ notification: await getNotificationById(auth, z.uuid().parse(id)) });
  } catch (error) { return handleRouteError(error); }
}
