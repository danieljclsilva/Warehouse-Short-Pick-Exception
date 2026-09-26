import { authenticate } from "@/server/auth";
import { configurationPatchSchema, getConfigurationForUser, updateConfiguration } from "@/server/configuration";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    return Response.json(await getConfigurationForUser(auth));
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, configurationPatchSchema);
    return Response.json(await updateConfiguration(auth, input));
  } catch (error) { return handleRouteError(error); }
}
