"use client";

import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";

export function useIsTestEnvironment(): boolean {
  const [isTest, setIsTest] = useState<boolean | null>(
    () => (process.env.NEXT_PUBLIC_APP_ENV === "test" ? true : null),
  );
  useEffect(() => {
    if (isTest !== null) return;
    let cancelled = false;
    fetch("/api/environment", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { environment?: string } | null) => {
        if (!cancelled) setIsTest(body?.environment ? body.environment !== "production" : false);
      })
      .catch(() => {
        if (!cancelled) setIsTest(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isTest]);
  return isTest === true;
}

export function EnvironmentBanner({ tr }: { tr: (key: MessageKey) => string }) {
  const isTest = useIsTestEnvironment();
  if (!isTest) return null;
  return (
    <div className="environment-banner" role="status">
      {tr("testEnvironmentBanner")}
    </div>
  );
}
