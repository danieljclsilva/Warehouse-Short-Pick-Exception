import { authenticate } from "@/server/auth";
import { getNotifications } from "@/server/notifications";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await getNotifications(auth));
  } catch (error) { return handleRouteError(error); }
}

export async function POST() {
  return Response.json({ error: "Use the notification read endpoint" }, { status: 405 });
}
