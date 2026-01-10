/**
 * Insights API Module (ES6)
 * Handles all API calls for the driving insights page
 */

/**
 * Fetch driver behavior data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Behavior data
 */
export async function fetchBehavior(params) {
  const response = await fetch(`/api/driver-behavior?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch behavior data: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch driving insights data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Insights data
 */
export async function fetchInsights(params) {
  const response = await fetch(`/api/driving-insights?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch insights data: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch trip analytics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Analytics data
 */
export async function fetchAnalytics(params) {
  const response = await fetch(`/api/trip-analytics?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch analytics data: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch metrics data
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Object>} Metrics data
 */
export async function fetchMetrics(params) {
  const response = await fetch(`/api/metrics?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch metrics data: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch trips for a specific time period
 * @param {URLSearchParams} params - Query parameters
 * @returns {Promise<Array>} Trip data
 */
export async function fetchTimePeriodTrips(params) {
  const response = await fetch(`/api/time-period-trips?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch trips: ${response.status}`);
  }
  return response.json();
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
