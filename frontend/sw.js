// App-shell service worker. Deliveries are live, frequently-changing data
// (the app polls every 4s), so /api/* is deliberately never cached here —
// only the static shell (HTML/CSS/JS/icons) is, which is what installability
// actually requires and what makes repeat loads fast.

const CACHE_NAME = "reflex-shell-v1";
const APP_SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) return; // let it pass through untouched
  if (url.pathname.startsWith("/api/")) return; // always live, never cached

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      });

      if (cached) {
        networkFetch.catch(() => {}); // refresh the cache in the background; a failure here is fine, we already served `cached`
        return cached;
      }

      // Nothing cached — go to the network; if that fails too (offline),
      // fall back to the cached app shell for a navigation instead of a
      // browser error page.
      return networkFetch.catch(() => {
        if (req.mode === "navigate") return caches.match("/");
        return Response.error();
      });
    })
  );
});
