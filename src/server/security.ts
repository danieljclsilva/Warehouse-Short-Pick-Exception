import { createHash, randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";

export const SESSION_COOKIE = "spx_session";
// Browsers commonly cap persistent cookies at 400 days. The server session itself has no expiry.
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const SESSION_COOKIE_OPTIONS = `Path=/; HttpOnly; SameSite=Lax;${process.env.NODE_ENV === "production" ? " Secure;" : ""}`;

export function persistentSessionCookie(token: string, now = Date.now()): string {
  const expires = new Date(now + SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toUTCString();
  return `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE_OPTIONS} Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; Expires=${expires}`;
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function hashPin(pin: string): Promise<string> {
  return hash(pin, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const entry of cookie.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
}
