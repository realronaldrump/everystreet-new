/**
 * County Map API Module
 * Handles all API calls for the county map
 */

import apiClient from "../core/api-client.js";

/**
 * Fetch county topology data (TopoJSON)
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Topology data
 */
export async function fetchCountyTopology(options = {}) {
  const { signal } = options;
  const data = await apiClient.get("/api/counties/topology", { signal });

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
  return apiClient.get("/api/counties/visited", { signal });
}

/**
 * Trigger county recalculation
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Recalculation response
 */
export function triggerRecalculation(options = {}) {
  const { signal } = options;
  return apiClient.post("/api/counties/recalculate", null, { signal });
}

/**
 * Check county cache status
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} Cache status response
 */
export function fetchCacheStatus(options = {}) {
  const { signal } = options;
  return apiClient.get("/api/counties/cache-status", { signal });
}
