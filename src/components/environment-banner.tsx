"use client";

import type { MessageKey } from "@/i18n/messages";

export function shouldShowTestBanner(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_APP_ENV === "test";
}

export function EnvironmentBanner({ tr }: { tr: (key: MessageKey) => string }) {
  if (!shouldShowTestBanner()) return null;
  return (
    <div className="environment-banner" role="status">
      {tr("testEnvironmentBanner")}
    </div>
  );
}
