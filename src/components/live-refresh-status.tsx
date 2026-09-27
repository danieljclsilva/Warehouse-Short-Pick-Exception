"use client";

import type { MessageKey } from "@/i18n/messages";
import type { LiveRefreshState } from "./use-live-refresh";

type Props = { state: LiveRefreshState; tr: (key: MessageKey) => string };

export function LiveRefreshStatus({ state, tr }: Props) {
  return (
    <span className={`live-refresh-status live-refresh-${state}`} role="status" aria-live="polite">
      <span className="live-refresh-dot" aria-hidden="true" />
      {tr(state === "stale" ? "realtimeStale" : state === "checking" ? "realtimeChecking" : "realtimeConnected")}
    </span>
  );
}
