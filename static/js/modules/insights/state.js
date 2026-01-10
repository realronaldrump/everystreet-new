/**
 * Insights State Module
 * Global state management for the driving insights page
 */
(() => {
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
  function getState() {
    return state;
  }

  /**
   * Update state with new values
   * @param {Object} updates - Key-value pairs to update
   */
  function updateState(updates) {
    Object.assign(state, updates);
  }

  /**
   * Update nested data property
   * @param {Object} dataUpdates - Data updates to merge
   */
  function updateData(dataUpdates) {
    Object.assign(state.data, dataUpdates);
  }

  /**
   * Set a specific chart instance
   * @param {string} name - Chart name
   * @param {Object} chartInstance - Chart.js instance
   */
  function setChart(name, chartInstance) {
    state.charts[name] = chartInstance;
  }

  /**
   * Get a specific chart instance
   * @param {string} name - Chart name
   * @returns {Object|null} Chart.js instance or null
   */
  function getChart(name) {
    return state.charts[name] || null;
  }

  /**
   * Set a counter instance
   * @param {string} id - Element ID
   * @param {Object} counterInstance - CountUp instance
   */
  function setCounter(id, counterInstance) {
    state.counters[id] = counterInstance;
  }

  /**
   * Get a counter instance
   * @param {string} id - Element ID
   * @returns {Object|null} CountUp instance or null
   */
  function getCounter(id) {
    return state.counters[id] || null;
  }

  /**
   * Reset state to initial values
   */
  function resetState() {
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

  // Expose to window for module access
  window.InsightsState = {
    getState,
    updateState,
    updateData,
    setChart,
    getChart,
    setCounter,
    getCounter,
    resetState,
  };
})();
