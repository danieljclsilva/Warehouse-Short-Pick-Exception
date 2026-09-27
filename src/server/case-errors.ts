export type CaseApiErrorCode = "OPEN_CASE_EXISTS" | "OPEN_CASE_NOT_ACCESSIBLE" | "HISTORICAL_CONFIRMATION_REQUIRED" | "DUPLICATE_LINE" | "CASE_NOT_FOUND" | "CASE_NOT_OPEN" | "CASE_ACCESS_DENIED" | "DUPLICATE_OVERRIDE_FORBIDDEN" | "CHECK_NOT_AVAILABLE" | "CHECK_CAPACITY_REACHED" | "RETRIEVAL_NOT_PENDING" | "CASE_NOT_CLOSABLE" | "CASE_REOPEN_CONFLICT" | "CONFIGURATION_VERSION_CONFLICT" | "INVALID_ANALYTICS_FILTER";

export class CaseApiError extends Error {
  constructor(readonly code: CaseApiErrorCode, message: string, readonly status = 409, readonly data: Record<string, unknown> = {}) { super(message); }
}
