/**
 * County Map API Module
 * Handles all API calls for the county map
 */

/**
 * Fetch county topology data (TopoJSON)
 * @returns {Promise<Object>} Topology data
 */
export async function fetchCountyTopology() {
  const response = await fetch("/api/counties/topology");
  const data = await response.json();

  if (!data.success || !data.topology) {
    throw new Error(data.error || "Unable to load county topology");
  }

  return data.topology;
}

/**
 * Fetch visited counties data
 * @returns {Promise<Object>} Visited counties response
 */
export async function fetchVisitedCounties() {
  const response = await fetch("/api/counties/visited");
  return response.json();
}

/**
 * Trigger county recalculation
 * @returns {Promise<Object>} Recalculation response
 */
export async function triggerRecalculation() {
  const response = await fetch("/api/counties/recalculate", {
    method: "POST",
  });
  return response.json();
}

/**
 * Check county cache status
 * @returns {Promise<Object>} Cache status response
 */
export async function fetchCacheStatus() {
  const response = await fetch("/api/counties/cache-status");
  return response.json();
}

// Default export for backward compatibility
const CountyMapAPI = {
  fetchCountyTopology,
  fetchVisitedCounties,
  triggerRecalculation,
  fetchCacheStatus,
};

export default CountyMapAPI;
