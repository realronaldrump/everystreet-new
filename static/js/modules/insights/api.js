/**
 * Insights API Module (ES6)
 * Handles all API calls for the driving insights page
 */

import apiClient from "../core/api-client.js";

/**
 * Fetch driver behavior data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Behavior data
 */
export function fetchBehavior(params, signal) {
  return apiClient.get(`/api/driver-behavior?${params}`, { cache: true, signal });
}

/**
 * Fetch driving insights data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Insights data
 */
export function fetchInsights(params, signal) {
  return apiClient.get(`/api/driving-insights?${params}`, { cache: true, signal });
}

/**
 * Fetch trip analytics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Analytics data
 */
export function fetchAnalytics(params, signal) {
  return apiClient.get(`/api/trip-analytics?${params}`, { cache: true, signal });
}

/**
 * Fetch metrics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Metrics data
 */
export function fetchMetrics(params, signal) {
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
 * @param {Object} prevRange - Previous period date range
 * @returns {Promise<Object>} All fetched data
 */
export async function loadAllData(dateRange, prevRange, signal) {
  const params = new URLSearchParams({
    start_date: dateRange.start,
    end_date: dateRange.end,
  });

  const paramsPrev = new URLSearchParams({
    start_date: prevRange.start,
    end_date: prevRange.end,
  });

  const [behavior, insights, analytics, metrics, prevBehavior, prevInsights]
    = await Promise.all([
      fetchBehavior(params, signal),
      fetchInsights(params, signal),
      fetchAnalytics(params, signal),
      fetchMetrics(params, signal),
      fetchBehavior(paramsPrev, signal),
      fetchInsights(paramsPrev, signal),
    ]);

  return {
    current: { behavior, insights, analytics, metrics },
    previous: { behavior: prevBehavior, insights: prevInsights },
  };
}
