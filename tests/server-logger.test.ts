import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError, logServerEvent } from "../src/server/logger";

describe("server logger redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits PIN, token, and cookie fields even when passed accidentally", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    logServerEvent("warn", "auth.login.failed", {
      area: "auth",
      reason: "invalid_credentials",
      pin: "731946",
      sessionToken: "session-secret-value",
      invitationToken: "invite-secret-value",
      cookie: "session=private-cookie-value",
      authorization: "Bearer private-auth-value",
      body: { pin: "nested-pin-value" },
    } as never);

    const output = warning.mock.calls[0]?.[0];
    expect(typeof output).toBe("string");
    expect(JSON.parse(String(output))).toMatchObject({ event: "auth.login.failed", area: "auth", reason: "invalid_credentials" });
    for (const secret of ["731946", "session-secret-value", "invite-secret-value", "private-cookie-value", "private-auth-value", "nested-pin-value"]) {
      expect(String(output)).not.toContain(secret);
    }
  });

  it("redacts secret assignments from allowed fields and never writes exception messages or stacks", () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("failed with PIN=731946 and cookie=session-cookie-value; token=url-secret");
    error.stack = "Error: sessionToken=stack-secret-value";

    logServerEvent("warn", "workflow.conflict", { reason: "PIN=731946", route: "/api/cases?token=query-secret" });
    logServerError("api.request.failed", error, { area: "api", status: 500 });

    const warningOutput = String(warningLog.mock.calls[0]?.[0]);
    const errorOutput = String(errorLog.mock.calls[0]?.[0]);
    for (const secret of ["731946", "query-secret", "session-cookie-value", "url-secret", "stack-secret-value"]) {
      expect(warningOutput + errorOutput).not.toContain(secret);
    }
    expect(JSON.parse(errorOutput)).toMatchObject({ event: "api.request.failed", errorType: "Error", area: "api", status: 500 });
  });
});
