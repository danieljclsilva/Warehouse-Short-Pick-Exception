"use client";

import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";

import { buildErrorLogHref, errorLogBaseUrl, type ErrorLogItem } from "@/components/error-log-link";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

/** A reported short pick that still has to be logged in the external error log, kept on this device only. */
export type ErrorLogPending = { caseId: string; orderNumber: string; items: ErrorLogItem[]; createdAt: number };
export type ErrorLogPromptEntry = Omit<ErrorLogPending, "createdAt">;

const STORAGE_KEY = "shortpick.errorLogPending";
const CHANGE_EVENT = "shortpick:error-log-pending";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;

function isPending(value: unknown): value is ErrorLogPending {
  const entry = value as ErrorLogPending;
  return Boolean(entry) && typeof entry.caseId === "string" && typeof entry.orderNumber === "string"
    && Array.isArray(entry.items) && typeof entry.createdAt === "number";
}

export function readPending(now = Date.now()): ErrorLogPending[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(isPending).filter((entry) => now - entry.createdAt < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

function writePending(list: ErrorLogPending[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    // Storage can be unavailable (private mode); the reminder is a convenience only.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Adds a case to the reminder list, merging its items with any reminder already held for the same case. */
export function addPending(entry: ErrorLogPromptEntry, now = Date.now()) {
  const list = readPending(now);
  const existing = list.find((item) => item.caseId === entry.caseId);
  if (existing) {
    const keys = new Set(existing.items.map((item) => `${item.location ?? ""}|${item.sku ?? ""}`));
    for (const item of entry.items) if (!keys.has(`${item.location ?? ""}|${item.sku ?? ""}`)) existing.items.push(item);
    writePending(list);
    return;
  }
  writePending([...list, { ...entry, items: [...entry.items], createdAt: now }]);
}

export function removePending(caseId: string) {
  const list = readPending();
  if (list.some((item) => item.caseId === caseId)) writePending(list.filter((item) => item.caseId !== caseId));
}

function usePendingErrorLogs() {
  const [pending, setPending] = useState<ErrorLogPending[]>([]);
  useEffect(() => {
    const sync = () => setPending(readPending());
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return pending;
}

/** Strip listing reported short picks on this device that have not been opened in the error log yet. */
export function ErrorLogReminderStrip({ tr }: { tr: Translator }) {
  const pending = usePendingErrorLogs();
  if (!errorLogBaseUrl || pending.length === 0) return null;
  const title = tr("errorLogPendingTitle", { count: String(pending.length) });
  return (
    <section className="error-log-reminder" aria-label={title}>
      <p>{title}</p>
      <div className="error-log-reminder-links">
        {pending.map((entry) => {
          const href = buildErrorLogHref(errorLogBaseUrl, entry.orderNumber, entry.items, entry.caseId);
          return href ? (
            <a key={entry.caseId} className="secondary-button" href={href} target="_blank" rel="noopener noreferrer" onClick={() => removePending(entry.caseId)}>
              {tr("orderLabel")} {entry.orderNumber}
            </a>
          ) : null;
        })}
      </div>
    </section>
  );
}

/** Asks the reporter to log a just-reported short pick in the error log; "Later" keeps it on the reminder strip. */
export function ErrorLogPrompt({ tr, entry, onDone }: { tr: Translator; entry: ErrorLogPromptEntry | null; onDone: () => void }) {
  const href = entry ? buildErrorLogHref(errorLogBaseUrl, entry.orderNumber, entry.items, entry.caseId) : null;
  useEffect(() => {
    if (!entry || !href) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      addPending(entry);
      onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, href, onDone]);
  if (!entry) return null;
  if (!href) return null;
  const later = () => { addPending(entry); onDone(); };
  return (
    <div className="profile-dialog-backdrop" role="presentation">
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="error-log-prompt-title">
        <h2 id="error-log-prompt-title">{tr("errorLogPromptTitle")}</h2>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={later}>{tr("errorLogLater")}</button>
          <a className="primary-button error-log-now" href={href} target="_blank" rel="noopener noreferrer" autoFocus
            onClick={() => { removePending(entry.caseId); onDone(); }}>{tr("errorLogLogNow")}</a>
        </div>
      </section>
    </div>
  );
}
