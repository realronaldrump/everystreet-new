/**
 * Insights State Module (ES6)
 * Global state management for the driving insights page
 */

const state = {
  currentPeriod: 30,
  currentView: "daily",
  currentTimeView: "hour",
  charts: {},
  data: {
    behavior: null,
    insights: null,
    analytics: null,
    metrics: null,
  },
  counters: {},
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
 * Set a counter instance
 * @param {string} id - Element ID
 * @param {Object} counterInstance - CountUp instance
 */
export function setCounter(id, counterInstance) {
  state.counters[id] = counterInstance;
}

/**
 * Get a counter instance
 * @param {string} id - Element ID
 * @returns {Object|null} CountUp instance or null
 */
export function getCounter(id) {
  return state.counters[id] || null;
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state.currentPeriod = 30;
  state.currentView = "daily";
  state.currentTimeView = "hour";
  state.data = {
    behavior: null,
    insights: null,
    analytics: null,
    metrics: null,
  };
  state.isLoading = false;
  state.prevRange = null;
}
