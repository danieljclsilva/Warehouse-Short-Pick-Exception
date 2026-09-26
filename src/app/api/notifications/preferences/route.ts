import { authenticate } from "@/server/auth";
import { getNotificationPreferences, notificationPreferenceSchema, updateNotificationPreferences } from "@/server/notifications";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await getNotificationPreferences(auth));
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, notificationPreferenceSchema);
    return Response.json(await updateNotificationPreferences(auth, input));
  } catch (error) { return handleRouteError(error); }
}
