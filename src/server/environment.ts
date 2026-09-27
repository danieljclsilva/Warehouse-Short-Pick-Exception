export type AppEnvironment = "production" | "test" | "development";

/**
 * Runtime environment for UI differentiation. Explicit `APP_ENV` wins;
 * otherwise Railway's environment name decides (anything that is not the
 * production environment is a test environment). Local runs without Railway
 * variables fall back to `NODE_ENV`. Read at request time, never baked into
 * the client bundle, so Railway variable changes take effect on restart.
 */
export function getAppEnvironment(env: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const explicit = env.APP_ENV?.trim().toLowerCase();
  if (explicit === "production" || explicit === "test" || explicit === "development") return explicit;
  const railway = env.RAILWAY_ENVIRONMENT_NAME?.trim();
  if (railway) return railway === "production" ? "production" : "test";
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}
