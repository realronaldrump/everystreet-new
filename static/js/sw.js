/* global clients */

const CACHE_NAME = "everystreet-ui-v1";
const API_PATTERN = /\/api\//;
const TILE_PATTERN = /basemaps\.cartocdn\.com/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", () => {
  clients.claim();
});

/**
 * Stale‑While‑Revalidate strategy for tiles and JSON.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (!API_PATTERN.test(request.url) && !TILE_PATTERN.test(request.url)) return;

  event.respondWith(staleWhileRevalidate(request));
});

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
