const CACHE_NAME = "everystreet-ui-v1";
const PAGE_CACHE = "everystreet-pages-v1";
const API_PATTERN = /\/api\//;
const TILE_PATTERN = /basemaps\.cartocdn\.com/;

const PAGE_URLS = [
  "/",
  "/trips",
  "/edit_trips",
  "/settings",
  "/driving-insights",
  "/driver-behavior",
  "/driving-navigation",
  "/coverage-management",
  "/export",
  "/upload",
  "/database-management",
  "/visits",
  "/app-settings",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) => cache.addAll(PAGE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  clients.claim();
});

/**
 * Stale‑While‑Revalidate strategy for tiles and JSON.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (request.url.match(API_PATTERN) || request.url.match(TILE_PATTERN)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const resp = await fetch(request);
    cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || network;
}
