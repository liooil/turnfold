const cachePrefix = "turnfold-";
const cacheName = `${cachePrefix}shell-v8`;
const basePath = "__BASE_PATH__";
const shellAssets = [
  "__APP_ROOT__",
  `${basePath}/manifest.webmanifest`,
  `${basePath}/favicon.svg`,
  `${basePath}/icons/icon-192.png`,
  `${basePath}/icons/icon-512.png`,
  `${basePath}/icons/icon-maskable-512.png`,
  `${basePath}/icons/apple-touch-icon.png`
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then(async (cache) => {
    for (const asset of shellAssets) {
      try {
        const response = await fetch(asset, {cache: "reload"});
        if (response.ok) await cache.put(asset, response);
      } catch {}
    }
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith(`${basePath}/api/`) || url.pathname.startsWith("/outpost.goauthentik.io/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const cacheable = response.clone();
        void caches.open(cacheName).then((cache) => cache.put("__APP_ROOT__", cacheable)).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match("__APP_ROOT__")) || Response.error()));
    return;
  }

  if (shellAssets.includes(url.pathname) || /\.(?:js|css|png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const cacheable = response.clone();
        void caches.open(cacheName).then((cache) => cache.put(request, cacheable)).catch(() => {});
      }
      return response;
    })));
  }
});
