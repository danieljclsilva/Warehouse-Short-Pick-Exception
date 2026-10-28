"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { MessageKey } from "@/i18n/messages";
import { buildErrorLogHref, errorLogBaseUrl } from "@/components/error-log-link";
import { addPending, discardUnscopedPending, ERROR_LOG_CHANGE_EVENT, readPending, removePending, removePendingItems, type ErrorLogPending, type ErrorLogPromptEntry } from "@/components/error-log-storage";
export type { ErrorLogPromptEntry } from "@/components/error-log-storage";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;
const ErrorLogUserContext = createContext<string>("");
const ErrorLogUserNameContext = createContext<string>("");
export const useErrorLogUser = () => useContext(ErrorLogUserContext);
/** Display name of the signed-in user, passed to the error log as "logged by". */
export const useErrorLogUserName = () => useContext(ErrorLogUserNameContext);

export function ErrorLogUserScope({ userId, displayName = "", children }: { userId: string; displayName?: string; children: ReactNode }) {
  useEffect(() => {
    discardUnscopedPending();
  }, [userId]);
  return (
    <ErrorLogUserContext.Provider value={userId}>
      <ErrorLogUserNameContext.Provider value={displayName}>{children}</ErrorLogUserNameContext.Provider>
    </ErrorLogUserContext.Provider>
  );
}

function usePendingErrorLogs(userId: string) {
  const [pending, setPending] = useState<ErrorLogPending[]>([]);
  useEffect(() => {
    const sync = () => setPending(readPending(userId));
    sync();
    window.addEventListener(ERROR_LOG_CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    // Expire reminders while the screen remains open, too.
    const timer = window.setInterval(sync, 60_000);
    return () => {
      window.removeEventListener(ERROR_LOG_CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
      window.clearInterval(timer);
    };
  }, [userId]);
  return pending;
}

export function ErrorLogReminderStrip({ tr }: { tr: Translator }) {
  const userId = useErrorLogUser();
  const userName = useErrorLogUserName();
  const pending = usePendingErrorLogs(userId);
  const linked = pending.flatMap((entry) => {
    const href = buildErrorLogHref(errorLogBaseUrl, entry.orderNumber, entry.items, entry.caseId, userName);
    return href ? [{ entry, href }] : [];
  });
  if (!userId || linked.length === 0) return null;
  const title = tr("errorLogPendingTitle", { count: String(linked.length) });
  return <section className="error-log-reminder" aria-label={title}>
    <p>{title}</p>
    <div className="error-log-reminder-links">{linked.map(({ entry, href }) => (
      <a key={entry.caseId} className="secondary-button" href={href} target="_blank" rel="noopener noreferrer" onClick={() => removePending(userId, entry.caseId)}>
        {tr("orderLabel")} {entry.orderNumber}
      </a>
    ))}</div>
  </section>;
}

export function ErrorLogPrompt({ tr, entry, onDone }: { tr: Translator; entry: ErrorLogPromptEntry | null; onDone: () => void }) {
  const userId = useErrorLogUser();
  const userName = useErrorLogUserName();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });
  const href = entry ? buildErrorLogHref(errorLogBaseUrl, entry.orderNumber, entry.items, entry.caseId, userName) : null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!entry || !href || !userId || !dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus();
      else dialog.parentElement?.querySelector<HTMLElement>(".add-line-button")?.focus();
    };
  }, [entry, href, userId]);
  if (!entry || !href || !userId) return null;
  const later = () => { addPending(userId, entry); doneRef.current(); };
  return <dialog ref={dialogRef} className="profile-dialog error-log-dialog" aria-labelledby="error-log-prompt-title"
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); later(); }}>
    <h2 id="error-log-prompt-title">{tr("errorLogPromptTitle")}</h2>
    <div className="dialog-actions">
      <button className="secondary-button" type="button" autoFocus onClick={later}>{tr("errorLogLater")}</button>
      <a className="primary-button error-log-now" href={href} target="_blank" rel="noopener noreferrer" onClick={() => { removePendingItems(userId, entry); doneRef.current(); }}>{tr("errorLogLogNow")}</a>
    </div>
  </dialog>;
}
