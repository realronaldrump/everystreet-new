/* global Chart */
/**
 * Insights Charts Module (ES6)
 * Chart initialization and update logic for the driving insights page
 */

import { formatDate, formatHourLabel, formatMonth } from "./formatters.js";
import { loadAndShowTripsForTimePeriod } from "./modal.js";
import { getChart, getState, setChart } from "./state.js";

const spotlightPlugin = {
  id: "spotlight",
  afterEvent(chart, _args) {
    const active = chart.getActiveElements();
    const activeDataset = active.length ? active[0].datasetIndex : null;
    const datasets = chart.data.datasets || [];
    let didUpdate = false;

    datasets.forEach((dataset, index) => {
      if (!dataset._origColors) {
        dataset._origColors = {
          backgroundColor: dataset.backgroundColor,
          borderColor: dataset.borderColor,
        };
      }

      const dim = activeDataset !== null && index !== activeDataset;
      const targetAlpha = dim ? 0.25 : 1;

      const applyAlpha = (color) => {
        if (!color || typeof color !== "string") {
          return color;
        }
        if (color.startsWith("rgba")) {
          return color.replace(
            /rgba\\(([^,]+),\\s*([^,]+),\\s*([^,]+),\\s*[^)]+\\)/,
            `rgba($1, $2, $3, ${targetAlpha})`
          );
        }
        if (color.startsWith("rgb")) {
          return color.replace(
            /rgb\\(([^,]+),\\s*([^,]+),\\s*([^,]+)\\)/,
            `rgba($1, $2, $3, ${targetAlpha})`
          );
        }
        return color;
      };

      const orig = dataset._origColors;
      const nextBackground = Array.isArray(orig.backgroundColor)
        ? orig.backgroundColor.map(applyAlpha)
        : applyAlpha(orig.backgroundColor);
      const nextBorder = Array.isArray(orig.borderColor)
        ? orig.borderColor.map(applyAlpha)
        : applyAlpha(orig.borderColor);

      if (
        dataset.backgroundColor !== nextBackground
        || dataset.borderColor !== nextBorder
      ) {
        dataset.backgroundColor = nextBackground;
        dataset.borderColor = nextBorder;
        didUpdate = true;
      }
    });

    if (didUpdate) {
      chart.update("none");
    }
  },
};

function attachZoomPan(chart) {
  const labels = chart.data.labels || [];
  if (labels.length < 5) {
    return;
  }

  const state = {
    minIndex: 0,
    maxIndex: labels.length - 1,
    dragStartX: 0,
    dragStartMin: 0,
    dragStartMax: 0,
    dragging: false,
    pinchStartDistance: 0,
  };

  const clampRange = () => {
    const minRange = Math.min(10, labels.length - 1);
    const maxRange = labels.length - 1;
    const range = Math.max(
      minRange,
      Math.min(maxRange, state.maxIndex - state.minIndex)
    );
    const center = (state.minIndex + state.maxIndex) / 2;
    state.minIndex = Math.max(0, Math.round(center - range / 2));
    state.maxIndex = Math.min(labels.length - 1, Math.round(center + range / 2));
  };

  const applyRange = () => {
    chart.options.scales.x.min = labels[state.minIndex];
    chart.options.scales.x.max = labels[state.maxIndex];
    chart.update("none");
  };

  chart.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const zoomFactor = event.deltaY > 0 ? 1.2 : 0.8;
    const range = state.maxIndex - state.minIndex;
    const center = (state.minIndex + state.maxIndex) / 2;
    const newRange = Math.max(
      5,
      Math.min(labels.length - 1, Math.round(range * zoomFactor))
    );
    state.minIndex = Math.round(center - newRange / 2);
    state.maxIndex = Math.round(center + newRange / 2);
    clampRange();
    applyRange();
  });

  chart.canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") {
      return;
    }
    state.dragging = true;
    state.dragStartX = event.clientX;
    state.dragStartMin = state.minIndex;
    state.dragStartMax = state.maxIndex;
    chart.canvas.setPointerCapture(event.pointerId);
  });

  chart.canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) {
      return;
    }
    const deltaX = event.clientX - state.dragStartX;
    const range = state.dragStartMax - state.dragStartMin;
    const shift = Math.round((-deltaX / chart.canvas.clientWidth) * range);
    state.minIndex = state.dragStartMin + shift;
    state.maxIndex = state.dragStartMax + shift;
    clampRange();
    applyRange();
  });

  chart.canvas.addEventListener("pointerup", () => {
    state.dragging = false;
  });

  chart.canvas.addEventListener("pointercancel", () => {
    state.dragging = false;
  });

  chart.canvas.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) {
      return;
    }
    const [a, b] = event.touches;
    state.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  });

  chart.canvas.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 2 || !state.pinchStartDistance) {
      return;
    }
    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const zoomFactor = distance > state.pinchStartDistance ? 0.9 : 1.1;
    const range = state.maxIndex - state.minIndex;
    const center = (state.minIndex + state.maxIndex) / 2;
    const newRange = Math.max(
      5,
      Math.min(labels.length - 1, Math.round(range * zoomFactor))
    );
    state.minIndex = Math.round(center - newRange / 2);
    state.maxIndex = Math.round(center + newRange / 2);
    clampRange();
    applyRange();
    state.pinchStartDistance = distance;
  });
}

function attachLongPressTooltip(chart) {
  let timerId = null;

  const showTooltip = (event) => {
    const points = chart.getElementsAtEventForMode(
      event,
      "nearest",
      { intersect: false },
      true
    );
    if (!points.length) {
      return;
    }
    chart.setActiveElements(points);
    chart.tooltip.setActiveElements(points, {
      x: points[0].element.x,
      y: points[0].element.y,
    });
    chart.update("none");
  };

  chart.canvas.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        return;
      }
      timerId = setTimeout(() => showTooltip(event), 450);
    },
    { passive: true }
  );

  chart.canvas.addEventListener("touchend", () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  });
}

/**
 * Initialize all charts
 */
export function initCharts() {
  initTrendsChart();
  initEfficiencyChart();
  initTimeDistChart();
}

/**
 * Initialize the trends chart (line chart for distance and trips)
 */
function initTrendsChart() {
  const trendsCtx = document.getElementById("trendsChart")?.getContext("2d");
  if (!trendsCtx) {
    return;
  }

  const chart = new Chart(trendsCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Distance",
          data: [],
          borderColor: "rgb(59, 138, 127)",
          backgroundColor: "rgba(59, 138, 127, 0.12)",
          yAxisID: "y",
          tension: 0.3,
        },
        {
          label: "Trips",
          data: [],
          borderColor: "rgb(196, 84, 84)",
          backgroundColor: "rgba(196, 84, 84, 0.12)",
          yAxisID: "y1",
          tension: 0.3,
        },
      ],
    },
    plugins: [spotlightPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: "easeOutQuart",
      },
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
              if (label) {
                label += ": ";
              }
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

  setChart("trends", chart);
  attachZoomPan(chart);
  attachLongPressTooltip(chart);
}

/**
 * Initialize the efficiency chart (doughnut chart)
 */
function initEfficiencyChart() {
  const efficiencyCtx = document.getElementById("efficiencyChart")?.getContext("2d");
  if (!efficiencyCtx) {
    return;
  }

  const chart = new Chart(efficiencyCtx, {
    type: "doughnut",
    data: {
      labels: ["Fuel Efficiency", "Idle Efficiency", "Speed Efficiency"],
      datasets: [
        {
          data: [0, 0, 0],
          backgroundColor: [
            "rgba(77, 154, 106, 0.8)",
            "rgba(212, 162, 74, 0.8)",
            "rgba(90, 134, 176, 0.8)",
          ],
          borderWidth: 0,
        },
      ],
    },
    plugins: [spotlightPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        animateRotate: true,
        animateScale: true,
        duration: 900,
        easing: "easeOutQuart",
      },
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

  setChart("efficiency", chart);
}

/**
 * Initialize the time distribution chart (bar chart)
 */
function initTimeDistChart() {
  const timeDistCtx = document.getElementById("timeDistChart")?.getContext("2d");
  if (!timeDistCtx) {
    return;
  }

  const chart = new Chart(timeDistCtx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "Trips",
          data: [],
          backgroundColor: "rgba(106, 114, 160, 0.6)",
          hoverBackgroundColor: "rgba(106, 114, 160, 0.9)",
          borderColor: "rgba(106, 114, 160, 1)",
          borderWidth: 0,
          hoverBorderWidth: 2,
        },
      ],
    },
    plugins: [spotlightPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: "easeOutQuart",
      },
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

  setChart("timeDist", chart);
  attachLongPressTooltip(chart);
}

/**
 * Update all charts with current data
 */
export function updateAllCharts() {
  updateTrendsChart();
  updateEfficiencyChart();
  updateTimeDistChart();
}

/**
 * Update the trends chart with time series data
 */
export function updateTrendsChart() {
  const state = getState();
  const { analytics } = state.data;
  if (!analytics || !analytics.daily_distances) {
    return;
  }

  const data = processTimeSeriesData(analytics.daily_distances, state.currentView);

  const chart = getChart("trends");
  if (!chart) {
    return;
  }

  chart.data.labels = data.labels;
  chart.data.datasets[0].data = data.distances;
  chart.data.datasets[1].data = data.counts;
  chart.update();
}

/**
 * Update the efficiency chart with calculated scores
 */
export function updateEfficiencyChart() {
  const state = getState();
  const { insights, behavior } = state.data;

  const fuelEfficiency = calculateFuelEfficiency(insights, behavior);
  const idleEfficiency = calculateIdleEfficiency(behavior);
  const speedEfficiency = calculateSpeedEfficiency(behavior);

  const chart = getChart("efficiency");
  if (!chart) {
    return;
  }

  chart.data.datasets[0].data = [fuelEfficiency, idleEfficiency, speedEfficiency];
  chart.update();
}

/**
 * Update the time distribution chart
 */
export function updateTimeDistChart() {
  const state = getState();
  const { analytics } = state.data;
  if (!analytics || !analytics.time_distribution) {
    return;
  }

  const labels
    = state.currentTimeView === "hour"
      ? Array.from({ length: 24 }, (_, i) => formatHourLabel(i))
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const data
    = state.currentTimeView === "hour"
      ? processHourlyData(analytics.time_distribution)
      : processDailyData(analytics.weekday_distribution);

  const chart = getChart("timeDist");
  if (!chart) {
    return;
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.update();
}

// Data Processing Functions

/**
 * Process time series data for the trends chart
 * @param {Array} dailyData - Daily data points
 * @param {string} viewType - View type (daily, weekly, monthly)
 * @returns {Object} Processed data with labels, distances, and counts
 */
function processTimeSeriesData(dailyData, viewType) {
  const aggregated = aggregateByView(dailyData, viewType);

  return {
    labels: aggregated.map((d) => d.label),
    distances: aggregated.map((d) => d.distance),
    counts: aggregated.map((d) => d.count),
  };
}

/**
 * Aggregate data by view type
 * @param {Array} dailyData - Daily data points
 * @param {string} viewType - View type (daily, weekly, monthly)
 * @returns {Array} Aggregated data
 */
function aggregateByView(dailyData, viewType) {
  if (viewType === "daily") {
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

    if (viewType === "weekly") {
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
      viewType === "weekly"
        ? `Week of ${new Date(key).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : formatMonth(key),
    distance: value.distance,
    count: value.count,
  }));
}

/**
 * Process hourly data for the time distribution chart
 * @param {Array} timeData - Time distribution data
 * @returns {Array} Hourly counts array (24 elements)
 */
function processHourlyData(timeData) {
  const hourly = new Array(24).fill(0);
  timeData.forEach((d) => {
    if (d.hour >= 0 && d.hour < 24) {
      hourly[d.hour] = d.count;
    }
  });
  return hourly;
}

/**
 * Process daily data for the weekday distribution chart
 * @param {Array} weekdayData - Weekday distribution data
 * @returns {Array} Weekday counts array (7 elements)
 */
function processDailyData(weekdayData) {
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

// Efficiency Calculation Functions

/**
 * Calculate fuel efficiency score (0-100)
 * @param {Object} insights - Insights data
 */
export function calculateFuelEfficiency(insights) {
  const mpg
    = insights.total_distance > 0 && insights.total_fuel_consumed > 0
      ? insights.total_distance / insights.total_fuel_consumed
      : 0;

  // Convert to percentage (assuming 30 MPG is 100%)
  return Math.min((mpg / 30) * 100, 100);
}

/**
 * Calculate idle efficiency score (0-100)
 * @param {Object} behavior - Behavior data
 * @returns {number} Idle efficiency percentage
 */
export function calculateIdleEfficiency(behavior) {
  const totalTime = behavior.totalTrips * 30 * 60; // Assume 30 min avg per trip
  const idleSeconds = behavior.totalIdleDuration || 0;
  const idlePercent = (idleSeconds / totalTime) * 100;

  // Lower idle percentage = higher efficiency
  return Math.max(100 - idlePercent * 2, 0);
}

/**
 * Calculate speed efficiency score (0-100)
 * @param {Object} behavior - Behavior data
 * @returns {number} Speed efficiency percentage
 */
export function calculateSpeedEfficiency(behavior) {
  // Optimal speed range is 45-65 mph
  const avgSpeed = behavior.avgSpeed || 0;

  if (avgSpeed >= 45 && avgSpeed <= 65) {
    return 100;
  }
  if (avgSpeed < 45) {
    return (avgSpeed / 45) * 100;
  }
  return Math.max(100 - (avgSpeed - 65) * 2, 0);
}

/**
 * Handle click on time distribution chart bar
 * @param {Event} _event - Chart click event
 * @param {Array} activeElements - Active chart elements
 */
function handleTimeDistChartClick(_event, activeElements) {
  if (!activeElements || activeElements.length === 0) {
    return;
  }

  const state = getState();
  const elementIndex = activeElements[0].index;
  const timeValue = elementIndex;
  const timeType = state.currentTimeView; // "hour" or "day"

  loadAndShowTripsForTimePeriod(timeType, timeValue);
}
