// App-shell service worker. Deliveries are live, frequently-changing data
// (the app polls every 4s), so /api/* is deliberately never cached here —
// only the static shell (HTML/CSS/JS/icons) is, which is what installability
// actually requires.
//
// Network-first, not cache-first: each shell file used to be cached and
// served independently (cache-first, revalidate in background), which
// meant index.html and app.js could legitimately end up served from two
// *different* deploys for the same visitor — e.g. app.js referencing a
// DOM element that only exists in a newer index.html than the one still
// cached. That produced a real bug (a missing #id threw and silently
// killed every top-level script statement after it, breaking login and
// the delivery form for anyone hitting it). Network-first means every
// file is fetched fresh together whenever there's connectivity; the cache
// is purely the offline fallback now, never an intentional "serve stale
// while revalidating" path. Bump CACHE_NAME on any future change here to
// force existing installs to drop whatever they cached before this fix.
const CACHE_NAME = "reflex-shell-v2";
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
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      })
      .catch(async () => {
        // Offline (or the request otherwise failed) — this is the only
        // path that ever serves from cache now.
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
