/**
 * County Map API Module
 * Handles all API calls for the county map
 */

import apiClient from "../core/api-client.js";

/**
 * Fetch county topology data (TopoJSON)
 * @returns {Promise<Object>} Topology data
 */
export async function fetchCountyTopology() {
  const data = await apiClient.get("/api/counties/topology");

  if (!data.success || !data.topology) {
    throw new Error(data.error || "Unable to load county topology");
  }

  return data.topology;
}

/**
 * Fetch visited counties data
 * @returns {Promise<Object>} Visited counties response
 */
export function fetchVisitedCounties() {
  return apiClient.get("/api/counties/visited");
}

/**
 * Trigger county recalculation
 * @returns {Promise<Object>} Recalculation response
 */
export function triggerRecalculation() {
  return apiClient.post("/api/counties/recalculate");
}

/**
 * Check county cache status
 * @returns {Promise<Object>} Cache status response
 */
export function fetchCacheStatus() {
  return apiClient.get("/api/counties/cache-status");
}
