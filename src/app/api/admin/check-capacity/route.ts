import { authenticate } from "@/server/auth";
import { checkLimitSchema, setCheckLimit } from "@/server/checks";
import { getConfigurationForUser } from "@/server/configuration";
import { handleRouteError, jsonError, parseJson } from "@/server/http";

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const configuration = await getConfigurationForUser(auth);
    return Response.json({ maxSimultaneousChecksPerCase: configuration.values.MAX_SIMULTANEOUS_CHECKS_PER_CASE });
  } catch (error) { return handleRouteError(error); }
}

export async function PUT(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const input = await parseJson(request, checkLimitSchema);
    return Response.json({ maxSimultaneousChecksPerCase: await setCheckLimit(auth, input.maxSimultaneousChecksPerCase) });
  } catch (error) { return handleRouteError(error); }
}
