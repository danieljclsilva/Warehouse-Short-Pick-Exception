import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError, parseJson } from "@/server/http";
import { getSelfProfile, profileUpdateSchema, updateSelfProfile } from "@/server/profile";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json({ profile: await getSelfProfile(auth) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, profileUpdateSchema);
    return Response.json({ profile: await updateSelfProfile(auth, input) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
