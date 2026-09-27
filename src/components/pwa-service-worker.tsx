"use client";

import { useEffect } from "react";

export function PwaServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // The app remains fully usable without service worker support or registration.
    });
  }, []);

  return null;
}
