import { describe, expect, it } from "vitest";
import { getAppEnvironment } from "@/server/environment";

describe("getAppEnvironment", () => {
  it("treats Railway production as production", () => {
    expect(getAppEnvironment({ RAILWAY_ENVIRONMENT_NAME: "production", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("production");
  });

  it("treats any other Railway environment as test", () => {
    expect(getAppEnvironment({ RAILWAY_ENVIRONMENT_NAME: "test", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("test");
  });

  it("respects an explicit APP_ENV override", () => {
    expect(getAppEnvironment({ APP_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "production", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("test");
  });

  it("falls back to NODE_ENV without Railway variables", () => {
    expect(getAppEnvironment({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("production");
    expect(getAppEnvironment({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("development");
  });
});
