import type { ErrorLogItem } from "@/components/error-log-link";

export type ErrorLogPending = { caseId: string; orderNumber: string; items: ErrorLogItem[]; createdAt: number };
export type ErrorLogPromptEntry = Omit<ErrorLogPending, "createdAt">;
export const ERROR_LOG_CHANGE_EVENT = "shortpick:error-log-pending";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;
const keyFor = (userId: string) => `shortpick.errorLogPending.v2.${encodeURIComponent(userId)}`;

const validText = (value: unknown, max = 128): value is string => typeof value === "string" && value.length <= max;
function isItem(value: unknown): value is ErrorLogItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (item.location == null || validText(item.location)) && (item.sku == null || validText(item.sku));
}
function isPending(value: unknown): value is ErrorLogPending {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return validText(entry.caseId) && Boolean(entry.caseId) && validText(entry.orderNumber)
    && Array.isArray(entry.items) && entry.items.every(isItem)
    && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt);
}
const itemKey = (item: ErrorLogItem) => JSON.stringify([item.location ?? "", item.sku ?? ""]);

export function readPending(userId: string, now = Date.now()): ErrorLogPending[] {
  if (!userId) return [];
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(keyFor(userId)) || "[]");
    return Array.isArray(raw) ? raw.filter(isPending).filter((entry) => entry.createdAt <= now && now - entry.createdAt < MAX_AGE_MS).slice(-MAX_ENTRIES) : [];
  } catch { return []; }
}
function writePending(userId: string, list: ErrorLogPending[]) {
  if (!userId) return;
  try { window.localStorage.setItem(keyFor(userId), JSON.stringify(list.slice(-MAX_ENTRIES))); }
  catch { /* Reminders are optional when browser storage is unavailable. */ }
  window.dispatchEvent(new Event(ERROR_LOG_CHANGE_EVENT));
}
export function discardUnscopedPending() {
  // The old shared-device format has no owner, so it cannot be safely migrated.
  try { window.localStorage.removeItem("shortpick.errorLogPending"); } catch { /* optional storage */ }
}
export function clearPending(userId: string) {
  try { window.localStorage.removeItem(keyFor(userId)); } catch { /* optional storage */ }
  window.dispatchEvent(new Event(ERROR_LOG_CHANGE_EVENT));
}
export function addPending(userId: string, entry: ErrorLogPromptEntry, now = Date.now()) {
  const list = readPending(userId, now);
  const existing = list.find((item) => item.caseId === entry.caseId);
  const items = [...(existing?.items ?? []), ...entry.items];
  const seen = new Set<string>();
  writePending(userId, [...list.filter((item) => item.caseId !== entry.caseId), {
    ...entry, items: items.filter((item) => { const key = itemKey(item); if (seen.has(key)) return false; seen.add(key); return true; }), createdAt: now,
  }]);
}
export function removePending(userId: string, caseId: string) {
  writePending(userId, readPending(userId).filter((item) => item.caseId !== caseId));
}
/** Opening a prompt only handles its own items, preserving earlier deferred lines. */
export function removePendingItems(userId: string, entry: ErrorLogPromptEntry) {
  const handled = new Set(entry.items.map(itemKey));
  writePending(userId, readPending(userId).flatMap((pending) => {
    if (pending.caseId !== entry.caseId) return [pending];
    const items = pending.items.filter((item) => !handled.has(itemKey(item)));
    return items.length ? [{ ...pending, items }] : [];
  }));
}
