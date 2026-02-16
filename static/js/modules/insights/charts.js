/* global Chart */
/**
 * Insights Charts Module (ES6)
 * Chart initialization and update logic for the driving insights page
 */

import { formatDate, formatHourLabel } from "./formatters.js";
import {
  loadAndShowTripsForDrilldown,
  loadAndShowTripsForTimePeriod,
} from "./modal.js";
import { getChart, getState, setChart } from "./state.js";

const chartCleanupKey = "_esCleanup";

function registerChartCleanup(chart, cleanup) {
  if (!chart || typeof cleanup !== "function") {
    return;
  }
  if (!Array.isArray(chart[chartCleanupKey])) {
    chart[chartCleanupKey] = [];
  }
  chart[chartCleanupKey].push(cleanup);
}

function destroyChartInstance(chart) {
  if (!chart) {
    return;
  }
  const cleanups = chart[chartCleanupKey];
  if (Array.isArray(cleanups)) {
    cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.warn("Failed to clean up chart listener:", error);
      }
    });
    chart[chartCleanupKey] = [];
  }
  if (typeof chart.destroy === "function") {
    chart.destroy();
  }
}

function findChartForCanvas(canvas) {
  if (!canvas || typeof Chart === "undefined") {
    return null;
  }
  if (typeof Chart.getChart === "function") {
    return Chart.getChart(canvas);
  }
  const { instances } = Chart;
  if (!instances) {
    return null;
  }
  const charts = Array.isArray(instances) ? instances : Object.values(instances);
  return charts.find((chart) => chart && chart.canvas === canvas) || null;
}

export function destroyCharts() {
  const state = getState();
  const charts = state.charts || {};
  Object.values(charts).forEach((chart) => destroyChartInstance(chart));
  state.charts = {};
}

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
        dataset.backgroundColor !== nextBackground ||
        dataset.borderColor !== nextBorder
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
    return null;
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

  const handleWheel = (event) => {
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
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === "touch") {
      return;
    }
    state.dragging = true;
    state.dragStartX = event.clientX;
    state.dragStartMin = state.minIndex;
    state.dragStartMax = state.maxIndex;
    chart.canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
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
  };

  const handlePointerUp = () => {
    state.dragging = false;
  };

  const handlePointerCancel = () => {
    state.dragging = false;
  };

  const handleTouchStart = (event) => {
    if (event.touches.length !== 2) {
      return;
    }
    const [a, b] = event.touches;
    state.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };

  const handleTouchMove = (event) => {
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
  };

  chart.canvas.addEventListener("wheel", handleWheel);
  chart.canvas.addEventListener("pointerdown", handlePointerDown);
  chart.canvas.addEventListener("pointermove", handlePointerMove);
  chart.canvas.addEventListener("pointerup", handlePointerUp);
  chart.canvas.addEventListener("pointercancel", handlePointerCancel);
  chart.canvas.addEventListener("touchstart", handleTouchStart, { passive: true });
  chart.canvas.addEventListener("touchmove", handleTouchMove);

  return () => {
    chart.canvas.removeEventListener("wheel", handleWheel);
    chart.canvas.removeEventListener("pointerdown", handlePointerDown);
    chart.canvas.removeEventListener("pointermove", handlePointerMove);
    chart.canvas.removeEventListener("pointerup", handlePointerUp);
    chart.canvas.removeEventListener("pointercancel", handlePointerCancel);
    chart.canvas.removeEventListener("touchstart", handleTouchStart);
    chart.canvas.removeEventListener("touchmove", handleTouchMove);
  };
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

  const handleTouchStart = (event) => {
    if (event.touches.length !== 1) {
      return;
    }
    timerId = setTimeout(() => showTooltip(event), 450);
  };

  const handleTouchEnd = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  chart.canvas.addEventListener("touchstart", handleTouchStart, { passive: true });
  chart.canvas.addEventListener("touchend", handleTouchEnd);

  return () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    chart.canvas.removeEventListener("touchstart", handleTouchStart);
    chart.canvas.removeEventListener("touchend", handleTouchEnd);
  };
}

/**
 * Initialize all charts
 */
export function initCharts() {
  destroyCharts();
  initTrendsChart();
  initTimeDistChart();
}

/**
 * Initialize the trends chart (line chart for distance and trips)
 */
function initTrendsChart() {
  const trendsCanvas = document.getElementById("trendsChart");
  const trendsCtx = trendsCanvas?.getContext("2d");
  if (!trendsCtx) {
    return;
  }

  const existingChart = findChartForCanvas(trendsCtx.canvas) || getChart("trends");
  if (existingChart) {
    destroyChartInstance(existingChart);
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
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
        },
        {
          label: "Trips",
          data: [],
          borderColor: "rgb(196, 84, 84)",
          backgroundColor: "rgba(196, 84, 84, 0.12)",
          yAxisID: "y1",
          pointRadius: 0,
          pointHoverRadius: 4,
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
        decimation: {
          enabled: true,
          algorithm: "lttb",
          samples: 200,
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
            afterBody: () => "Click to view trips",
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
          ticks: {
            autoSkip: true,
            maxTicksLimit: 14,
            maxRotation: 0,
            minRotation: 0,
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
      onClick: handleTrendsChartClick,
    },
  });

  setChart("trends", chart);
  registerChartCleanup(chart, attachZoomPan(chart));
  registerChartCleanup(chart, attachLongPressTooltip(chart));
}

/**
 * Initialize the time distribution chart (bar chart)
 */
function initTimeDistChart() {
  const timeDistCanvas = document.getElementById("timeDistChart");
  const timeDistCtx = timeDistCanvas?.getContext("2d");
  if (!timeDistCtx) {
    return;
  }

  const existingChart = findChartForCanvas(timeDistCtx.canvas) || getChart("timeDist");
  if (existingChart) {
    destroyChartInstance(existingChart);
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
  registerChartCleanup(chart, attachLongPressTooltip(chart));
}

/**
 * Update all charts with current data
 */
export function updateAllCharts() {
  updateTrendsChart();
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
  chart.data.datasets[0].tension = data.isCompressed ? 0.18 : 0.3;
  chart.data.datasets[1].tension = data.isCompressed ? 0.18 : 0.3;
  chart.data.datasets[0].pointHoverRadius = data.isCompressed ? 3 : 4;
  chart.data.datasets[1].pointHoverRadius = data.isCompressed ? 3 : 4;
  chart._esBucketRanges = data.ranges;

  const totalPoints = data.labels.length;
  const maxTicksLimit =
    totalPoints > 240 ? 6 : totalPoints > 160 ? 8 : totalPoints > 90 ? 10 : 14;
  if (chart.options?.scales?.x?.ticks) {
    chart.options.scales.x.ticks.maxTicksLimit = maxTicksLimit;
    chart.options.scales.x.ticks.autoSkip = true;
    chart.options.scales.x.ticks.maxRotation = totalPoints > 80 ? 0 : 30;
    chart.options.scales.x.ticks.minRotation = 0;
    chart.options.scales.x.ticks.callback = function callback(value) {
      const label = this.getLabelForValue(value);
      if (typeof label !== "string") {
        return label;
      }
      return label.length > 18 ? `${label.slice(0, 17)}…` : label;
    };
  }

  if (chart.options?.plugins?.decimation) {
    chart.options.plugins.decimation.enabled = totalPoints > 80;
    chart.options.plugins.decimation.samples = Math.min(
      280,
      Math.max(100, Math.floor(totalPoints * 0.7))
    );
  }
  if (chart.options?.animation) {
    chart.options.animation.duration = data.isCompressed ? 450 : 900;
  }

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

  const labels =
    state.currentTimeView === "hour"
      ? Array.from({ length: 24 }, (_, i) => formatHourLabel(i))
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const data =
    state.currentTimeView === "hour"
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
  const compressed = compressSeriesIfNeeded(aggregated, viewType);

  return {
    labels: compressed.map((d) => d.label),
    distances: compressed.map((d) => d.distance),
    counts: compressed.map((d) => d.count),
    ranges: compressed.map((d) => ({ start: d.start, end: d.end, label: d.label })),
    isCompressed: compressed.length < aggregated.length,
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
    return [...dailyData]
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
      .map((d) => ({
        label: new Date(d.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        start: d.date,
        end: d.date,
        distance: d.distance || 0,
        count: d.count || 0,
      }));
  }

  // Aggregate for weekly/monthly views
  const aggregated = {};

  dailyData.forEach((d) => {
    const date = new Date(d.date);
    let key = "";
    let start = "";
    let end = "";

    if (viewType === "weekly") {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      key = formatDate(weekStart);
      start = key;
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      end = formatDate(weekEnd);
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      start = `${key}-01`;
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      end = `${key}-${String(lastDay).padStart(2, "0")}`;
    }

    if (!aggregated[key]) {
      aggregated[key] = { distance: 0, count: 0, start, end };
    }

    aggregated[key].distance += d.distance || 0;
    aggregated[key].count += d.count || 0;
  });

  return Object.entries(aggregated)
    .map(([key, value]) => {
      const label =
        viewType === "weekly"
          ? `Wk ${new Date(key).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : new Date(`${key}-01`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      return {
        label,
        start: value.start,
        end: value.end,
        distance: value.distance,
        count: value.count,
      };
    })
    .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
}

function formatRangeLabel(start, end, viewType) {
  if (!start || !end || start === end) {
    return start || end || "";
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start} - ${end}`;
  }

  if (viewType === "monthly") {
    const startText = startDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    const endText = endDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    return startText === endText ? startText : `${startText} - ${endText}`;
  }

  if (startDate.getMonth() === endDate.getMonth() && startDate.getFullYear() === endDate.getFullYear()) {
    const month = startDate.toLocaleDateString("en-US", { month: "short" });
    return `${month} ${startDate.getDate()}-${endDate.getDate()}`;
  }

  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const startText = startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endText = endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${startText} - ${endText}`;
}

function compressSeriesIfNeeded(series, viewType) {
  const maxPoints = viewType === "daily" ? 72 : viewType === "weekly" ? 60 : 48;
  if (!Array.isArray(series) || series.length <= maxPoints) {
    return series;
  }

  const bucketSize = Math.ceil(series.length / maxPoints);
  const compressed = [];

  for (let index = 0; index < series.length; index += bucketSize) {
    const bucket = series.slice(index, index + bucketSize);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    const distance = bucket.reduce((sum, entry) => sum + (entry.distance || 0), 0);
    const count = bucket.reduce((sum, entry) => sum + (entry.count || 0), 0);

    compressed.push({
      label: formatRangeLabel(first?.start, last?.end, viewType),
      start: first?.start,
      end: last?.end,
      distance,
      count,
    });
  }

  return compressed;
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

function handleTrendsChartClick(_event, activeElements, chart) {
  if (!activeElements || activeElements.length === 0) {
    return;
  }

  const { index } = activeElements[0];
  const ranges = chart?._esBucketRanges;
  const range = Array.isArray(ranges) ? ranges[index] : null;
  if (!range?.start || !range?.end) {
    return;
  }

  loadAndShowTripsForDrilldown("trips", {
    start: range.start,
    end: range.end,
    title: `Trips for ${range.label}`,
  });
}
