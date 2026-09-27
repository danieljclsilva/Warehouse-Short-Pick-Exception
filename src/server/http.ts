import { ZodError } from "zod";
import { CaseApiError } from "./cases";
import { logServerError, logServerEvent } from "./logger";

export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function parseJson<T>(request: Request, schema: { parse: (value: unknown) => T }): Promise<T> {
  const body: unknown = await request.json();
  return schema.parse(body);
}

export function handleRouteError(error: unknown) {
  if (error instanceof CaseApiError) {
    if (error.status === 409) logServerEvent("warn", "workflow.conflict", { area: "api", code: error.code, status: error.status });
    else if (error.status >= 500) logServerEvent("error", "api.request.failed", { area: "api", code: error.code, status: error.status });
    return Response.json({ error: error.message, code: error.code, ...error.data }, { status: error.status });
  }
  if (error instanceof ZodError) return jsonError(error.issues[0]?.message ?? "Invalid request", 400);
  if (error instanceof SyntaxError) return jsonError("Invalid JSON body", 400);
  logServerError("api.request.failed", error, { area: "api", status: 500 });
  return jsonError("Internal server error", 500);
}
