/**
 * County Map API Module
 * Handles all API calls for the unified county/state/city coverage page.
 */

import apiClient from "../core/api-client.js";

function withQuery(path, params = {}) {
  const baseOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost";
  const url = new URL(path, baseOrigin);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return `${url.pathname}${url.search}`;
}

/**
 * Fetch county topology data (TopoJSON)
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Topology data
 */
export async function fetchCountyTopology(options = {}) {
  const { signal } = options;
  const path = withQuery("/api/geo-coverage/topology", { level: "county" });
  const data = await apiClient.get(path, { signal });

  if (!data.success || !data.topology) {
    throw new Error(data.error || "Unable to load county topology");
  }

  return data.topology;
}

/**
 * Fetch visited counties data
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Visited counties response
 */
export function fetchVisitedCounties(options = {}) {
  const { signal } = options;
  const path = withQuery("/api/geo-coverage/visits", { level: "county" });
  return apiClient.get(path, { signal });
}

/**
 * Trigger unified geo recalculation
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Recalculation response
 */
export function triggerRecalculation(options = {}) {
  const { signal } = options;
  return apiClient.post("/api/geo-coverage/recalculate", null, { signal });
}

/**
 * Check geo coverage cache status
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Cache status response
 */
export function fetchCacheStatus(options = {}) {
  const { signal } = options;
  return apiClient.get("/api/geo-coverage/cache-status", { signal });
}

/**
 * Fetch cross-level summary.
 * @param {{signal?: AbortSignal}} [options]
 */
export function fetchSummary(options = {}) {
  const { signal } = options;
  return apiClient.get("/api/geo-coverage/summary", { signal });
}

/**
 * Fetch state topology for state mode.
 * @param {{signal?: AbortSignal}} [options]
 */
export function fetchStateTopology(options = {}) {
  const { signal } = options;
  const path = withQuery("/api/geo-coverage/topology", { level: "state" });
  return apiClient.get(path, { signal });
}

/**
 * Fetch city topology for selected state.
 * @param {string} stateFips
 * @param {{signal?: AbortSignal}} [options]
 */
export function fetchCityTopology(stateFips, options = {}) {
  const { signal } = options;
  const path = withQuery("/api/geo-coverage/topology", {
    level: "city",
    stateFips,
  });
  return apiClient.get(path, { signal });
}

/**
 * Fetch city visits for selected state.
 * @param {string} stateFips
 * @param {{signal?: AbortSignal}} [options]
 */
export function fetchCityVisits(stateFips, options = {}) {
  const { signal } = options;
  const path = withQuery("/api/geo-coverage/visits", {
    level: "city",
    stateFips,
  });
  return apiClient.get(path, { signal });
}

/**
 * Fetch paginated city rows.
 * @param {{stateFips: string, status?: string, q?: string, sort?: string, page?: number, pageSize?: number, signal?: AbortSignal}} options
 */
export function fetchCities(options = {}) {
  const {
    stateFips,
    status = "all",
    q,
    sort = "name",
    page = 1,
    pageSize = 100,
    signal,
  } = options;
  const path = withQuery("/api/geo-coverage/cities", {
    stateFips,
    status,
    q,
    sort,
    page,
    pageSize,
  });
  return apiClient.get(path, { signal });
}
