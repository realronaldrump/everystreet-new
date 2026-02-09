/* global bootstrap */
/**
 * Insights Main Module (ES6)
 * Main initialization and event handling for the driving insights page
 */

import * as InsightsAPI from "../../insights/api.js";
import * as InsightsCharts from "../../insights/charts.js";
import * as InsightsExport from "../../insights/export.js";
import * as InsightsFormatters from "../../insights/formatters.js";
import * as InsightsMetrics from "../../insights/metrics.js";
import * as InsightsState from "../../insights/state.js";
import * as InsightsTables from "../../insights/tables.js";
import { loadAndShowTripsForDrilldown } from "../../insights/modal.js";
import { swupReady } from "../../core/navigation.js";

let tooltipInstances = [];
let pageSignal = null;

/**
 * Initialize the driving insights page
 */
export default async function initInsightsPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  const returnTeardown = typeof cleanup !== "function";
  const teardown = () => {
    stopAutoRefresh();
    InsightsTables.destroyTables?.();
    InsightsCharts.destroyCharts?.();
    tooltipInstances.forEach((instance) => instance?.dispose?.());
    tooltipInstances = [];
    pageSignal = null;
  };
  if (!returnTeardown) {
    cleanup(teardown);
  }
  setupEventListeners(signal);
  window.addEventListener("beforeunload", stopAutoRefresh, signal ? { signal } : false);
  initTooltips();
  InsightsCharts.initCharts();
  await loadAllData(signal);
  if (signal?.aborted) {
    return returnTeardown ? teardown : undefined;
  }
  startAutoRefresh();
  return returnTeardown ? teardown : undefined;
}

/**
 * Initialize Bootstrap tooltips
 */
function initTooltips() {
  if (typeof bootstrap !== "undefined" && bootstrap.Tooltip) {
    tooltipInstances = Array.from(
      document.querySelectorAll('[data-bs-toggle="tooltip"]')
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
    signal ? { signal } : false
  );

  // View toggles
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", handleToggleChange, signal ? { signal } : false);
  });

  // Drill-down triggers (titles on cards/charts/etc.)
  document.querySelectorAll(".insights-drilldown-trigger").forEach((el) => {
    el.addEventListener("click", handleDrilldownClick, signal ? { signal } : false);
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
      signal ? { signal } : false
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
        InsightsExport.showNotification("Data refreshed successfully", "success");
      },
      signal ? { signal } : false
    );
  }

  if (downloadBtn) {
    downloadBtn.addEventListener(
      "click",
      InsightsExport.generateReport,
      signal ? { signal } : false
    );
  }

  if (shareBtn) {
    shareBtn.addEventListener(
      "click",
      InsightsExport.shareInsights,
      signal ? { signal } : false
    );
  }

  if (exportChartBtn) {
    exportChartBtn.addEventListener(
      "click",
      InsightsExport.exportChart,
      signal ? { signal } : false
    );
  }

  if (exportDataBtn) {
    exportDataBtn.addEventListener(
      "click",
      InsightsExport.exportData,
      signal ? { signal } : false
    );
  }

  if (viewMapBtn) {
    viewMapBtn.addEventListener(
      "click",
      () => {
        swupReady
          .then((swup) => {
            swup.navigate("/trips");
          });
      },
      signal ? { signal } : false
    );
  }
}

/**
 * Load all data for the insights page
 */
export async function loadAllData(signalOverride) {
  const activeSignal = signalOverride ?? pageSignal;
  if (activeSignal?.aborted) {
    return;
  }
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
      dateRange.end
    );
    InsightsState.updateState({ currentPeriod: periodDays });

    // Calculate previous-period date range for trend comparisons
    const prevRange = InsightsFormatters.calculatePreviousRange(
      dateRange.start,
      periodDays
    );

    // Fetch all data
    const allData = await InsightsAPI.loadAllData(dateRange, prevRange, activeSignal);
    if (activeSignal?.aborted) {
      return;
    }

    // Update state with fetched data
    InsightsState.updateData(allData.current);
    InsightsState.updateState({ prevRange: allData.previous });

    // Update UI
    InsightsMetrics.updateAllMetrics();
    InsightsCharts.updateAllCharts();
    InsightsTables.updateTables();
  } catch (error) {
    if (error?.name === "AbortError" || activeSignal?.aborted) {
      return;
    }
    console.error("Error loading data:", error);
    InsightsExport.showNotification("Error loading data. Please try again.", "error");
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

  if (btn.dataset.view) {
    InsightsState.updateState({ currentView: btn.dataset.view });
    InsightsCharts.updateTrendsChart();
  } else if (btn.dataset.time) {
    InsightsState.updateState({ currentTimeView: btn.dataset.time });
    InsightsCharts.updateTimeDistChart();
  }
}

/**
 * Handle drilldown trigger click to open modal trip list
 * @param {Event} e - Click event
 */
function handleDrilldownClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const kind = e.currentTarget?.dataset?.drilldown || "trips";
  loadAndShowTripsForDrilldown(kind);
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
    5 * 60 * 1000
  );

  InsightsState.updateState({ autoRefreshInterval: intervalId });
}

function stopAutoRefresh() {
  const state = InsightsState.getState();
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
    InsightsState.updateState({ autoRefreshInterval: null });
  }
}
