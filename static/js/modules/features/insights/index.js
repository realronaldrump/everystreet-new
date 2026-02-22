/* global bootstrap */
/**
 * Insights Main Module (ES6)
 * Main initialization and event handling for the driving insights page
 */

import * as InsightsAPI from "../../insights/api.js";
import * as InsightsCharts from "../../insights/charts.js";
import * as InsightsFormatters from "../../insights/formatters.js";
import * as InsightsMetrics from "../../insights/metrics.js";
import { loadAndShowTripsForDrilldown } from "../../insights/modal.js";
import {
  bindMovementControls,
  destroyMovementInsights,
  renderMovementInsights,
} from "../../insights/movement.js";
import * as InsightsState from "../../insights/state.js";
import * as InsightsStories from "../../insights/story-sections.js";
import notificationManager from "../../ui/notifications.js";

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
    InsightsCharts.destroyCharts?.();
    InsightsStories.destroyStorySections?.();
    destroyMovementInsights();
    tooltipInstances.forEach((instance) => instance?.dispose?.());
    tooltipInstances = [];
    pageSignal = null;
  };

  if (!returnTeardown) {
    cleanup(teardown);
  }

  setupEventListeners(signal);
  syncViewToggleButtons(InsightsState.getState().currentView);
  syncRhythmToggleButtons(InsightsState.getState().rhythmView);
  syncTimeToggleButtons(InsightsState.getState().currentTimeView);

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

  bindMovementControls(signal);
}

function renderStorySectionsFromState() {
  const state = InsightsState.getState();
  const snapshot = InsightsStories.renderAllStorySections({
    ...state.data,
    currentView: state.currentView,
    rhythmView: state.rhythmView,
    currentTimeView: state.currentTimeView,
  });

  InsightsState.updateState({ derivedInsights: snapshot });
}

let currentDataController = null;

/**
 * Load all data for the insights page
 */
export async function loadAllData(signalOverride) {
  const baseSignal = signalOverride ?? pageSignal;
  if (baseSignal?.aborted) {
    return;
  }

  if (currentDataController) {
    currentDataController.abort();
  }
  currentDataController = new AbortController();
  const activeSignal = currentDataController.signal;

  const onBaseAbort = () => currentDataController.abort();
  if (baseSignal) {
    baseSignal.addEventListener("abort", onBaseAbort, { once: true });
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
    renderMovementInsights(allData.current?.insights?.movement || null);
    InsightsCharts.updateAllCharts();
    renderStorySectionsFromState();
    InsightsMetrics.updateAllMetrics();
  } catch (error) {
    if (error?.name === "AbortError" || activeSignal?.aborted) {
      return;
    }
    console.error("Error loading data:", error);
    notificationManager.show("Error loading data. Please try again.", "error");
  } finally {
    if (baseSignal) {
      baseSignal.removeEventListener("abort", onBaseAbort);
    }
    if (!activeSignal.aborted) {
      InsightsState.updateState({ isLoading: false });
      hideLoadingStates();
      if (currentDataController?.signal === activeSignal) {
        currentDataController = null;
      }
    }
  }
}

function syncViewToggleButtons(activeView) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const isActive = button.dataset.view === activeView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function syncRhythmToggleButtons(activeMode) {
  document.querySelectorAll("[data-rhythm-view]").forEach((button) => {
    const isActive = button.dataset.rhythmView === activeMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function syncTimeToggleButtons(activeMode) {
  document.querySelectorAll("[data-time]").forEach((button) => {
    const isActive = button.dataset.time === activeMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

/**
 * Handle toggle button changes
 * @param {Event} e - Click event
 */
function handleToggleChange(e) {
  const btn = e.currentTarget;

  if (btn.dataset.view) {
    const nextView = btn.dataset.view;
    const updates = { currentView: nextView };
    if (nextView === "weekly" || nextView === "monthly") {
      updates.rhythmView = nextView;
    }
    InsightsState.updateState(updates);

    syncViewToggleButtons(nextView);
    syncRhythmToggleButtons(InsightsState.getState().rhythmView);

    InsightsCharts.updateTrendsChart();
    InsightsStories.updatePeriodStory(
      InsightsState.getState().rhythmView,
      InsightsState.getState().currentView
    );
    return;
  }

  if (btn.dataset.rhythmView) {
    const nextMode = btn.dataset.rhythmView;
    InsightsState.updateState({ rhythmView: nextMode, currentView: nextMode });

    syncRhythmToggleButtons(nextMode);
    syncViewToggleButtons(nextMode);

    InsightsCharts.updateTrendsChart();
    InsightsStories.updatePeriodStory(nextMode, nextMode);
    return;
  }

  if (btn.dataset.time) {
    const nextTimeView = btn.dataset.time;
    InsightsState.updateState({ currentTimeView: nextTimeView });
    syncTimeToggleButtons(nextTimeView);

    InsightsCharts.updateTimeDistChart();
    InsightsStories.updateTimeSignatureStory(nextTimeView);
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
