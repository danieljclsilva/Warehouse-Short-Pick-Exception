"use client";

import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import styles from "./push-settings.module.css";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;
type Device = { id: string; deviceLabel: string; createdAt: string };
type SubscriptionResponse = { enabled?: boolean; publicKey?: string | null; subscriptions?: Device[]; error?: string };
type UpsertResponse = { subscription?: Device; error?: string };
type Props = { tr: Translator; locale?: string };

const messageKeys = {
  title: "pushSettingsTitle",
  description: "pushSettingsDescription",
  loading: "pushSettingsLoading",
  loadError: "pushSettingsLoadError",
  unsupported: "pushNotificationsUnsupported",
  insecure: "pushNotificationsHttpsRequired",
  unavailable: "pushNotificationsUnavailable",
  denied: "pushNotificationsDenied",
  enable: "pushNotificationsEnable",
  enabled: "pushNotificationsEnabled",
  disable: "pushNotificationsDisable",
  devices: "pushNotificationsDevices",
  thisDevice: "pushNotificationsThisDevice",
  otherDevice: "pushNotificationsOtherDevice",
  removeDevice: "pushNotificationsRemoveDevice",
  enableError: "pushNotificationsEnableError",
  disableError: "pushNotificationsDisableError",
  enabledNotice: "pushNotificationsEnabledNotice",
  removedNotice: "pushNotificationsRemovedNotice",
} as const satisfies Record<string, string>;

function trKey(tr: Translator, key: keyof typeof messageKeys) {
  return tr(messageKeys[key] as MessageKey);
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({})) as Promise<T>;
}

function decodeApplicationServerKey(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isPushSupported() {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function PushSettings({ tr, locale = "en" }: Props) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications/push-subscriptions", { credentials: "same-origin", cache: "no-store" });
      const body = await readJson<SubscriptionResponse>(response);
      if (!response.ok) throw new Error(body.error || trKey(tr, "loadError"));
      setEnabled(body.enabled === true);
      setPublicKey(typeof body.publicKey === "string" ? body.publicKey : null);
      setDevices(Array.isArray(body.subscriptions) ? body.subscriptions : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : trKey(tr, "loadError"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      await load();
      if (cancelled || !isPushSupported() || !window.isSecureContext) return;
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        const existing = await registration.pushManager.getSubscription();
        if (!existing || cancelled) return;
        const response = await fetch("/api/notifications/push-subscriptions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(existing.toJSON()),
        });
        const body = await readJson<UpsertResponse>(response);
        if (!response.ok || !body.subscription || cancelled) return;
        setCurrentDeviceId(body.subscription.id);
        setDevices((current) => [body.subscription!, ...current.filter((device) => device.id !== body.subscription!.id)]);
      } catch {
        // Existing browser permission remains usable even when the server is temporarily unavailable.
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, [load]);

  const enablePush = async () => {
    if (!isPushSupported() || !window.isSecureContext || !enabled || !publicKey) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        if (permission === "denied") setError(trKey(tr, "denied"));
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const ready = await navigator.serviceWorker.ready;
      const subscribeOptions: PushSubscriptionOptionsInit = {
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(publicKey) as BufferSource,
      };
      let subscription = await ready.pushManager.getSubscription() || await registration.pushManager.subscribe(subscribeOptions);
      const postSubscription = (value: PushSubscription) => fetch("/api/notifications/push-subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value.toJSON()),
      });
      let response = await postSubscription(subscription);
      if (response.status === 409) {
        await subscription.unsubscribe();
        subscription = await ready.pushManager.subscribe(subscribeOptions);
        response = await postSubscription(subscription);
      }
      const body = await readJson<UpsertResponse>(response);
      if (!response.ok || !body.subscription) throw new Error(body.error || trKey(tr, "enableError"));
      setCurrentDeviceId(body.subscription.id);
      setDevices((current) => [body.subscription!, ...current.filter((device) => device.id !== body.subscription!.id)]);
      setNotice(trKey(tr, "enabledNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : trKey(tr, "enableError"));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (device: Device) => {
    setRemovingId(device.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/notifications/push-subscriptions/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(body.error || trKey(tr, "disableError"));
      if (device.id === currentDeviceId && isPushSupported()) {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe().catch(() => false);
        setCurrentDeviceId(null);
      }
      setDevices((current) => current.filter((item) => item.id !== device.id));
      setNotice(trKey(tr, "removedNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : trKey(tr, "disableError"));
    } finally {
      setRemovingId(null);
    }
  };

  const supportMessage = !isPushSupported()
    ? trKey(tr, "unsupported")
    : !window.isSecureContext
      ? trKey(tr, "insecure")
      : !enabled || !publicKey
        ? trKey(tr, "unavailable")
        : Notification.permission === "denied"
          ? trKey(tr, "denied")
          : "";

  return (
    <section className={styles.panel} aria-labelledby="push-settings-title">
      <header className={styles.header}>
        <div>
          <h2 id="push-settings-title">{trKey(tr, "title")}</h2>
          <p>{trKey(tr, "description")}</p>
        </div>
        {loading ? <span className={styles.loading}>{trKey(tr, "loading")}</span> : null}
      </header>

      {!loading && enabled && publicKey && isPushSupported() && window.isSecureContext && Notification.permission !== "denied" ? (
        <button className={styles.primaryButton} type="button" onClick={() => void enablePush()} disabled={busy}>
          {busy ? trKey(tr, "loading") : currentDeviceId ? trKey(tr, "enabled") : trKey(tr, "enable")}
        </button>
      ) : null}
      {supportMessage ? <p className={styles.help} role="status">{supportMessage}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      {devices.length > 0 ? (
        <div className={styles.deviceGroup}>
          <h3>{trKey(tr, "devices")}</h3>
          <ul className={styles.deviceList}>
            {devices.map((device) => {
              const isCurrent = device.id === currentDeviceId;
              return (
                <li className={styles.device} key={device.id}>
                  <div className={styles.deviceInfo}>
                    <span className={styles.deviceName}>{device.deviceLabel || trKey(tr, isCurrent ? "thisDevice" : "otherDevice")}</span>
                    <time dateTime={device.createdAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(device.createdAt))}</time>
                  </div>
                  <button className={styles.removeButton} type="button" onClick={() => void removeDevice(device)} disabled={removingId === device.id}>
                    {removingId === device.id ? trKey(tr, "loading") : trKey(tr, "removeDevice")}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
