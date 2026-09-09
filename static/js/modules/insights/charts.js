/**
 * Insights Charts Module (ES6)
 * Chart initialization and update logic for the driving insights page
 */

import { aggregatePeriods, normalizeDailyDistances } from "./derived-insights.js";
import { formatHourLabel, parseCalendarDate } from "./formatters.js";
import { loadAndShowTripsForDrilldown, loadAndShowTripsForTimeCell } from "./modal.js";
import { getChart, getState, setChart } from "./state.js";

const chartCleanupKey = "_esCleanup";
const HEATMAP_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
let pendingHeatmapResize = false;

function readColorToken(name, fallback) {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  );
}

function withAlpha(color, alpha) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16)
    );
    return `rgba(${channels.join(", ")}, ${alpha})`;
  }
  const channels = color.match(/[\d.]+/g)?.slice(0, 3);
  return channels?.length === 3 ? `rgba(${channels.join(", ")}, ${alpha})` : color;
}

function getAtlasChartPalette() {
  return [
    readColorToken("--cat-cobalt", "#6f8fce"),
    readColorToken("--cat-ochre", "#d4a24a"),
    readColorToken("--cat-steel", "#6290ad"),
    readColorToken("--cat-coral", "#c47050"),
    readColorToken("--cat-slate", "#727a84"),
    readColorToken("--cat-purple", "#8a7ab0"),
  ];
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

/**
 * Initialize all charts
 */
export function initCharts() {
  destroyCharts();
  initTrendsChart();
  initTimeHeatmap();
}

/**
 * Initialize the trends chart (line chart for distance and trips)
 */
function initTrendsChart() {
  const trendsCanvas = document.getElementById("trendsChart");
  const trendsCtx = trendsCanvas?.getContext("2d");
  if (!trendsCtx || typeof Chart === "undefined") {
    return;
  }

  const existingChart = findChartForCanvas(trendsCtx.canvas) || getChart("trends");
  if (existingChart) {
    destroyChartInstance(existingChart);
  }

  const [cobalt, ochre] = getAtlasChartPalette();

  const chart = new Chart(trendsCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Distance",
          data: [],
          borderColor: cobalt,
          backgroundColor: withAlpha(cobalt, 0.12),
          fill: false,
          borderWidth: 3,
          yAxisID: "y",
          pointRadius: 2,
          pointBackgroundColor: cobalt,
          pointHoverRadius: 4,
          tension: 0,
        },
        {
          label: "Trips",
          data: [],
          borderColor: ochre,
          backgroundColor: withAlpha(ochre, 0.12),
          fill: false,
          borderWidth: 3,
          yAxisID: "y1",
          pointRadius: 2,
          pointBackgroundColor: ochre,
          pointHoverRadius: 4,
          tension: 0,
        },
      ],
    },
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
          beginAtZero: true,
          grid: {
            color: "rgba(150, 150, 150, 0.12)",
            borderDash: [4, 4],
          },
          title: {
            display: true,
            text: "Distance (miles)",
          },
        },
        y1: {
          ticks: { precision: 0 },
          type: "linear",
          display: true,
          position: "right",
          beginAtZero: true,
          grid: {
            drawOnChartArea: false,
          },
          title: {
            display: true,
            text: "Trips",
          },
        },
      },
      onClick: handleTrendsChartClick,
    },
  });

  setChart("trends", chart);
}

function initTimeHeatmap() {
  const host = document.getElementById("timeHeatmap");
  if (!host) {
    return;
  }

  const existing = getChart("timeHeatmap");
  if (existing) {
    destroyChartInstance(existing);
  }

  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (pendingHeatmapResize) {
            return;
          }
          pendingHeatmapResize = true;
          requestAnimationFrame(() => {
            pendingHeatmapResize = false;
            updateTimeHeatmap();
          });
        })
      : null;

  resizeObserver?.observe(host);

  setChart("timeHeatmap", {
    destroy() {
      resizeObserver?.disconnect();
      host.replaceChildren();
    },
  });
}

/**
 * Update all charts with current data
 */
export function updateAllCharts() {
  updateTrendsChart();
  updateTimeHeatmap();
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

  const data = processTimeSeriesData(
    analytics.daily_distances,
    state.currentView,
    state.currentRange
  );

  const chart = getChart("trends");
  if (!chart) {
    return;
  }

  chart.data.labels = data.labels;
  chart.data.datasets[0].data = data.distances;
  chart.data.datasets[1].data = data.counts;
  chart.data.datasets[0].tension = 0;
  chart.data.datasets[1].tension = 0;
  chart.data.datasets[0].pointHoverRadius = data.isCompressed ? 3 : 4;
  chart.data.datasets[1].pointHoverRadius = data.isCompressed ? 3 : 4;
  chart._esBucketRanges = data.ranges;
  const note = document.getElementById("trends-resolution-note");
  if (note)
    note.textContent = data.isCompressed
      ? "Long range: each point sums the labeled date interval. Use the table for interval dates and totals."
      : "";

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
    chart.options.animation.duration = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches
      ? 0
      : 350;
  }

  const palette = getAtlasChartPalette();
  const text = readColorToken("--text-secondary", "currentColor");
  chart.data.datasets.forEach((dataset, index) => {
    dataset.borderColor = palette[index];
    dataset.pointBackgroundColor = palette[index];
  });
  for (const axis of Object.values(chart.options.scales)) {
    axis.ticks.color = text;
    if (axis.title) axis.title.color = text;
  }
  chart.options.plugins.legend.labels.color = text;
  chart.options.scales.y.grid.color = readColorToken("--border-color", "currentColor");
  chart.canvas.setAttribute(
    "aria-label",
    `${state.currentView} distance and trips, ${state.currentRange?.start} to ${state.currentRange?.end}. ${data.counts.reduce((sum, count) => sum + count, 0)} trips. Use the data table for individual periods.`
  );
  renderTrendTable(data);
  chart.resize();
  chart.update();
}

function updateTimeHeatmap() {
  const state = getState();
  const { analytics } = state.data;
  const host = document.getElementById("timeHeatmap");
  if (!host || !analytics || !Array.isArray(analytics.time_heatmap)) {
    return;
  }

  const cells = normalizeTimeHeatmap(analytics.time_heatmap);
  const totalTrips = cells.reduce((sum, cell) => sum + cell.count, 0);
  if (totalTrips <= 0) {
    host.innerHTML =
      '<div class="story-empty time-heatmap-empty">Not enough rhythm data in this range yet.</div>';
    return;
  }

  const maxCount = Math.max(...cells.map((cell) => cell.count), 1);
  host.innerHTML = `<table class="insights-heatmap-table"><caption class="visually-hidden">Trip starts in each trip’s local time. Select a cell to view trips.</caption>
    <thead><tr><th scope="col">Day</th>${HEATMAP_HOURS.map((hour) => `<th scope="col">${hour % 3 === 0 ? formatHourLabel(hour) : `<span class="visually-hidden">${formatHourLabel(hour)}</span>`}</th>`).join("")}</tr></thead>
    <tbody>${[1, 2, 3, 4, 5, 6, 0]
      .map(
        (day) =>
          `<tr><th scope="row">${DAY_LABELS[day].slice(0, 3)}</th>${HEATMAP_HOURS.map(
            (hour) => {
              const cell = cells.find((item) => item.day === day && item.hour === hour);
              const label = `${DAY_LABELS[day]} at ${formatHourLabel(hour)}: ${cell.count} trips, ${cell.distance.toFixed(1)} miles`;
              return `<td><button type="button" data-day="${day}" data-hour="${hour}" style="--heat:${cell.count > 0 ? 0.16 + (0.84 * cell.count) / maxCount : 0}" aria-label="${label}" title="${label}" ${cell.count ? "" : "disabled"}>${cell.count || ""}</button></td>`;
            }
          ).join("")}</tr>`
      )
      .join("")}</tbody></table>`;
  host.onclick = (event) => {
    const cell = event.target.closest("button[data-hour]");
    if (cell && !cell.disabled)
      void loadAndShowTripsForTimeCell(
        Number(cell.dataset.day),
        Number(cell.dataset.hour)
      );
  };
}

function renderTrendTable(data) {
  const host = document.getElementById("trends-data");
  if (!host) return;
  host.innerHTML = `<table class="insights-data-table"><caption class="visually-hidden">Distance and trip totals by period</caption><thead><tr><th scope="col">Period</th><th scope="col">Miles</th><th scope="col">Trips</th></tr></thead><tbody>${data.ranges.map((range, index) => `<tr><th scope="row"><button type="button" class="btn btn-ghost" data-start="${range.start}" data-end="${range.end}">${range.start}${range.end !== range.start ? ` – ${range.end}` : ""}</button></th><td>${Number(data.distances[index]).toFixed(1)}</td><td>${data.counts[index]}</td></tr>`).join("")}</tbody></table>`;
  host.onclick = (event) => {
    const button = event.target.closest("button[data-start]");
    if (button)
      void loadAndShowTripsForDrilldown("trips", {
        start: button.dataset.start,
        end: button.dataset.end,
      });
  };
}

// Data Processing Functions

/**
 * Process time series data for the trends chart
 * @param {Array} dailyData - Daily data points
 * @param {string} viewType - View type (daily, weekly, monthly)
 * @returns {Object} Processed data with labels, distances, and counts
 */
function processTimeSeriesData(dailyData, viewType, range) {
  const aggregated = aggregateByView(dailyData, viewType, range);
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
function formatCalendarLabel(value, options) {
  const date = parseCalendarDate(value);
  return date
    ? date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" })
    : String(value || "");
}

export function aggregateByView(dailyData, viewType, range = {}) {
  if (viewType === "daily") {
    return normalizeDailyDistances(dailyData, range).map((day) => ({
      label: formatCalendarLabel(day.date, { month: "short", day: "numeric" }),
      start: day.date,
      end: day.date,
      distance: day.distance,
      count: day.count,
    }));
  }
  return aggregatePeriods(dailyData, viewType, range).map((period) => ({
    label:
      viewType === "weekly"
        ? `Wk ${formatCalendarLabel(period.key, { month: "short", day: "numeric" })}`
        : formatCalendarLabel(`${period.key}-01`, { month: "short", year: "numeric" }),
    start: period.start,
    end: period.end,
    distance: period.distance,
    count: period.trips,
  }));
}

function formatRangeLabel(start, end, viewType) {
  if (!start || !end || start === end) {
    return start || end || "";
  }

  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) {
    return `${start} - ${end}`;
  }

  if (viewType === "monthly") {
    const startText = startDate.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    const endText = endDate.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return startText === endText ? startText : `${startText} - ${endText}`;
  }

  if (
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCFullYear() === endDate.getUTCFullYear()
  ) {
    const month = startDate.toLocaleDateString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    return `${month} ${startDate.getUTCDate()}-${endDate.getUTCDate()}`;
  }

  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
  const startText = startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const endText = endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
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

function normalizeTimeHeatmap(rawCells = []) {
  const byKey = new Map();
  rawCells.forEach((entry) => {
    const day = Number(entry?.day);
    const hour = Number(entry?.hour);
    if (!Number.isInteger(day) || !Number.isInteger(hour)) {
      return;
    }
    if (day < 0 || day > 6 || hour < 0 || hour > 23) {
      return;
    }
    byKey.set(`${day}:${hour}`, {
      count: Number(entry.count || 0),
      distance: Number(entry.distance || 0),
    });
  });

  return [1, 2, 3, 4, 5, 6, 0].flatMap((day) =>
    HEATMAP_HOURS.map((hour) => {
      const value = byKey.get(`${day}:${hour}`) || { count: 0, distance: 0 };
      return {
        day,
        hour,
        hourLabel: formatHourLabel(hour),
        dayName: DAY_LABELS[day],
        count: value.count,
        distance: value.distance,
      };
    })
  );
}
