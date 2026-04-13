/**
 * Insights State Module (ES6)
 * Global state management for the driving insights page
 */

const state = {
  currentPeriod: 30,
  currentView: "daily",
  rhythmView: "weekly",
  currentTimeView: "hour",
  charts: {},
  derivedInsights: null,
  data: {
    behavior: null,
    insights: null,
    analytics: null,
    metrics: null,
  },
  isLoading: false,
  autoRefreshInterval: null,
  prevRange: null,
};

/**
 * Get the current state object
 * @returns {Object} The current state
 */
export function getState() {
  return state;
}

/**
 * Update state with new values
 * @param {Object} updates - Key-value pairs to update
 */
export function updateState(updates) {
  Object.assign(state, updates);
}

/**
 * Update nested data property
 * @param {Object} dataUpdates - Data updates to merge
 */
export function updateData(dataUpdates) {
  Object.assign(state.data, dataUpdates);
}

/**
 * Set a specific chart instance
 * @param {string} name - Chart name
 * @param {Object} chartInstance - Chart.js instance
 */
export function setChart(name, chartInstance) {
  state.charts[name] = chartInstance;
}

/**
 * Get a specific chart instance
 * @param {string} name - Chart name
 * @returns {Object|null} Chart.js instance or null
 */
export function getChart(name) {
  return state.charts[name] || null;
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state.currentPeriod = 30;
  state.currentView = "daily";
  state.rhythmView = "weekly";
  state.currentTimeView = "hour";
  state.derivedInsights = null;
  state.data = {
    behavior: null,
    insights: null,
    analytics: null,
    metrics: null,
  };
  state.isLoading = false;
  state.prevRange = null;
}
