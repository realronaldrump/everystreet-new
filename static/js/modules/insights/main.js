/* global bootstrap */
/**
 * Insights Main Module
 * Main initialization and event handling for the driving insights page
 */
(() => {
  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", init);

  /**
   * Initialize the driving insights page
   */
  async function init() {
    setupEventListeners();
    initTooltips();
    window.InsightsCharts.initCharts();
    await loadAllData();
    startAutoRefresh();
  }

  /**
   * Initialize Bootstrap tooltips
   */
  function initTooltips() {
    Array.from(document.querySelectorAll('[data-bs-toggle="tooltip"]')).forEach(
      (el) => {
        bootstrap.Tooltip.getOrCreateInstance(el);
      }
    );
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
        window.InsightsExport.showNotification(
          "Data refreshed successfully",
          "success"
        );
      });
    }

    if (downloadBtn) {
      downloadBtn.addEventListener("click", window.InsightsExport.generateReport);
    }

    if (shareBtn) {
      shareBtn.addEventListener("click", window.InsightsExport.shareInsights);
    }

    if (exportChartBtn) {
      exportChartBtn.addEventListener("click", window.InsightsExport.exportChart);
    }

    if (exportDataBtn) {
      exportDataBtn.addEventListener("click", window.InsightsExport.exportData);
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
  async function loadAllData() {
    const state = window.InsightsState.getState();
    if (state.isLoading) return;

    window.InsightsState.updateState({ isLoading: true });
    showLoadingStates();

    try {
      const dateRange = window.InsightsFormatters.getDateRange();

      // Update current period length (in days) for metrics that rely on it
      const periodDays = window.InsightsFormatters.calculateDaysDiff(
        dateRange.start,
        dateRange.end
      );
      window.InsightsState.updateState({ currentPeriod: periodDays });

      // Calculate previous-period date range for trend comparisons
      const prevRange = window.InsightsFormatters.calculatePreviousRange(
        dateRange.start,
        periodDays
      );

      // Fetch all data
      const allData = await window.InsightsAPI.loadAllData(dateRange, prevRange);

      // Update state with fetched data
      window.InsightsState.updateData(allData.current);
      window.InsightsState.updateState({ prevRange: allData.previous });

      // Update UI
      window.InsightsMetrics.updateAllMetrics();
      window.InsightsCharts.updateAllCharts();
      window.InsightsTables.updateTables();
    } catch (error) {
      console.error("Error loading data:", error);
      window.InsightsExport.showNotification(
        "Error loading data. Please try again.",
        "error"
      );
    } finally {
      window.InsightsState.updateState({ isLoading: false });
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
      window.InsightsState.updateState({ currentView: btn.dataset.view });
      window.InsightsCharts.updateTrendsChart();
    } else if (btn.dataset.time) {
      window.InsightsState.updateState({ currentTimeView: btn.dataset.time });
      window.InsightsCharts.updateTimeDistChart();
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
  function showLoadingStates() {
    const trendsLoading = document.getElementById("trends-loading");
    const trendsChart = document.getElementById("trendsChart");

    if (trendsLoading) trendsLoading.style.display = "flex";
    if (trendsChart) trendsChart.style.display = "none";
  }

  /**
   * Hide loading states for charts
   */
  function hideLoadingStates() {
    const trendsLoading = document.getElementById("trends-loading");
    const trendsChart = document.getElementById("trendsChart");

    if (trendsLoading) trendsLoading.style.display = "none";
    if (trendsChart) trendsChart.style.display = "block";
  }

  /**
   * Start auto-refresh interval
   */
  function startAutoRefresh() {
    const state = window.InsightsState.getState();

    // Clear any existing interval
    if (state.autoRefreshInterval) {
      clearInterval(state.autoRefreshInterval);
    }

    // Refresh data every 5 minutes
    const intervalId = setInterval(
      () => {
        loadAllData();
      },
      5 * 60 * 1000
    );

    window.InsightsState.updateState({ autoRefreshInterval: intervalId });
  }

  /**
   * Cleanup on page unload
   */
  window.addEventListener("beforeunload", () => {
    const state = window.InsightsState.getState();
    if (state.autoRefreshInterval) {
      clearInterval(state.autoRefreshInterval);
    }
  });

  // Expose for external access if needed
  window.InsightsMain = {
    init,
    loadAllData,
    showLoadingStates,
    hideLoadingStates,
  };
})();
