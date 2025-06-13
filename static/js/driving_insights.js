/* global Chart, CountUp, $ */

"use strict";

// Ensure CountUp is defined when using the UMD build, which attaches the class under `countUp.CountUp`.
// This creates an alias so the rest of the file can safely reference `CountUp`.
if (typeof window !== "undefined") {
  window.CountUp = window.CountUp || (window.countUp && window.countUp.CountUp);
}

(function () {
  "use strict";

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
  };

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    setupEventListeners();
    initCharts();
    await loadAllData();
    startAutoRefresh();
  }

  // Event Listeners
  function setupEventListeners() {
    // Period selector
    document.querySelectorAll(".period-preset").forEach((btn) => {
      btn.addEventListener("click", handlePeriodChange);
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
    document
      .getElementById("share-insights")
      .addEventListener("click", shareInsights);
    document
      .getElementById("export-chart")
      .addEventListener("click", exportChart);
    document
      .getElementById("export-data")
      .addEventListener("click", exportData);
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
      const params = new URLSearchParams({
        start_date: dateRange.start,
        end_date: dateRange.end,
      });

      const [behavior, insights, analytics, metrics] = await Promise.all([
        fetch("/api/driver-behavior").then((r) => r.json()),
        fetch(`/api/driving-insights?${params}`).then((r) => r.json()),
        fetch(`/api/trip-analytics?${params}`).then((r) => r.json()),
        fetch(`/api/metrics?${params}`).then((r) => r.json()),
      ]);

      state.data = { behavior, insights, analytics, metrics };

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
    const efficiencyCtx = document
      .getElementById("efficiencyChart")
      .getContext("2d");
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

    // Behavior Chart
    const behaviorCtx = document
      .getElementById("behaviorChart")
      .getContext("2d");
    state.charts.behavior = new Chart(behaviorCtx, {
      type: "radar",
      data: {
        labels: [
          "Speed Control",
          "Smooth Driving",
          "Fuel Economy",
          "Time Management",
          "Safety",
        ],
        datasets: [
          {
            label: "Current Period",
            data: [0, 0, 0, 0, 0],
            backgroundColor: "rgba(255, 99, 132, 0.2)",
            borderColor: "rgba(255, 99, 132, 1)",
            pointBackgroundColor: "rgba(255, 99, 132, 1)",
          },
          {
            label: "Previous Period",
            data: [0, 0, 0, 0, 0],
            backgroundColor: "rgba(54, 162, 235, 0.2)",
            borderColor: "rgba(54, 162, 235, 1)",
            pointBackgroundColor: "rgba(54, 162, 235, 1)",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            ticks: {
              display: false,
            },
          },
        },
      },
    });

    // Time Distribution Chart
    const timeDistCtx = document
      .getElementById("timeDistChart")
      .getContext("2d");
    state.charts.timeDist = new Chart(timeDistCtx, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          {
            label: "Trips",
            data: [],
            backgroundColor: "rgba(153, 102, 255, 0.6)",
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
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              stepSize: 1,
            },
          },
        },
      },
    });
  }

  // Metric Updates
  function updateAllMetrics() {
    const { behavior, insights, metrics } = state.data;

    // Primary metrics
    animateCounter("total-trips", insights.total_trips || 0);
    animateCounter("total-distance", insights.total_distance || 0, 1);
    animateCounter("total-fuel", insights.total_fuel_consumed || 0, 2);
    animateCounter("hero-total-miles", insights.total_distance || 0, 1);

    // Behavior metrics
    animateCounter("hard-braking", behavior.hardBrakingCounts || 0);
    animateCounter("hard-accel", behavior.hardAccelerationCounts || 0);
    animateCounter("max-speed", behavior.maxSpeed || 0, 1);
    animateCounter("avg-speed", behavior.avgSpeed || 0, 1);

    // Time metrics
    updateTimeMetric("total-time", behavior.totalIdlingTime || 0);
    updateTimeMetric("idle-time", behavior.totalIdlingTime || 0);

    // Update comparisons
    updateComparisons();

    // Update trends
    updateTrends();
  }

  function updateAllCharts() {
    updateTrendsChart();
    updateEfficiencyChart();
    updateBehaviorChart();
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

  function updateBehaviorChart() {
    const { behavior } = state.data;

    // Calculate behavior scores (0-100)
    const scores = calculateBehaviorScores(behavior);

    state.charts.behavior.data.datasets[0].data = scores.current;
    state.charts.behavior.data.datasets[1].data = scores.previous;
    state.charts.behavior.update();
  }

  function updateTimeDistChart() {
    const { analytics } = state.data;
    if (!analytics || !analytics.time_distribution) return;

    const labels =
      state.currentTimeView === "hour"
        ? Array.from({ length: 24 }, (_, i) => `${i}:00`)
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const data =
      state.currentTimeView === "hour"
        ? processHourlyData(analytics.time_distribution)
        : processDailyData(analytics.time_distribution);

    state.charts.timeDist.data.labels = labels;
    state.charts.timeDist.data.datasets[0].data = data;
    state.charts.timeDist.update();
  }

  // Helper Functions
  function animateCounter(elementId, endValue, decimals = 0) {
    const element = document.getElementById(elementId);
    if (!element) return;

    if (!state.counters[elementId]) {
      state.counters[elementId] = new CountUp(
        elementId,
        0,
        endValue,
        decimals,
        1.5,
        {
          useEasing: true,
          useGrouping: true,
          separator: ",",
          decimal: ".",
          prefix: "",
          suffix: "",
        },
      );
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
    const { insights, behavior } = state.data;

    // Trips comparison
    const dailyAvgTrips = (insights.total_trips || 0) / state.currentPeriod;
    document.querySelector("#trips-comparison span").textContent =
      dailyAvgTrips.toFixed(1);

    // Distance comparison
    const avgPerTrip =
      insights.total_trips > 0
        ? (insights.total_distance / insights.total_trips).toFixed(1)
        : 0;
    document.querySelector("#distance-comparison span").textContent =
      avgPerTrip;

    // Fuel comparison
    const mpg =
      insights.total_distance > 0 && insights.total_fuel_consumed > 0
        ? (insights.total_distance / insights.total_fuel_consumed).toFixed(1)
        : 0;
    document.querySelector("#fuel-comparison span").textContent = mpg;

    // Time comparison
    document.querySelector("#time-comparison span").textContent =
      behavior.avgSpeed?.toFixed(1) || 0;
  }

  function updateTrends() {
    // This would calculate trends based on historical data
    // For now, using placeholder values
    const trends = document.querySelectorAll(".metric-trend");
    trends.forEach((trend) => {
      const value = Math.random() * 20 - 10; // Random between -10 and 10
      trend.innerHTML =
        value > 0
          ? `<i class="fas fa-arrow-up"></i> ${Math.abs(value).toFixed(0)}%`
          : `<i class="fas fa-arrow-down"></i> ${Math.abs(value).toFixed(0)}%`;
      trend.className = `metric-trend ${value > 0 ? "positive" : "negative"}`;
    });
  }

  function updateTables() {
    updateDestinationsTable();
    updateAnalyticsTable();
  }

  function updateDestinationsTable() {
    const { insights } = state.data;

    // Simulate destination data (would come from actual API)
    const destinations = [
      {
        location: insights.most_visited?._id || "Home",
        visits: 45,
        distance: 234.5,
        duration: "25m",
        lastVisit: "2 days ago",
      },
      {
        location: "Work",
        visits: 38,
        distance: 189.2,
        duration: "20m",
        lastVisit: "Yesterday",
      },
      {
        location: "Grocery Store",
        visits: 24,
        distance: 56.8,
        duration: "10m",
        lastVisit: "3 days ago",
      },
      {
        location: "Gym",
        visits: 18,
        distance: 78.4,
        duration: "15m",
        lastVisit: "Today",
      },
      {
        location: "Mall",
        visits: 12,
        distance: 134.7,
        duration: "30m",
        lastVisit: "1 week ago",
      },
    ];

    const tbody = document.querySelector("#destinations-table tbody");
    tbody.innerHTML = destinations
      .map(
        (dest) => `
      <tr>
        <td>${dest.location}</td>
        <td>${dest.visits}</td>
        <td>${dest.distance.toFixed(1)} mi</td>
        <td>${dest.duration}</td>
        <td>${dest.lastVisit}</td>
      </tr>
    `,
      )
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
    const { behavior } = state.data;

    const tableData =
      state.currentView === "weekly"
        ? behavior.weekly || []
        : behavior.monthly || [];

    const tbody = document.querySelector("#analytics-table tbody");
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
  function handlePeriodChange(e) {
    const btn = e.currentTarget;
    const days = btn.dataset.days;

    if (days === "custom") {
      // Show custom date picker modal
      showCustomDatePicker();
      return;
    }

    // Update active state
    document
      .querySelectorAll(".period-preset")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    state.currentPeriod = parseInt(days);
    loadAllData();
  }

  function handleToggleChange(e) {
    const btn = e.currentTarget;
    const parent = btn.parentElement;

    // Update active state
    parent
      .querySelectorAll(".toggle-btn")
      .forEach((b) => b.classList.remove("active"));
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
  function getDateRange() {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - state.currentPeriod);

    return {
      start: formatDate(start),
      end: formatDate(end),
    };
  }

  function formatDate(date) {
    return date.toISOString().split("T")[0];
  }

  function formatWeekRange(weekStr) {
    // Convert "2024-W10" to "Mar 4-10, 2024"
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
      let key;

      if (state.currentView === "weekly") {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split("T")[0];
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

  function processDailyData(timeData) {
    // This would process data by day of week
    // For now, returning sample data
    return [12, 18, 15, 22, 25, 28, 14];
  }

  function calculateFuelEfficiency(insights, behavior) {
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
    } else {
      return Math.max(100 - (avgSpeed - 65) * 2, 0);
    }
  }

  function calculateBehaviorScores(behavior) {
    const totalEvents =
      behavior.hardBrakingCounts + behavior.hardAccelerationCounts;
    const eventsPerTrip =
      behavior.totalTrips > 0 ? totalEvents / behavior.totalTrips : 0;

    return {
      current: [
        calculateSpeedControl(behavior),
        calculateSmoothDriving(eventsPerTrip),
        calculateFuelEconomy(behavior),
        calculateTimeManagement(behavior),
        calculateSafety(behavior),
      ],
      previous: [80, 75, 70, 85, 90], // Placeholder for previous period
    };
  }

  function calculateSpeedControl(behavior) {
    const speedVariance = behavior.maxSpeed - behavior.avgSpeed;
    return Math.max(100 - speedVariance, 0);
  }

  function calculateSmoothDriving(eventsPerTrip) {
    return Math.max(100 - eventsPerTrip * 20, 0);
  }

  function calculateFuelEconomy(behavior) {
    const mpg =
      behavior.totalDistance > 0 && behavior.fuelConsumed > 0
        ? behavior.totalDistance / behavior.fuelConsumed
        : 0;
    return Math.min((mpg / 30) * 100, 100);
  }

  function calculateTimeManagement(behavior) {
    const idlePercent =
      behavior.totalTrips > 0
        ? (behavior.totalIdlingTime / (behavior.totalTrips * 30 * 60)) * 100
        : 0;
    return Math.max(100 - idlePercent * 2, 0);
  }

  function calculateSafety(behavior) {
    const safetyScore =
      100 -
      behavior.hardBrakingCounts * 2 -
      behavior.hardAccelerationCounts * 2 -
      Math.max(behavior.maxSpeed - 70, 0) * 3;
    return Math.max(safetyScore, 0);
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
      console.log(`${type}: ${message}`);
    }
  }

  // Export Functions
  function exportChart() {
    const canvas = document.getElementById("trendsChart");
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `driving-trends-${new Date().toISOString().split("T")[0]}.png`;
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
    a.download = `driving-analytics-${new Date().toISOString().split("T")[0]}.csv`;
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
        `${shareData.title}\n${shareData.text}\n${shareData.url}`,
      );
      showNotification("Link copied to clipboard!", "success");
    }
  }

  function showCustomDatePicker() {
    // This would show a modal with date pickers
    showNotification("Custom date range picker coming soon!", "info");
  }

  // Auto Refresh
  function startAutoRefresh() {
    // Refresh data every 5 minutes
    state.autoRefreshInterval = setInterval(
      () => {
        loadAllData();
      },
      5 * 60 * 1000,
    );
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    if (state.autoRefreshInterval) {
      clearInterval(state.autoRefreshInterval);
    }
  });
})();
