/**
 * Insights API Module (ES6)
 * Handles all API calls for the driving insights page
 */

import apiClient from "../api-client.js";

/**
 * Fetch driver behavior data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Behavior data
 */
export async function fetchBehavior(params) {
  return apiClient.get(`/api/driver-behavior?${params}`, { cache: true });
}

/**
 * Fetch driving insights data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Insights data
 */
export async function fetchInsights(params) {
  return apiClient.get(`/api/driving-insights?${params}`, { cache: true });
}

/**
 * Fetch trip analytics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Analytics data
 */
export async function fetchAnalytics(params) {
  return apiClient.get(`/api/trip-analytics?${params}`, { cache: true });
}

/**
 * Fetch metrics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Metrics data
 */
export async function fetchMetrics(params) {
  return apiClient.get(`/api/metrics?${params}`, { cache: true });
}

/**
 * Fetch trips for a specific time period
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Array>} Trip data
 */
export async function fetchTimePeriodTrips(params) {
  return apiClient.get(`/api/time-period-trips?${params}`);
}

/**
 * Load all data for the insights page
 * @param {Object} dateRange - Date range object with start and end
 * @param {Object} prevRange - Previous period date range
 * @returns {Promise<Object>} All fetched data
 */
export async function loadAllData(dateRange, prevRange) {
  const params = new URLSearchParams({
    start_date: dateRange.start,
    end_date: dateRange.end,
  });

  const paramsPrev = new URLSearchParams({
    start_date: prevRange.start,
    end_date: prevRange.end,
  });

  const [behavior, insights, analytics, metrics, prevBehavior, prevInsights] =
    await Promise.all([
      fetchBehavior(params),
      fetchInsights(params),
      fetchAnalytics(params),
      fetchMetrics(params),
      fetchBehavior(paramsPrev),
      fetchInsights(paramsPrev),
    ]);

  return {
    current: { behavior, insights, analytics, metrics },
    previous: { behavior: prevBehavior, insights: prevInsights },
  };
}

// Default export as object for backward compatibility
const InsightsAPI = {
  fetchBehavior,
  fetchInsights,
  fetchAnalytics,
  fetchMetrics,
  fetchTimePeriodTrips,
  loadAllData,
};

// Keep window assignment for backward compatibility during transition
if (typeof window !== "undefined") {
  window.InsightsAPI = InsightsAPI;
}

export default InsightsAPI;
