import { ZodError } from "zod";

export function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function parseJson<T>(request: Request, schema: { parse: (value: unknown) => T }): Promise<T> {
  const body: unknown = await request.json();
  return schema.parse(body);
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) return jsonError(error.issues[0]?.message ?? "Invalid request", 400);
  if (error instanceof SyntaxError) return jsonError("Invalid JSON body", 400);
  console.error("API request failed", error);
  return jsonError("Internal server error", 500);
}
