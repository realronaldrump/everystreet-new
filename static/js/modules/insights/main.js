/**
 * Insights Main Module (ES6)
 * Main initialization and event handling for the driving insights page
 */

import InsightsAPI from "./api.js";
import InsightsCharts from "./charts.js";
import InsightsExport from "./export.js";
import InsightsFormatters from "./formatters.js";
import InsightsMetrics from "./metrics.js";
import InsightsState from "./state.js";
import InsightsTables from "./tables.js";

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", init);

/**
 * Initialize the driving insights page
 */
export async function init() {
  setupEventListeners();
  initTooltips();
  InsightsCharts.initCharts();
  await loadAllData();
  startAutoRefresh();
}

/**
 * Initialize Bootstrap tooltips
 */
function initTooltips() {
  if (typeof bootstrap !== "undefined" && bootstrap.Tooltip) {
    Array.from(document.querySelectorAll('[data-bs-toggle="tooltip"]')).forEach(
      (el) => {
        bootstrap.Tooltip.getOrCreateInstance(el);
      },
    );
  }
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // React to global date-filter changes triggered elsewhere in the app
  document.addEventListener("filtersApplied", () => {
    loadAllData();
  });

  // View toggles
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", handleToggleChange);
  });

  // Metric cards
  document.querySelectorAll(".metric-card").forEach((card) => {
    card.addEventListener("click", handleMetricClick);
  });

  // FAB menu
  setupFabMenu();

  // FAB actions
  setupFabActions();
}

/**
 * Setup floating action button menu
 */
function setupFabMenu() {
  const fabMain = document.getElementById("fab-main");
  const fabMenu = document.getElementById("fab-menu");

  if (fabMain && fabMenu) {
    fabMain.addEventListener("click", () => {
      fabMenu.classList.toggle("show");
      const icon = fabMain.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-plus");
        icon.classList.toggle("fa-times");
      }
    });
  }
}

/**
 * Setup floating action button actions
 */
function setupFabActions() {
  const refreshBtn = document.getElementById("refresh-data");
  const downloadBtn = document.getElementById("download-report");
  const shareBtn = document.getElementById("share-insights");
  const exportChartBtn = document.getElementById("export-chart");
  const exportDataBtn = document.getElementById("export-data");
  const viewMapBtn = document.getElementById("view-map");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      loadAllData();
      InsightsExport.showNotification("Data refreshed successfully", "success");
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", InsightsExport.generateReport);
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", InsightsExport.shareInsights);
  }

  if (exportChartBtn) {
    exportChartBtn.addEventListener("click", InsightsExport.exportChart);
  }

  if (exportDataBtn) {
    exportDataBtn.addEventListener("click", InsightsExport.exportData);
  }

  if (viewMapBtn) {
    viewMapBtn.addEventListener("click", () => {
      window.location.href = "/trips";
    });
  }
}

/**
 * Load all data for the insights page
 */
export async function loadAllData() {
  const state = InsightsState.getState();
  if (state.isLoading) return;

  InsightsState.updateState({ isLoading: true });
  showLoadingStates();

  try {
    const dateRange = InsightsFormatters.getDateRange();

    // Update current period length (in days) for metrics that rely on it
    const periodDays = InsightsFormatters.calculateDaysDiff(
      dateRange.start,
      dateRange.end,
    );
    InsightsState.updateState({ currentPeriod: periodDays });

    // Calculate previous-period date range for trend comparisons
    const prevRange = InsightsFormatters.calculatePreviousRange(
      dateRange.start,
      periodDays,
    );

    // Fetch all data
    const allData = await InsightsAPI.loadAllData(dateRange, prevRange);

    // Update state with fetched data
    InsightsState.updateData(allData.current);
    InsightsState.updateState({ prevRange: allData.previous });

    // Update UI
    InsightsMetrics.updateAllMetrics();
    InsightsCharts.updateAllCharts();
    InsightsTables.updateTables();
  } catch (error) {
    console.error("Error loading data:", error);
    InsightsExport.showNotification(
      "Error loading data. Please try again.",
      "error",
    );
  } finally {
    InsightsState.updateState({ isLoading: false });
    hideLoadingStates();
  }
}

/**
 * Handle toggle button changes
 * @param {Event} e - Click event
 */
function handleToggleChange(e) {
  const btn = e.currentTarget;
  const parent = btn.parentElement;

  // Update active state
  parent.querySelectorAll(".toggle-btn").forEach((b) => {
    b.classList.remove("active");
  });
  btn.classList.add("active");

  // Determine which chart to update
  const chartHeader = parent.closest(".chart-header");
  const chartTitle = chartHeader?.querySelector(".chart-title");

  if (chartTitle?.textContent?.includes("Trends")) {
    InsightsState.updateState({ currentView: btn.dataset.view });
    InsightsCharts.updateTrendsChart();
  } else if (btn.dataset.time) {
    InsightsState.updateState({ currentTimeView: btn.dataset.time });
    InsightsCharts.updateTimeDistChart();
  }
}

/**
 * Handle metric card click to toggle comparison details
 * @param {Event} e - Click event
 */
function handleMetricClick(e) {
  const card = e.currentTarget;
  const comparison = card.querySelector(".stat-comparison");
  if (comparison) {
    comparison.classList.toggle("show");
  }
}

/**
 * Show loading states for charts
 */
export function showLoadingStates() {
  const trendsLoading = document.getElementById("trends-loading");
  const trendsChart = document.getElementById("trendsChart");

  if (trendsLoading) trendsLoading.style.display = "flex";
  if (trendsChart) trendsChart.style.display = "none";
}

/**
 * Hide loading states for charts
 */
export function hideLoadingStates() {
  const trendsLoading = document.getElementById("trends-loading");
  const trendsChart = document.getElementById("trendsChart");

  if (trendsLoading) trendsLoading.style.display = "none";
  if (trendsChart) trendsChart.style.display = "block";
}

/**
 * Start auto-refresh interval
 */
function startAutoRefresh() {
  const state = InsightsState.getState();

  // Clear any existing interval
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
  }

  // Refresh data every 5 minutes
  const intervalId = setInterval(
    () => {
      loadAllData();
    },
    5 * 60 * 1000,
  );

  InsightsState.updateState({ autoRefreshInterval: intervalId });
}

/**
 * Cleanup on page unload
 */
window.addEventListener("beforeunload", () => {
  const state = InsightsState.getState();
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
  }
});

// Expose for external access if needed
const InsightsMain = {
  init,
  loadAllData,
  showLoadingStates,
  hideLoadingStates,
};

if (typeof window !== "undefined") {
  window.InsightsMain = InsightsMain;
}

export default InsightsMain;
