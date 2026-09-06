const CACHE_NAME = "nexus-ark-lite-travel-phase5-v23";
const ASSETS = [
  "/",
  "/",
  "/manifest.webmanifest",
  "/static/styles.css?v=86",
  "/static/app.js?v=86",
  "/static/pairing-handoff.js?v=86",
  "/static/lite-continuity-state.js?v=86",
  "/static/travel-adapter.js?v=86",
  "/icon.png",
  "/icon-maskable.png",
  "/badge.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        if (event.request.method === "GET" && response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text?.() || "" };
  }
  const title = payload.title || "Nexus Ark Lite";
  const options = {
    body: payload.body || "通知を受信しました。",
    icon: "/icon.png",
    badge: "/badge.png",
    tag: payload.tag || "nexus-ark-lite-web-push",
    data: {
      url: payload.url || new URL("/", self.location.origin).href
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || new URL("/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const url = new URL(client.url);
        if (url.pathname.startsWith("/")) {
          return client.focus();
        }
      }
      return clients.openWindow(new URL(targetUrl, self.location.origin).href);
    })
  );
});
