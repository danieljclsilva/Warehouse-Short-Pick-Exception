import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { assertPushMutationOrigin, isPushConfigured, listPushSubscriptions, pushStatus, pushSubscriptionSchema, registerPushSubscription } from "@/server/push";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await listPushSubscriptions(auth));
  } catch (error) { return handleRouteError(error); }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    assertPushMutationOrigin(request);
    if (!isPushConfigured()) return Response.json({ ...pushStatus(), error: "Push notifications are not configured" }, { status: 503 });
    return Response.json(await registerPushSubscription(auth, await parseJson(request, pushSubscriptionSchema)), { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
