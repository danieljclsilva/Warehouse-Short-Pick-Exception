export type ServerLogLevel = "info" | "warn" | "error";

export type ServerLogContext = {
  area?: string;
  route?: string;
  code?: string;
  reason?: string;
  outcome?: string;
  status?: number;
  errorType?: string;
  issueCode?: string;
  userId?: string;
  caseId?: string;
  lineId?: string;
  checkId?: string;
  notificationId?: string;
  outboxId?: string;
  reportId?: string;
  attemptCount?: number;
  lockoutMinutes?: number;
};

const safeContextKeys = new Set<keyof ServerLogContext>([
  "area", "route", "code", "reason", "outcome", "status", "errorType", "issueCode", "userId", "caseId", "lineId", "checkId",
  "notificationId", "outboxId", "reportId", "attemptCount", "lockoutMinutes",
]);

const secretAssignment = /\b(pin|session(?:[_ -]?token)?|invitation(?:[_ -]?token)?|invite(?:[_ -]?token)?|token|cookie|set-cookie|authorization|password|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const authorizationValue = /\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const querySecret = /([?&](?:pin|token|cookie|authorization|password|secret)=[^&#\s]*)/gi;

function redactText(value: string) {
  return value
    .replace(authorizationValue, "$1 [REDACTED]")
    .replace(secretAssignment, "$1=[REDACTED]")
    .replace(querySecret, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 300);
}

function safeEventName(value: string) {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : "security.redacted";
}

function safeContext(context: ServerLogContext) {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!safeContextKeys.has(key as keyof ServerLogContext)) continue;
    if (typeof value === "string") safe[key] = redactText(value);
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

/** Writes compact JSON logs while excluding request bodies, headers, and exception messages. */
export function logServerEvent(level: ServerLogLevel, event: string, context: ServerLogContext = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: safeEventName(event),
    ...safeContext(context),
  };
  console[level](JSON.stringify(record));
}

/** Log an exception's type only; messages and stacks can contain request secrets or SQL parameters. */
export function logServerError(event: string, error: unknown, context: ServerLogContext = {}) {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  logServerEvent("error", event, { ...context, errorType });
}
