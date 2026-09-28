import { authenticate } from "@/server/auth";
import { markAllNotificationsRead } from "@/server/notifications";
import { handleRouteError, jsonError } from "@/server/http";

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await markAllNotificationsRead(auth));
  } catch (error) { return handleRouteError(error); }
}
