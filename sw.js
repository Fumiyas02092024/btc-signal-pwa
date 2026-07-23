const CACHE_NAME = "btc-regime-watch-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./strategy.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "BTCシグナルが更新されました" };
  }

  const title = payload.title || "BTC Regime Watch";
  const options = {
    body: payload.body || "確定足の判定が更新されました",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: payload.tag || "btc-regime-watch",
    renotify: Boolean(payload.renotify),
    requireInteraction: payload.state === "READY",
    timestamp: payload.timestamp || Date.now(),
    data: {
      url: payload.url || "./",
      state: payload.state,
    },
    actions: [
      { action: "open", title: "判定を見る" },
      { action: "dismiss", title: "閉じる" },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const target = new URL(event.notification.data?.url || "./", self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (new URL(client.url).origin === new URL(target).origin) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("pushsubscriptionchange", event => {
  // VAPID鍵を含む再購読にはアプリ側設定が必要なため、次回起動時にUIで再設定を促します。
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      clients.forEach(client => client.postMessage({ type: "PUSH_SUBSCRIPTION_EXPIRED" }));
    }),
  );
});
