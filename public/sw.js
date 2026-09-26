self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" && payload.title.length > 0
    ? payload.title
    : "Short Pick update";
  const body = typeof payload.body === "string" && payload.body.length > 0
    ? payload.body
    : "There is an update that may need your attention.";
  const notificationId = typeof payload.notificationId === "string" ? payload.notificationId : null;

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: notificationId ? `shortpick-${notificationId}` : "shortpick-update",
    data: { notificationId },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL("/", self.location.origin);
  destination.searchParams.set("section", "notifications");
  const notificationId = event.notification.data && event.notification.data.notificationId;
  if (typeof notificationId === "string") destination.searchParams.set("notification", notificationId);

  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ("navigate" in client) {
        return client.navigate(destination.href).then((navigated) => navigated ? navigated.focus() : self.clients.openWindow(destination.href));
      }
      return client.focus();
    }
    return self.clients.openWindow(destination.href);
  }));
});
