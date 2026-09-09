/**
 * Insights API Module (ES6)
 * Handles all API calls for the driving insights page
 */

import apiClient from "../core/api-client.js";

/**
 * Fetch driving insights data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Insights data
 */
function fetchInsights(params, signal) {
  return apiClient.get(`/api/driving-insights?${params}`, { cache: true, signal });
}

/**
 * Fetch trip analytics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Analytics data
 */
function fetchAnalytics(params, signal) {
  return apiClient.get(`/api/trip-analytics?${params}`, { cache: true, signal });
}

/**
 * Fetch metrics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Metrics data
 */
function fetchMetrics(params, signal) {
  return apiClient.get(`/api/metrics?${params}`, { cache: true, signal });
}

/**
 * Fetch trips for a specific time period
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Array>} Trip data
 */
export function fetchTimePeriodTrips(params, signal) {
  return apiClient.get(`/api/time-period-trips?${params}`, { signal });
}

/**
 * Fetch trips for a drill-down modal (sorted/filtered server-side)
 * @param {URLSearchParams} params - Query parameters (start_date, end_date, kind, limit)
 * @returns {Promise<Array>} Trip data
 */
export function fetchDrilldownTrips(params, signal) {
  return apiClient.get(`/api/drilldown-trips?${params}`, { signal });
}

/**
 * Load all data for the insights page
 * @param {Object} dateRange - Date range object with start and end
 * @returns {Promise<Object>} All fetched data
 */
export async function loadAllData(dateRange, signal) {
  const params = new URLSearchParams({
    start_date: dateRange.start,
    end_date: dateRange.end,
  });

  params.set("include_movement", "false");
  const [insights, analytics, metrics] = await Promise.all([
    fetchInsights(params, signal),
    fetchAnalytics(params, signal),
    fetchMetrics(params, signal),
  ]);

  return {
    current: { insights, analytics, metrics },
  };
}

export function fetchMovement(dateRange, signal) {
  const params = new URLSearchParams({
    start_date: dateRange.start,
    end_date: dateRange.end,
  });
  return apiClient.get(`/api/movement-insights?${params}`, { signal, cache: true });
}
