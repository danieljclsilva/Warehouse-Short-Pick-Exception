import { getAppEnvironment } from "@/server/environment";

export async function GET() {
  return Response.json(
    { environment: getAppEnvironment() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
