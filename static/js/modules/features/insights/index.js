/**
 * Insights Main Module (ES6)
 * Main initialization and event handling for the driving insights page
 */

import * as InsightsAPI from "../../insights/api.js";
import * as InsightsCharts from "../../insights/charts.js";
import * as InsightsFormatters from "../../insights/formatters.js";
import * as InsightsMetrics from "../../insights/metrics.js";
import {
  destroyTripModal,
  loadAndShowTripsForDrilldown,
} from "../../insights/modal.js";
import {
  bindMovementControls,
  destroyMovementInsights,
  renderMovementInsights,
} from "../../insights/movement.js";
import * as InsightsState from "../../insights/state.js";
import * as InsightsStories from "../../insights/story-sections.js";
import notificationManager from "../../ui/notifications.js";
import { isAbortError } from "../../utils.js";

let tooltipInstances = [];
let pageSignal = null;

/**
 * Initialize the driving insights page
 */
export default async function initInsightsPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  const returnTeardown = typeof cleanup !== "function";
  const teardown = () => {
    currentDataController?.abort();
    currentDataController = null;
    stopAutoRefresh();
    destroyTripModal();
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
  document
    .getElementById("insights-refresh")
    ?.addEventListener("click", () => loadAllData(), signal ? { signal } : false);
  syncViewToggleButtons(InsightsState.getState().currentView);
  syncRhythmToggleButtons(InsightsState.getState().rhythmView);

  window.addEventListener("beforeunload", stopAutoRefresh, signal ? { signal } : false);
  initTooltips();
  InsightsCharts.initCharts();
  document.addEventListener(
    "themeChanged",
    () => InsightsCharts.updateAllCharts(),
    signal ? { signal } : false
  );
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
  document.addEventListener(
    "historicalTripsUpdated",
    () => {
      void loadAllData();
    },
    signal ? { signal } : false
  );
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
    currentRange: state.currentRange,
  });

  InsightsState.updateState({ derivedInsights: snapshot });
}

let currentDataController = null;

/**
 * Load all data for the insights page
 */
async function loadAllData(signalOverride) {
  const baseSignal = signalOverride ?? pageSignal;
  if (baseSignal?.aborted) {
    return;
  }

  if (currentDataController) {
    currentDataController.abort();
  }
  currentDataController = new AbortController();
  const activeSignal = currentDataController.signal;

  const onBaseAbort = () =>
    currentDataController?.signal === activeSignal && currentDataController.abort();
  if (baseSignal) {
    baseSignal.addEventListener("abort", onBaseAbort, { once: true });
  }

  InsightsState.updateState({ isLoading: true });
  showLoadingStates();

  try {
    const dateRange = InsightsFormatters.getDateRange();
    document.getElementById("insights-range").textContent =
      `${dateRange.start} – ${dateRange.end}`;

    // Update current period length (in days) for metrics that rely on it
    const periodDays = InsightsFormatters.calculateDaysDiff(
      dateRange.start,
      dateRange.end
    );
    InsightsState.updateState({ currentPeriod: periodDays, currentRange: dateRange });

    // Street geometry has independent loading and error states; it never blocks totals.
    const movementRequest = InsightsAPI.fetchMovement(dateRange, activeSignal).then(
      (payload) => ({ payload }),
      (error) => ({ error })
    );
    const allData = await InsightsAPI.loadAllData(dateRange, activeSignal);
    if (activeSignal?.aborted) {
      return;
    }

    // Update state with fetched data
    InsightsState.updateData(allData.current);

    // Update UI
    hideLoadingStates();
    InsightsCharts.updateAllCharts();
    renderStorySectionsFromState();
    InsightsMetrics.updateAllMetrics();
    const tripCount = Number(allData.current.insights.total_trips) || 0;
    setPageStatus(
      tripCount
        ? ""
        : "No trips in this date range. Choose another range using the date filter above."
    );
    document.getElementById("insights-content").hidden = tripCount === 0;
    const movement = await movementRequest;
    if (activeSignal.aborted) return;
    if (movement.error) {
      renderMovementInsights(null);
      document.getElementById("movement-map-empty").textContent =
        "Street rankings could not load. Use Refresh insights to retry.";
      document.getElementById("movement-sync-state").textContent =
        "Street rankings unavailable";
    } else {
      renderMovementInsights(movement.payload);
    }
  } catch (error) {
    if (isAbortError(error) || activeSignal?.aborted) {
      return;
    }
    console.error("Error loading data:", error);
    document.getElementById("insights-content").hidden = true;
    setPageStatus("Insights could not load. Use Refresh insights to try again.");
    notificationManager.show("Error loading data. Please try again.", "error");
  } finally {
    if (baseSignal) {
      baseSignal.removeEventListener("abort", onBaseAbort);
    }
    if (!activeSignal.aborted) {
      InsightsState.updateState({ isLoading: false });
      document.getElementById("insights-content")?.setAttribute("aria-busy", "false");
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
function showLoadingStates() {
  document.getElementById("insights-content").hidden = true;
  document.getElementById("insights-content").setAttribute("aria-busy", "true");
  setPageStatus("Loading insights…");
  renderMovementInsights(null);
  document.getElementById("movement-map-empty").textContent =
    "Loading street rankings…";
  document.getElementById("movement-sync-state").textContent =
    "Loading street rankings…";
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
function hideLoadingStates() {
  document.getElementById("insights-content").hidden = false;
  document.getElementById("insights-content").setAttribute("aria-busy", "false");
  const trendsLoading = document.getElementById("trends-loading");
  const trendsChart = document.getElementById("trendsChart");

  if (trendsLoading) {
    trendsLoading.style.display = "none";
  }
  if (trendsChart) {
    trendsChart.style.display = "block";
  }
}

function setPageStatus(message) {
  const status = document.getElementById("insights-status");
  status.textContent = message;
  status.hidden = !message;
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
      if (!document.hidden) loadAllData();
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
