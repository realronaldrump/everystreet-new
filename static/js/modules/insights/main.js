/* global bootstrap */
/**
 * Insights Main Module (ES6)
 * Main initialization and event handling for the driving insights page
 */

import { onPageLoad } from "../utils.js";
import * as InsightsAPI from "./api.js";
import * as InsightsCharts from "./charts.js";
import * as InsightsExport from "./export.js";
import * as InsightsFormatters from "./formatters.js";
import * as InsightsMetrics from "./metrics.js";
import * as InsightsState from "./state.js";
import * as InsightsTables from "./tables.js";

let tooltipInstances = [];

// Initialize on page load
onPageLoad((context) => init(context), { route: "/insights" });

/**
 * Initialize the driving insights page
 */
export async function init({ signal, cleanup } = {}) {
  setupEventListeners(signal);
  initTooltips();
  InsightsCharts.initCharts();
  await loadAllData();
  startAutoRefresh();
  if (typeof cleanup === "function") {
    cleanup(() => {
      stopAutoRefresh();
      InsightsTables.destroyTables?.();
      tooltipInstances.forEach((instance) => instance?.dispose?.());
      tooltipInstances = [];
    });
  }
}

/**
 * Initialize Bootstrap tooltips
 */
function initTooltips() {
  if (typeof bootstrap !== "undefined" && bootstrap.Tooltip) {
    tooltipInstances = Array.from(
      document.querySelectorAll('[data-bs-toggle="tooltip"]'),
    ).map((el) => bootstrap.Tooltip.getOrCreateInstance(el));
  }
}

/**
 * Setup all event listeners
 */
function setupEventListeners(signal) {
  // React to global date-filter changes triggered elsewhere in the app
  document.addEventListener(
    "filtersApplied",
    () => {
      loadAllData();
    },
    signal ? { signal } : false,
  );

  // View toggles
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener(
      "click",
      handleToggleChange,
      signal ? { signal } : false,
    );
  });

  // Metric cards
  document.querySelectorAll(".metric-card").forEach((card) => {
    card.addEventListener(
      "click",
      handleMetricClick,
      signal ? { signal } : false,
    );
  });

  // FAB menu
  setupFabMenu(signal);

  // FAB actions
  setupFabActions(signal);
}

/**
 * Setup floating action button menu
 */
function setupFabMenu(signal) {
  const fabMain = document.getElementById("fab-main");
  const fabMenu = document.getElementById("fab-menu");

  if (fabMain && fabMenu) {
    fabMain.addEventListener(
      "click",
      () => {
        fabMenu.classList.toggle("show");
        const icon = fabMain.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-plus");
          icon.classList.toggle("fa-times");
        }
      },
      signal ? { signal } : false,
    );
  }
}

/**
 * Setup floating action button actions
 */
function setupFabActions(signal) {
  const refreshBtn = document.getElementById("refresh-data");
  const downloadBtn = document.getElementById("download-report");
  const shareBtn = document.getElementById("share-insights");
  const exportChartBtn = document.getElementById("export-chart");
  const exportDataBtn = document.getElementById("export-data");
  const viewMapBtn = document.getElementById("view-map");

  if (refreshBtn) {
    refreshBtn.addEventListener(
      "click",
      () => {
        loadAllData();
        InsightsExport.showNotification(
          "Data refreshed successfully",
          "success",
        );
      },
      signal ? { signal } : false,
    );
  }

  if (downloadBtn) {
    downloadBtn.addEventListener(
      "click",
      InsightsExport.generateReport,
      signal ? { signal } : false,
    );
  }

  if (shareBtn) {
    shareBtn.addEventListener(
      "click",
      InsightsExport.shareInsights,
      signal ? { signal } : false,
    );
  }

  if (exportChartBtn) {
    exportChartBtn.addEventListener(
      "click",
      InsightsExport.exportChart,
      signal ? { signal } : false,
    );
  }

  if (exportDataBtn) {
    exportDataBtn.addEventListener(
      "click",
      InsightsExport.exportData,
      signal ? { signal } : false,
    );
  }

  if (viewMapBtn) {
    viewMapBtn.addEventListener(
      "click",
      () => {
        window.location.href = "/trips";
      },
      signal ? { signal } : false,
    );
  }
}

/**
 * Load all data for the insights page
 */
export async function loadAllData() {
  const state = InsightsState.getState();
  if (state.isLoading) {
    return;
  }

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

  if (trendsLoading) {
    trendsLoading.style.display = "flex";
  }
  if (trendsChart) {
    trendsChart.style.display = "none";
  }
}

/**
 * Hide loading states for charts
 */
export function hideLoadingStates() {
  const trendsLoading = document.getElementById("trends-loading");
  const trendsChart = document.getElementById("trendsChart");

  if (trendsLoading) {
    trendsLoading.style.display = "none";
  }
  if (trendsChart) {
    trendsChart.style.display = "block";
  }
}

/**
 * Start auto-refresh interval
 */
function startAutoRefresh() {
  const _state = InsightsState.getState();

  // Clear any existing interval
  stopAutoRefresh();

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
  stopAutoRefresh();
});

function stopAutoRefresh() {
  const state = InsightsState.getState();
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
    InsightsState.updateState({ autoRefreshInterval: null });
  }
}
