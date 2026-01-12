/* global clients */

const CACHE_VERSION = "v2";
const API_CACHE = `everystreet-api-${CACHE_VERSION}`;
const TILE_CACHE = `everystreet-tiles-${CACHE_VERSION}`;

const API_PATH_PREFIX = "/api/";
const TILE_HOSTS = new Set(["basemaps.cartocdn.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== API_CACHE && key !== TILE_CACHE) {
            return caches.delete(key);
          }
          return null;
        }),
      );
      await clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/**
 * Network-first for API data, stale-while-revalidate for tiles.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith(API_PATH_PREFIX)
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isTileRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE));
  }
});

function isTileRequest(url) {
  return TILE_HOSTS.has(url.hostname);
}

async function networkFirst(request, timeoutMs = 4000) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (shouldCacheApiResponse(response)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (shouldCacheTileResponse(response)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch((error) => {
      if (cached) {
        return cached;
      }
      throw error;
    });

  return cached || networkPromise;
}

function shouldCacheApiResponse(response) {
  if (!response || !response.ok) {
    return false;
  }
  const cacheControl = response.headers.get("cache-control") || "";
  if (cacheControl.includes("no-store")) {
    return false;
  }
  return true;
}

function shouldCacheTileResponse(response) {
  if (!response) {
    return false;
  }
  if (response.type === "opaque") {
    return true;
  }
  return response.ok;
}

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}
