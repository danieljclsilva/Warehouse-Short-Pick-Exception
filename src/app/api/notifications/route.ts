import { authenticate } from "@/server/auth";
import { getNotifications, notificationListQuerySchema } from "@/server/notifications";
import { handleRouteError, jsonError } from "@/server/http";
import { parsePaginationParams } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { page, pageSize } = parsePaginationParams(new URL(request.url).searchParams, 50);
    const parsed = notificationListQuerySchema.parse({ page, pageSize });
    return Response.json(await getNotifications(auth, { page: parsed.page, pageSize: parsed.pageSize }));
  } catch (error) { return handleRouteError(error); }
}

export async function POST() {
  return Response.json({ error: "Use the notification read endpoint" }, { status: 405 });
}
