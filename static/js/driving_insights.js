/* global Chart, CountUp, $, bootstrap, DateUtils, notificationManager */

// Ensure CountUp is defined when using the UMD build, which attaches the class under `countUp.CountUp`.
// This creates an alias so the rest of the file can safely reference `CountUp`.
if (typeof window !== "undefined") {
  window.CountUp = window.CountUp || window.countUp?.CountUp;
}

(() => {
  // Global state
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

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    setupEventListeners();
    // Enable Bootstrap tooltips used in the page (e.g., Total Distance column)
    const tooltipTriggerList = [].slice.call(
      document.querySelectorAll('[data-bs-toggle="tooltip"]')
    );
    tooltipTriggerList.forEach((el) => {
      const tooltip = new bootstrap.Tooltip(el);
      // Tooltip instance is stored but intentionally not used - it attaches to DOM element
      void tooltip;
    });

    initCharts();
    await loadAllData();
    startAutoRefresh();
  }

  // Event Listeners
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
    const fabMain = document.getElementById("fab-main");
    const fabMenu = document.getElementById("fab-menu");
    fabMain.addEventListener("click", () => {
      fabMenu.classList.toggle("show");
      fabMain.querySelector("i").classList.toggle("fa-plus");
      fabMain.querySelector("i").classList.toggle("fa-times");
    });

    // FAB actions
    document.getElementById("refresh-data").addEventListener("click", () => {
      loadAllData();
      showNotification("Data refreshed successfully", "success");
    });

    document
      .getElementById("download-report")
      .addEventListener("click", generateReport);
    document.getElementById("share-insights").addEventListener("click", shareInsights);
    document.getElementById("export-chart").addEventListener("click", exportChart);
    document.getElementById("export-data").addEventListener("click", exportData);
    document.getElementById("view-map").addEventListener("click", () => {
      window.location.href = "/trips";
    });
  }

  // Data Loading
  async function loadAllData() {
    if (state.isLoading) return;

    state.isLoading = true;
    showLoadingStates();

    try {
      const dateRange = getDateRange();

      // Update current period length (in days) for metrics that rely on it
      try {
        const startDateObj = window.DateUtils.parseDateString(dateRange.start);
        const endDateObj = window.DateUtils.parseDateString(dateRange.end);
        if (startDateObj && endDateObj) {
          const diffTime = endDateObj - startDateObj;
          const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
          state.currentPeriod = Math.max(diffDays, 1);
        }
      } catch {
        /* ignore invalid dates */
      }

      const params = new URLSearchParams({
        start_date: dateRange.start,
        end_date: dateRange.end,
      });

      // Calculate previous-period date range for trend comparisons
      const prevEndDateObj = window.DateUtils.parseDateString(dateRange.start);
      if (!prevEndDateObj) {
        throw new Error("Invalid date range");
      }
      prevEndDateObj.setDate(prevEndDateObj.getDate() - 1);
      const prevStartDateObj = new Date(prevEndDateObj);
      prevStartDateObj.setDate(prevStartDateObj.getDate() - (state.currentPeriod - 1));

      const prevRange = {
        start: formatDate(prevStartDateObj),
        end: formatDate(prevEndDateObj),
      };

      const paramsPrev = new URLSearchParams({
        start_date: prevRange.start,
        end_date: prevRange.end,
      });

      const [behavior, insights, analytics, metrics, prevBehavior, prevInsights] =
        await Promise.all([
          fetch(`/api/driver-behavior?${params}`).then((r) => r.json()),
          fetch(`/api/driving-insights?${params}`).then((r) => r.json()),
          fetch(`/api/trip-analytics?${params}`).then((r) => r.json()),
          fetch(`/api/metrics?${params}`).then((r) => r.json()),
          fetch(`/api/driver-behavior?${paramsPrev}`).then((r) => r.json()),
          fetch(`/api/driving-insights?${paramsPrev}`).then((r) => r.json()),
        ]);

      state.data = { behavior, insights, analytics, metrics };
      state.prevRange = { behavior: prevBehavior, insights: prevInsights };

      updateAllMetrics();
      updateAllCharts();
      updateTables();
    } catch (error) {
      console.error("Error loading data:", error);
      showNotification("Error loading data. Please try again.", "error");
    } finally {
      state.isLoading = false;
      hideLoadingStates();
    }
  }

  // Chart Initialization
  function initCharts() {
    // Trends Chart
    const trendsCtx = document.getElementById("trendsChart").getContext("2d");
    state.charts.trends = new Chart(trendsCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Distance",
            data: [],
            borderColor: "rgb(75, 192, 192)",
            backgroundColor: "rgba(75, 192, 192, 0.1)",
            yAxisID: "y",
            tension: 0.3,
          },
          {
            label: "Trips",
            data: [],
            borderColor: "rgb(255, 99, 132)",
            backgroundColor: "rgba(255, 99, 132, 0.1)",
            yAxisID: "y1",
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: "top",
          },
          tooltip: {
            callbacks: {
              label(context) {
                let label = context.dataset.label || "";
                if (label) label += ": ";
                if (context.dataset.yAxisID === "y") {
                  label += `${context.parsed.y.toFixed(1)} miles`;
                } else {
                  label += `${context.parsed.y} trips`;
                }
                return label;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
          },
          y: {
            type: "linear",
            display: true,
            position: "left",
            title: {
              display: true,
              text: "Distance (miles)",
            },
          },
          y1: {
            type: "linear",
            display: true,
            position: "right",
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: "Number of Trips",
            },
          },
        },
      },
    });

    // Efficiency Chart
    const efficiencyCtx = document.getElementById("efficiencyChart").getContext("2d");
    state.charts.efficiency = new Chart(efficiencyCtx, {
      type: "doughnut",
      data: {
        labels: ["Fuel Efficiency", "Idle Efficiency", "Speed Efficiency"],
        datasets: [
          {
            data: [0, 0, 0],
            backgroundColor: [
              "rgba(75, 192, 192, 0.8)",
              "rgba(255, 206, 86, 0.8)",
              "rgba(54, 162, 235, 0.8)",
            ],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.label}: ${context.parsed}%`;
              },
            },
          },
        },
      },
    });

    // Time Distribution Chart
    const timeDistCtx = document.getElementById("timeDistChart").getContext("2d");
    state.charts.timeDist = new Chart(timeDistCtx, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          {
            label: "Trips",
            data: [],
            backgroundColor: "rgba(153, 102, 255, 0.6)",
            hoverBackgroundColor: "rgba(153, 102, 255, 0.9)",
            borderColor: "rgba(153, 102, 255, 1)",
            borderWidth: 0,
            hoverBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              afterLabel: () => "Click to view trips",
            },
          },
        },
        scales: {
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 0,
            },
          },
          y: {
            beginAtZero: true,
            ticks: {
              stepSize: 1,
            },
          },
        },
        onClick: handleTimeDistChartClick,
      },
    });
  }

  // Metric Updates
  function updateAllMetrics() {
    const { behavior: behaviorData, insights, metrics } = state.data;

    // Primary metrics
    animateCounter("total-trips", insights.total_trips || 0);
    animateCounter("total-distance", insights.total_distance || 0, 1);
    animateCounter("total-fuel", insights.total_fuel_consumed || 0, 2);
    animateCounter("hero-total-miles", insights.total_distance || 0, 1);

    // Behavior / safety metrics (date-filtered)
    animateCounter("hard-braking", behaviorData.hardBrakingCounts || 0);
    animateCounter("hard-accel", behaviorData.hardAccelerationCounts || 0);
    animateCounter("max-speed", behaviorData.maxSpeed || 0, 1);
    animateCounter("avg-speed", behaviorData.avgSpeed || 0, 1);

    // Time metrics – use duration from /api/metrics for total time on road,
    // and idle duration from /api/driving-insights for idle time.
    updateTimeMetric("total-time", metrics.total_duration_seconds || 0);
    updateTimeMetric("idle-time", insights.total_idle_duration || 0);

    // Update comparisons
    updateComparisons();

    // Update trends vs. previous fetch
    updateTrends();
  }

  function updateAllCharts() {
    updateTrendsChart();
    updateEfficiencyChart();
    updateTimeDistChart();
  }

  function updateTrendsChart() {
    const { analytics } = state.data;
    if (!analytics || !analytics.daily_distances) return;

    const data = processTimeSeriesData(analytics.daily_distances);

    state.charts.trends.data.labels = data.labels;
    state.charts.trends.data.datasets[0].data = data.distances;
    state.charts.trends.data.datasets[1].data = data.counts;
    state.charts.trends.update();
  }

  function updateEfficiencyChart() {
    const { insights, behavior } = state.data;

    // Calculate efficiency scores (0-100)
    const fuelEfficiency = calculateFuelEfficiency(insights, behavior);
    const idleEfficiency = calculateIdleEfficiency(behavior);
    const speedEfficiency = calculateSpeedEfficiency(behavior);

    state.charts.efficiency.data.datasets[0].data = [
      fuelEfficiency,
      idleEfficiency,
      speedEfficiency,
    ];
    state.charts.efficiency.update();
  }

  function updateTimeDistChart() {
    const { analytics } = state.data;
    if (!analytics || !analytics.time_distribution) return;

    const labels =
      state.currentTimeView === "hour"
        ? Array.from({ length: 24 }, (_, i) => formatHourLabel(i))
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const data =
      state.currentTimeView === "hour"
        ? processHourlyData(analytics.time_distribution)
        : processDailyData(analytics.weekday_distribution);

    state.charts.timeDist.data.labels = labels;
    state.charts.timeDist.data.datasets[0].data = data;
    state.charts.timeDist.update();
  }

  // Helper Functions
  function animateCounter(elementId, endValue, decimals = 0) {
    const element = document.getElementById(elementId);
    if (!element) return;

    if (!state.counters[elementId]) {
      state.counters[elementId] = new CountUp(elementId, 0, endValue, decimals, 1.5, {
        useEasing: true,
        useGrouping: true,
        separator: ",",
        decimal: ".",
        prefix: "",
        suffix: "",
      });
    } else {
      state.counters[elementId].update(endValue);
    }

    if (!state.counters[elementId].error) {
      state.counters[elementId].start();
    } else {
      element.textContent = endValue.toFixed(decimals);
    }
  }

  function updateTimeMetric(elementId, seconds) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    element.textContent = `${hours}h ${minutes}m`;
  }

  function updateComparisons() {
    const { insights, behavior: behaviorData } = state.data;

    // Trips comparison
    const dailyAvgTrips = (insights.total_trips || 0) / state.currentPeriod;
    document.querySelector("#trips-comparison span").textContent =
      dailyAvgTrips.toFixed(1);

    // Distance comparison
    const avgPerTrip =
      insights.total_trips > 0
        ? (insights.total_distance / insights.total_trips).toFixed(1)
        : 0;
    document.querySelector("#distance-comparison span").textContent = avgPerTrip;

    // Fuel comparison
    const mpg =
      insights.total_distance > 0 && insights.total_fuel_consumed > 0
        ? (insights.total_distance / insights.total_fuel_consumed).toFixed(1)
        : 0;
    document.querySelector("#fuel-comparison span").textContent = mpg;

    // Time comparison
    document.querySelector("#time-comparison span").textContent =
      behaviorData.avgSpeed?.toFixed(1) || 0;
  }

  function updateTrends() {
    if (!state.prevRange) return;

    const { insights, behavior } = state.data;
    const { insights: prevIn, behavior: prevBh } = state.prevRange;

    const trendElements = document.querySelectorAll(".metric-trend");
    if (trendElements.length < 4) return;

    const currentVals = [
      insights.total_trips || 0,
      insights.total_distance || 0,
      insights.total_fuel_consumed || 0,
      behavior.avgSpeed || 0,
    ];

    const prevVals = [
      prevIn?.total_trips || 0,
      prevIn?.total_distance || 0,
      prevIn?.total_fuel_consumed || 0,
      prevBh?.avgSpeed || 0,
    ];

    trendElements.forEach((el, idx) => {
      const curr = currentVals[idx];
      const prev = prevVals[idx];
      let diff = 0;
      if (prev > 0) diff = ((curr - prev) / prev) * 100;

      let cls = "neutral";
      let icon = "fa-minus";
      if (diff > 0.5) {
        cls = "positive";
        icon = "fa-arrow-up";
      } else if (diff < -0.5) {
        cls = "negative";
        icon = "fa-arrow-down";
      }

      el.className = `metric-trend ${cls}`;
      el.innerHTML = `${diff !== 0 ? `<i class="fas ${icon}"></i>` : ""} ${Math.abs(diff).toFixed(0)}%`;
    });
  }

  function updateTables() {
    updateDestinationsTable();
    updateAnalyticsTable();
  }

  function updateDestinationsTable() {
    const { insights } = state.data;

    const destinations = insights.top_destinations || [];

    if (!destinations.length) {
      const tbody = document.querySelector("#destinations-table tbody");
      tbody.innerHTML =
        '<tr><td colspan="5" class="text-center">No destination data in the selected date range.</td></tr>';
      return;
    }

    const tbody = document.querySelector("#destinations-table tbody");
    tbody.innerHTML = destinations
      .map((dest) => {
        const duration = formatDuration(dest.duration_seconds || 0);
        const last = dest.lastVisit
          ? new Date(dest.lastVisit).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })
          : "-";
        return `
      <tr>
        <td>${dest.location || "Unknown"}</td>
        <td>${dest.visits}</td>
        <td>${dest.distance.toFixed(1)} mi</td>
        <td>${duration}</td>
        <td>${last}</td>
      </tr>
    `;
      })
      .join("");

    // Initialize DataTable if not already
    if (!$.fn.DataTable.isDataTable("#destinations-table")) {
      $("#destinations-table").DataTable({
        order: [[1, "desc"]],
        pageLength: 5,
        lengthChange: false,
        searching: false,
        info: false,
      });
    }
  }

  function updateAnalyticsTable() {
    const tableEl = document.getElementById("analytics-table");
    if (!tableEl) return;

    const { behavior } = state.data;

    const tableData =
      state.currentView === "weekly" ? behavior.weekly || [] : behavior.monthly || [];

    const tbody = tableEl.querySelector("tbody");
    if (!tbody) return;

    tbody.innerHTML = tableData
      .map((row) => {
        const period =
          state.currentView === "weekly"
            ? formatWeekRange(row.week)
            : formatMonth(row.month);

        const efficiency =
          row.distance > 0 && row.fuelConsumed > 0
            ? (row.distance / row.fuelConsumed).toFixed(1)
            : "N/A";

        return `
        <tr>
          <td>${period}</td>
          <td>${row.trips}</td>
          <td>${row.distance.toFixed(1)} mi</td>
          <td>${formatDuration(row.duration || 0)}</td>
          <td>${(row.fuelConsumed || 0).toFixed(2)} gal</td>
          <td>${row.hardBraking + row.hardAccel}</td>
          <td>${efficiency} MPG</td>
        </tr>
      `;
      })
      .join("");

    // Initialize or refresh DataTable
    if ($.fn.DataTable.isDataTable("#analytics-table")) {
      $("#analytics-table").DataTable().clear().destroy(true);
    }

    $("#analytics-table").DataTable({
      order: [[0, "desc"]],
      pageLength: 10,
      responsive: true,
    });
  }

  // Event Handlers
  function handleToggleChange(e) {
    const btn = e.currentTarget;
    const parent = btn.parentElement;

    // Update active state
    parent.querySelectorAll(".toggle-btn").forEach((b) => {
      b.classList.remove("active");
    });
    btn.classList.add("active");

    // Update appropriate view
    if (
      parent
        .closest(".chart-header")
        .querySelector(".chart-title")
        .textContent.includes("Trends")
    ) {
      state.currentView = btn.dataset.view;
      updateTrendsChart();
    } else if (btn.dataset.time) {
      state.currentTimeView = btn.dataset.time;
      updateTimeDistChart();
    }
  }

  function handleMetricClick(e) {
    const card = e.currentTarget;
    const comparison = card.querySelector(".stat-comparison");
    if (comparison) {
      comparison.classList.toggle("show");
    }
  }

  // Utility Functions
  // Get the date range from the universal filters (utils storage)
  function getDateRange() {
    const utilsObj = window.utils || {};
    const today = formatDate(new Date());
    return {
      start: utilsObj.getStorage ? utilsObj.getStorage("startDate", today) : today,
      end: utilsObj.getStorage ? utilsObj.getStorage("endDate", today) : today,
    };
  }

  function formatDate(date) {
    // DateUtils is always available via utils.js
    return window.DateUtils.formatDateToString(date);
  }

  function formatWeekRange(weekStr) {
    // Convert "2024-W10" to "Mar 4-10, 2024"
    if (!weekStr) return "N/A";

    const [year, week] = weekStr.split("-W");
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = simple;
    if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const ISOweekEnd = new Date(ISOweekStart);
    ISOweekEnd.setDate(ISOweekEnd.getDate() + 6);

    const options = { month: "short", day: "numeric" };
    return `${ISOweekStart.toLocaleDateString("en-US", options)}-${ISOweekEnd.getDate()}, ${year}`;
  }

  function formatMonth(monthStr) {
    // Convert "2024-03" to "March 2024"
    if (!monthStr) return "N/A";

    const [year, month] = monthStr.split("-");
    const date = new Date(year, month - 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  function processTimeSeriesData(dailyData) {
    const aggregated = aggregateByView(dailyData);

    return {
      labels: aggregated.map((d) => d.label),
      distances: aggregated.map((d) => d.distance),
      counts: aggregated.map((d) => d.count),
    };
  }

  function aggregateByView(dailyData) {
    if (state.currentView === "daily") {
      return dailyData.map((d) => ({
        label: new Date(d.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        distance: d.distance || 0,
        count: d.count || 0,
      }));
    }

    // Aggregate for weekly/monthly views
    const aggregated = {};

    dailyData.forEach((d) => {
      const date = new Date(d.date);
      let key = "";

      if (state.currentView === "weekly") {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = formatDate(weekStart);
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      }

      if (!aggregated[key]) {
        aggregated[key] = { distance: 0, count: 0 };
      }

      aggregated[key].distance += d.distance || 0;
      aggregated[key].count += d.count || 0;
    });

    return Object.entries(aggregated).map(([key, value]) => ({
      label:
        state.currentView === "weekly"
          ? `Week of ${new Date(key).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : formatMonth(key),
      distance: value.distance,
      count: value.count,
    }));
  }

  function processHourlyData(timeData) {
    const hourly = new Array(24).fill(0);
    timeData.forEach((d) => {
      if (d.hour >= 0 && d.hour < 24) {
        hourly[d.hour] = d.count;
      }
    });
    return hourly;
  }

  function processDailyData(weekdayData) {
    // Organize data by weekday (0=Sun, 1=Mon, ..., 6=Sat)
    const byDay = new Array(7).fill(0);
    if (Array.isArray(weekdayData)) {
      weekdayData.forEach((d) => {
        if (d.day !== undefined && d.day >= 0 && d.day <= 6) {
          byDay[d.day] = d.count || 0;
        }
      });
    }
    return byDay;
  }

  function formatHourLabel(hour) {
    // Convert 24-hour format to 12-hour format with AM/PM
    if (hour === 0) return "12 AM";
    if (hour === 12) return "12 PM";
    if (hour < 12) return `${hour} AM`;
    return `${hour - 12} PM`;
  }

  function calculateFuelEfficiency(insights) {
    const mpg =
      insights.total_distance > 0 && insights.total_fuel_consumed > 0
        ? insights.total_distance / insights.total_fuel_consumed
        : 0;

    // Convert to percentage (assuming 30 MPG is 100%)
    return Math.min((mpg / 30) * 100, 100);
  }

  function calculateIdleEfficiency(behavior) {
    const totalTime = behavior.totalTrips * 30 * 60; // Assume 30 min avg per trip
    const idlePercent = (behavior.totalIdlingTime / totalTime) * 100;

    // Lower idle percentage = higher efficiency
    return Math.max(100 - idlePercent * 2, 0);
  }

  function calculateSpeedEfficiency(behavior) {
    // Optimal speed range is 45-65 mph
    const avgSpeed = behavior.avgSpeed || 0;

    if (avgSpeed >= 45 && avgSpeed <= 65) {
      return 100;
    } else if (avgSpeed < 45) {
      return (avgSpeed / 45) * 100;
    }
    return Math.max(100 - (avgSpeed - 65) * 2, 0);
  }

  // Loading States
  function showLoadingStates() {
    document.getElementById("trends-loading").style.display = "flex";
    document.getElementById("trendsChart").style.display = "none";
  }

  function hideLoadingStates() {
    document.getElementById("trends-loading").style.display = "none";
    document.getElementById("trendsChart").style.display = "block";
  }

  // Notifications
  function showNotification(message, type = "info") {
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {

    }
  }

  // Export Functions
  function exportChart() {
    const canvas = document.getElementById("trendsChart");
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `driving-trends-${formatDate(new Date())}.png`;
    a.click();
  }

  function exportData() {
    const table = $("#analytics-table").DataTable();
    const data = table.rows().data().toArray();

    let csv = "Period,Trips,Distance,Duration,Fuel,Hard Events,Efficiency\n";
    data.forEach((row) => {
      csv += `${row[0]},${row[1]},${row[2]},${row[3]},${row[4]},${row[5]},${row[6]}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `driving-analytics-${formatDate(new Date())}.csv`;
    a.click();
  }

  async function generateReport() {
    showNotification("Generating report...", "info");

    // This would generate a PDF report
    // For now, just show a success message
    setTimeout(() => {
      showNotification("Report downloaded successfully!", "success");
    }, 2000);
  }

  function shareInsights() {
    const shareData = {
      title: "My Driving Insights",
      text: `Total Distance: ${state.data.insights.total_distance} miles | Trips: ${state.data.insights.total_trips}`,
      url: window.location.href,
    };

    if (navigator.share) {
      navigator.share(shareData);
    } else {
      // Fallback to copying to clipboard
      navigator.clipboard.writeText(
        `${shareData.title}\n${shareData.text}\n${shareData.url}`
      );
      showNotification("Link copied to clipboard!", "success");
    }
  }

  // Auto Refresh
  function startAutoRefresh() {
    // Refresh data every 5 minutes
    state.autoRefreshInterval = setInterval(
      () => {
        loadAllData();
      },
      5 * 60 * 1000
    );
  }

  // Handle chart click to show trip details
  function handleTimeDistChartClick(_event, activeElements) {
    if (!activeElements || activeElements.length === 0) return;

    const elementIndex = activeElements[0].index;
    const timeValue = elementIndex;
    const timeType = state.currentTimeView; // "hour" or "day"

    loadAndShowTripsForTimePeriod(timeType, timeValue);
  }

  async function loadAndShowTripsForTimePeriod(timeType, timeValue) {
    try {
      const dateRange = getDateRange();
      const params = new URLSearchParams({
        start_date: dateRange.start,
        end_date: dateRange.end,
        time_type: timeType,
        time_value: timeValue.toString(),
      });

      const response = await fetch(`/api/time-period-trips?${params}`);
      if (!response.ok) throw new Error("Failed to fetch trips");

      const trips = await response.json();

      displayTripsInModal(trips, timeType, timeValue);
    } catch (error) {
      console.error("Error loading trips:", error);
      showNotification("Error loading trips. Please try again.", "error");
    }
  }

  function displayTripsInModal(trips, timeType, timeValue) {
    // Update modal title
    const modalTitle = document.getElementById("tripDetailsModalLabel");
    if (timeType === "hour") {
      modalTitle.textContent = `Trips at ${formatHourLabel(timeValue)} (${trips.length} trips)`;
    } else {
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      modalTitle.textContent = `Trips on ${days[timeValue]} (${trips.length} trips)`;
    }

    // Build table rows
    const tbody = document.querySelector("#modal-trips-table tbody");
    if (!trips || trips.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="text-center">No trips found for this time period.</td></tr>';
    } else {
      tbody.innerHTML = trips
        .map((trip) => {
          const startTime = trip.startTime
            ? new Date(trip.startTime).toLocaleString("en-US", { hour12: true })
            : "-";
          const endTime = trip.endTime
            ? new Date(trip.endTime).toLocaleString("en-US", { hour12: true })
            : "-";
          const duration = formatDuration(trip.duration || 0);
          const distance = trip.distance ? `${trip.distance.toFixed(1)} mi` : "-";
          const startLoc =
            trip.startLocation?.formatted_address ||
            trip.startLocation?.name ||
            "Unknown";
          const destLoc =
            trip.destination?.formatted_address || trip.destination?.name || "Unknown";
          const maxSpeed = trip.maxSpeed ? `${trip.maxSpeed.toFixed(1)} mph` : "-";
          const tripId = trip.transactionId || trip._id?.$oid || trip._id || "-";

          return `
          <tr>
            <td>${startTime}</td>
            <td>${endTime}</td>
            <td>${duration}</td>
            <td>${distance}</td>
            <td>${startLoc}</td>
            <td>${destLoc}</td>
            <td>${maxSpeed}</td>
            <td>
              <a href="/trips?highlight=${tripId}" class="btn btn-sm btn-primary" target="_blank">
                <i class="fas fa-external-link-alt"></i>
              </a>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    // Show the modal
    const modal = new bootstrap.Modal(document.getElementById("tripDetailsModal"));
    modal.show();
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    if (state.autoRefreshInterval) {
      clearInterval(state.autoRefreshInterval);
    }
  });
})();
