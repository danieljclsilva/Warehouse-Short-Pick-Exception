import { authenticate } from "@/server/auth";
import { checkListQuerySchema, listChecks } from "@/server/checks";
import { handleRouteError, jsonError } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const params = new URL(request.url).searchParams;
    const parsed = checkListQuerySchema.parse({
      scope: params.get("scope") === "mine" || params.get("scope") === "active" ? params.get("scope") : "available",
      cursor: params.get("cursor") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });
    const page = await listChecks(auth, parsed.scope, { cursor: parsed.cursor, limit: parsed.limit });
    return Response.json({ checks: page.items, items: page.items, nextCursor: page.nextCursor, total: page.total });
  } catch (error) { return handleRouteError(error); }
}
