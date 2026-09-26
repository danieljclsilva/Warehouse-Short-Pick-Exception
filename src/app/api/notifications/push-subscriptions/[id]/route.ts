import { z } from "zod";
import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { assertPushMutationOrigin, removePushSubscription } from "@/server/push";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    assertPushMutationOrigin(request);
    const { id } = await context.params;
    return Response.json(await removePushSubscription(auth, z.uuid().parse(id)));
  } catch (error) { return handleRouteError(error); }
}
